import mysql from 'mysql2/promise';
import { db } from './db.js';
import { applyMigrations } from './migrations.js';

/**
 * cPanel MySQL → Postgres sync, deployed server ke liye.
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  MySQL pe SIRF SELECT. Wahi 4 guard jo scripts/ mein hain:   │
 * │   1. har query SELECT/SHOW se shuru                           │
 * │   2. runtime assert — koi aur query ho to throw               │
 * │   3. multipleStatements: false                                │
 * │   4. START TRANSACTION READ ONLY                              │
 * └──────────────────────────────────────────────────────────────┘
 *
 * Likhna sirf Postgres ki `source` schema mein hota hai.
 *
 * DB_* credentials na hon to sync chup-chaap skip ho jaati hai —
 * server phir bhi chalta hai, bas copy purani rehti hai aur briefing
 * uske liye khud mana kar degi (briefing.ts ka dataAge guard).
 */

const SCHEMA = 'source';

const SKIP_TABLES = new Set(['client_credentials', 'login_attempts']);
const SKIP_COLUMNS: Record<string, string[]> = {
  users: ['password', 'reset_otp_hash', 'reset_otp_expires', 'reset_otp_attempts', 'profile_image'],
  clients: ['logo_url'],
};

const TYPE_MAP: Record<string, string> = {
  tinyint: 'smallint', smallint: 'smallint', mediumint: 'integer',
  int: 'integer', integer: 'integer', bigint: 'bigint',
  decimal: 'numeric', numeric: 'numeric', float: 'real', double: 'double precision',
  bit: 'smallint', year: 'integer',
  char: 'text', varchar: 'text',
  tinytext: 'text', text: 'text', mediumtext: 'text', longtext: 'text',
  enum: 'text', set: 'text',
  date: 'date', datetime: 'timestamp', timestamp: 'timestamp', time: 'time',
  json: 'jsonb',
  binary: 'bytea', varbinary: 'bytea', blob: 'bytea',
  tinyblob: 'bytea', mediumblob: 'bytea', longblob: 'bytea',
};
const pgType = (t: string) => TYPE_MAP[t.toLowerCase()] ?? 'text';

const ZERO_DATE = /^0000-00-00/;
const clean = (v: unknown) => (typeof v === 'string' && ZERO_DATE.test(v) ? null : v);

export type SyncResult =
  | { ran: false; reason: 'no_credentials' }
  | { ran: true; tables: number; rows: number; ms: number };

export function syncConfigured(): boolean {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
}

/** GUARD 1+2 — har query jaanchi jaati hai chalne se pehle */
async function q(conn: mysql.Connection, sql: string, params: unknown[] = []): Promise<any[]> {
  const head = sql.trim().split(/\s+/)[0].toUpperCase();
  if (head !== 'SELECT' && head !== 'SHOW') {
    throw new Error(`sync: "${head}" query roki gayi — source read-only hai`);
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE|GRANT)\b/i.test(sql)) {
    throw new Error('sync: query mein write keyword mila — roki gayi');
  }
  const [r] = await conn.query(sql, params);
  return r as any[];
}

export async function runSync(): Promise<SyncResult> {
  if (!syncConfigured()) return { ran: false, reason: 'no_credentials' };

  const started = Date.now();
  const database = process.env.DB_NAME!;

  const src = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 20_000,
    multipleStatements: false, // GUARD 3
    dateStrings: true,
  });

  try {
    await src.query('START TRANSACTION READ ONLY'); // GUARD 4

    const tables = (
      await q(
        src,
        `SELECT TABLE_NAME FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
        [database],
      )
    ).map((r) => r.TABLE_NAME as string);

    // Poora reload EK transaction mein. Do wajahein:
    //
    //  1. Readers ko aadhi-bhari copy kabhi nahi dikhti — MVCC commit tak
    //     purana data dikhata rehta hai.
    //  2. `source` tables ko dobara banane se `public` ke views CASCADE mein
    //     gir jaate hain. Migrations isi transaction ke andar chalti hain,
    //     to views usi commit mein wapas aa jaate hain. Beech mein koi
    //     aisi ghadi nahi aati jab briefing ko views mile hi na.
    //
    // (Schema rename wala tareeka yahan kaam nahi karta: Postgres views
    //  OID se bandhe hote hain, to wo purane schema ke peeche chale jaate
    //  hain aur uske DROP CASCADE mein mar jaate hain.)
    const pc = await db.connect();
    let tableCount = 0;
    let rowCount = 0;

    try {
      await pc.query('BEGIN');
      await pc.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

        for (const table of tables) {
        if (SKIP_TABLES.has(table)) continue;

        const allCols = await q(
          src,
          `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
          [database, table],
        );
        const skip = new Set(SKIP_COLUMNS[table] ?? []);
        const cols = allCols.filter((c) => !skip.has(c.COLUMN_NAME));
        if (cols.length === 0) continue;

        const names: string[] = cols.map((c) => c.COLUMN_NAME);
        const allPk = allCols.filter((c) => c.COLUMN_KEY === 'PRI').map((c) => c.COLUMN_NAME);
        const pkCols = allPk.every((c: string) => !skip.has(c)) ? allPk : [];
        const orderBy = pkCols.length
          ? ` ORDER BY ${pkCols.map((c: string) => `\`${c}\``).join(', ')}`
          : '';

        const defs = cols.map((c) => `"${c.COLUMN_NAME}" ${pgType(c.DATA_TYPE)}`);
        if (pkCols.length) defs.push(`PRIMARY KEY (${pkCols.map((c: string) => `"${c}"`).join(', ')})`);
        await pc.query(`DROP TABLE IF EXISTS ${SCHEMA}."${table}" CASCADE`);
        await pc.query(`CREATE TABLE ${SCHEMA}."${table}" (${defs.join(', ')})`);

        for (const c of cols.filter((c) => c.COLUMN_KEY === 'MUL')) {
          await pc.query(`CREATE INDEX ON ${SCHEMA}."${table}" ("${c.COLUMN_NAME}")`);
        }

        const [{ n: total }] = await q(src, `SELECT COUNT(*) AS n FROM \`${table}\``);
        const selectList = names.map((n) => `\`${n}\``).join(', ');
        const PAGE = 2000;
        const maxRows = Math.max(1, Math.floor(60000 / names.length));

        for (let offset = 0; offset < total; offset += PAGE) {
          const page = await q(
            src,
            `SELECT ${selectList} FROM \`${table}\`${orderBy} LIMIT ${PAGE} OFFSET ${offset}`,
          );
          if (page.length === 0) break;

          for (let i = 0; i < page.length; i += maxRows) {
            const chunk = page.slice(i, i + maxRows);
            const values: unknown[] = [];
            const tuples = chunk.map((rw) => {
              const ph = names.map((n) => {
                values.push(clean(rw[n]));
                return `$${values.length}`;
              });
              return `(${ph.join(',')})`;
            });
            await pc.query(
              `INSERT INTO ${SCHEMA}."${table}" (${names.map((n) => `"${n}"`).join(',')})
               VALUES ${tuples.join(',')}`,
              values,
            );
            rowCount += chunk.length;
          }
        }
        tableCount++;
      }

      // Views wapas — usi transaction mein, taaki commit ke baad sab saboot rahe
      await applyMigrations(pc);
      await pc.query('COMMIT');
    } catch (e) {
      await pc.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      pc.release();
    }

    await src.query('COMMIT');
    return { ran: true, tables: tableCount, rows: rowCount, ms: Date.now() - started };
  } finally {
    await src.end().catch(() => {});
  }
}
