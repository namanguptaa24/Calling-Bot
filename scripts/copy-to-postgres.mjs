#!/usr/bin/env node
/**
 * cPanel MySQL → Railway Postgres — ek baar ki copy.
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  MySQL (source) pe SIRF SELECT chalta hai.                   │
 * │  Kuch bhi likhna/delete karna sirf Postgres COPY mein hota    │
 * │  hai — wahi sandbox hai.                                      │
 * └──────────────────────────────────────────────────────────────┘
 *
 * Copy `source` schema mein jaati hai, taaki apni derived tables
 * `public` mein alag rahein aur re-copy se na udein.
 *
 * Chalao:
 *   npm run copy            # tables pehle se hain to rok dega
 *   npm run copy -- --fresh # source schema ko naye sire se banayega
 */

import mysql from 'mysql2/promise';
import pg from 'pg';
import { readFileSync } from 'node:fs';

// ── .env ─────────────────────────────────────────────────────────
function loadEnv() {
  let raw;
  try {
    raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  } catch {
    console.error('❌ .env nahi mili.');
    process.exit(1);
  }
  for (const line of raw.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const env = (...names) => names.map((n) => process.env[n]).find((v) => v);

const my = {
  host: env('DB_HOST', 'CPANEL_DB_HOST'),
  port: Number(env('DB_PORT', 'CPANEL_DB_PORT') ?? 3306),
  user: env('DB_USER', 'CPANEL_DB_USER'),
  password: env('DB_PASSWORD', 'CPANEL_DB_PASSWORD'),
  database: env('DB_NAME', 'CPANEL_DB_NAME', 'DB_NAMES'),
};
const PG_URL = env('DATABASE_URL', 'POSTGRES_URL');

if (!my.host || !my.database) {
  console.error('❌ .env mein DB_HOST / DB_NAME chahiye.');
  process.exit(1);
}
if (!PG_URL) {
  console.error('❌ .env mein DATABASE_URL chahiye (Railway ka DATABASE_PUBLIC_URL).');
  process.exit(1);
}

const FRESH = process.argv.includes('--fresh');
const SCHEMA = 'source';

// ── Kya copy NAHI karna ──────────────────────────────────────────
// Credentials, OTP hashes — agent ko inki zaroorat kabhi nahi.
const SKIP_TABLES = new Set(['client_credentials', 'login_attempts']);

// Base64 images (longtext) — copy ko sau guna bada kar dete hain, kaam ke nahi.
const SKIP_COLUMNS = {
  users: ['password', 'reset_otp_hash', 'reset_otp_expires', 'reset_otp_attempts', 'profile_image'],
  clients: ['logo_url'],
};

// ── MySQL → Postgres type map ────────────────────────────────────
const TYPE_MAP = {
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
const pgType = (t) => TYPE_MAP[t.toLowerCase()] ?? 'text';

// ── GUARD: MySQL pe sirf SELECT ──────────────────────────────────
async function q(conn, sql, params = []) {
  const head = sql.trim().split(/\s+/)[0].toUpperCase();
  if (head !== 'SELECT' && head !== 'SHOW') {
    console.error(`\n🛑 ROKA GAYA — source DB pe "${head}" query.\n   ${sql.slice(0, 120)}\n`);
    process.exit(1);
  }
  const [rows] = await conn.query(sql, params);
  return rows;
}

const ZERO_DATE = /^0000-00-00/;
const clean = (v) => (typeof v === 'string' && ZERO_DATE.test(v) ? null : v);

async function main() {
  console.log(`🔌 MySQL  → ${my.host}/${my.database}`);
  const src = await mysql.createConnection({
    ...my,
    connectTimeout: 20_000,
    multipleStatements: false,
    dateStrings: true, // '0000-00-00' pe crash na ho
  });
  await src.query('START TRANSACTION READ ONLY');
  console.log('   ✅ read-only\n');

  console.log('🔌 Postgres → Railway');
  const dst = new pg.Client({
    connectionString: PG_URL,
    ssl: { rejectUnauthorized: false },
  });
  await dst.connect();
  console.log('   ✅ connected\n');

  // ── Target schema ──────────────────────────────────────────────
  const { rows: existing } = await dst.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`,
    [SCHEMA],
  );
  if (existing[0].n > 0 && !FRESH) {
    console.error(`❌ Schema "${SCHEMA}" mein pehle se ${existing[0].n} tables hain.`);
    console.error('   Dobara banane ke liye:  npm run copy -- --fresh');
    console.error('   (ye sirf Postgres COPY ko chhuta hai, source MySQL ko nahi)\n');
    process.exit(1);
  }
  if (FRESH) {
    console.log(`🧹 Schema "${SCHEMA}" reset (sirf Postgres copy)\n`);
    await dst.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  }
  await dst.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

  // ── Tables ─────────────────────────────────────────────────────
  const tables = (
    await q(
      src,
      `SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [my.database],
    )
  ).map((r) => r.TABLE_NAME);

  const report = [];

  for (const table of tables) {
    if (SKIP_TABLES.has(table)) {
      console.log(`⏭️  ${table} — skip (sensitive)`);
      report.push({ table, source: '-', copied: 'SKIPPED' });
      continue;
    }

    const allCols = await q(
      src,
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [my.database, table],
    );

    const skip = new Set(SKIP_COLUMNS[table] ?? []);
    const cols = allCols.filter((c) => !skip.has(c.COLUMN_NAME));
    if (cols.length === 0) continue;

    const names = cols.map((c) => c.COLUMN_NAME);

    // Composite primary keys bhi handle karo — kai join tables mein 2 columns hote hain.
    // Agar koi PK column skip hua ho to PK hi mat banao, warna duplicates pe crash hoga.
    const allPk = allCols.filter((c) => c.COLUMN_KEY === 'PRI').map((c) => c.COLUMN_NAME);
    const pkCols = allPk.every((c) => !skip.has(c)) ? allPk : [];
    const orderBy = pkCols.length
      ? ` ORDER BY ${pkCols.map((c) => `\`${c}\``).join(', ')}`
      : '';

    const defs = cols.map((c) => `"${c.COLUMN_NAME}" ${pgType(c.DATA_TYPE)}`);
    if (pkCols.length) {
      defs.push(`PRIMARY KEY (${pkCols.map((c) => `"${c}"`).join(', ')})`);
    }
    await dst.query(`CREATE TABLE ${SCHEMA}."${table}" (${defs.join(', ')})`);

    // MySQL ke indexed columns pe index — snapshot queries tez rahengi
    for (const c of cols.filter((c) => c.COLUMN_KEY === 'MUL')) {
      await dst.query(
        `CREATE INDEX ON ${SCHEMA}."${table}" ("${c.COLUMN_NAME}")`,
      );
    }

    // ── Rows, page by page ───────────────────────────────────────
    const [{ n: total }] = await q(src, `SELECT COUNT(*) AS n FROM \`${table}\``);
    const selectList = names.map((n) => `\`${n}\``).join(', ');
    const PAGE = 2000;
    const maxRows = Math.max(1, Math.floor(60000 / names.length));
    let done = 0;

    for (let offset = 0; offset < total; offset += PAGE) {
      const rows = await q(
        src,
        `SELECT ${selectList} FROM \`${table}\`${orderBy} LIMIT ${PAGE} OFFSET ${offset}`,
      );
      if (rows.length === 0) break;

      for (let i = 0; i < rows.length; i += maxRows) {
        const chunk = rows.slice(i, i + maxRows);
        const values = [];
        const tuples = chunk.map((row) => {
          const ph = names.map((n) => {
            values.push(clean(row[n]));
            return `$${values.length}`;
          });
          return `(${ph.join(',')})`;
        });
        await dst.query(
          `INSERT INTO ${SCHEMA}."${table}" (${names.map((n) => `"${n}"`).join(',')})
           VALUES ${tuples.join(',')}`,
          values,
        );
        done += chunk.length;
      }
    }

    console.log(`📋 ${table.padEnd(28)} ${String(done).padStart(6)} rows ✅`);
    report.push({ table, source: total, copied: done });
  }

  // ── Verify: counts match? ──────────────────────────────────────
  console.log('\n🔍 Verifying...\n');
  let mismatches = 0;
  for (const r of report) {
    if (r.copied === 'SKIPPED') continue;
    const { rows } = await dst.query(`SELECT COUNT(*)::int AS n FROM ${SCHEMA}."${r.table}"`);
    r.inPostgres = rows[0].n;
    if (r.inPostgres !== r.source) {
      r.status = '❌ MISMATCH';
      mismatches++;
    } else {
      r.status = '✅';
    }
  }

  console.log('Table'.padEnd(30) + 'MySQL'.padStart(8) + 'Postgres'.padStart(10) + '  ');
  console.log('─'.repeat(56));
  for (const r of report) {
    if (r.copied === 'SKIPPED') {
      console.log(r.table.padEnd(30) + '-'.padStart(8) + 'skipped'.padStart(10) + '  ⏭️');
    } else {
      console.log(
        r.table.padEnd(30) +
          String(r.source).padStart(8) +
          String(r.inPostgres).padStart(10) +
          '  ' + r.status,
      );
    }
  }

  await src.query('COMMIT');
  await src.end();
  await dst.end();

  const copied = report.filter((r) => r.copied !== 'SKIPPED');
  const totalRows = copied.reduce((s, r) => s + r.source, 0);
  console.log('─'.repeat(56));
  console.log(`\n${mismatches === 0 ? '✅' : '⚠️'} ${copied.length} tables, ${totalRows} rows → ${SCHEMA} schema`);
  if (mismatches > 0) console.log(`   ${mismatches} table(s) ka count match nahi hua — upar dekho.`);
  console.log('\n   Source MySQL ko haath nahi lagaya. Sirf SELECT chale.\n');
}

main().catch((err) => {
  console.error('\n❌', err.message);
  if (err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
    console.error('   Railway ka DATABASE_PUBLIC_URL use kiya? Internal URL laptop se nahi chalta.\n');
  }
  process.exit(1);
});
