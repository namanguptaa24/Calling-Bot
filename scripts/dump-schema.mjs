#!/usr/bin/env node
/**
 * Phase 0 — cPanel MySQL ka schema dump.
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  YEH SCRIPT SIRF PADHTA HAI. KUCH LIKHTA YA DELETE NAHI.     │
 * │                                                              │
 * │  4 guards:                                                   │
 * │   1. Har query SELECT ya SHOW hai — neeche audit kar sakte ho │
 * │   2. Runtime assert: koi aur query chali to crash             │
 * │   3. multipleStatements: false — "; DELETE" smuggle nahi hota │
 * │   4. START TRANSACTION READ ONLY — server khud DML rokta hai  │
 * └──────────────────────────────────────────────────────────────┘
 *
 * Nikaalta hai: table names, column names + types, row counts,
 * aur date columns ka MAX() (freshness check).
 * Kisi bhi row ka content nahi padha jaata.
 *
 * Chalao:  npm run schema
 * Output:  schema-dump.md  (gitignored)
 */

import mysql from 'mysql2/promise';
import { readFileSync, writeFileSync } from 'node:fs';

// ── .env padho (koi dependency nahi) ────────────────────────────
function loadEnv() {
  let raw;
  try {
    raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  } catch {
    console.error('❌ .env nahi mili. Pehle: Copy-Item .env.example .env');
    process.exit(1);
  }
  for (const line of raw.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
}
loadEnv();

// DB_* aur CPANEL_DB_* dono naam chalte hain
const env = (...names) => names.map((n) => process.env[n]).find((v) => v);

const host = env('DB_HOST', 'CPANEL_DB_HOST');
const port = env('DB_PORT', 'CPANEL_DB_PORT') ?? '3306';
const user = env('DB_USER', 'CPANEL_DB_USER');
const password = env('DB_PASSWORD', 'CPANEL_DB_PASSWORD');
const dbNames = env('DB_NAMES', 'DB_NAME', 'CPANEL_DB_NAMES', 'CPANEL_DB_NAME');
const useSsl = env('DB_SSL', 'CPANEL_DB_SSL');

if (!host || !user || !dbNames) {
  console.error('❌ .env mein DB_HOST, DB_USER, DB_NAME chahiye.');
  process.exit(1);
}

const databases = dbNames.split(',').map((s) => s.trim()).filter(Boolean);
const DATE_TYPES = new Set(['date', 'datetime', 'timestamp']);

// ── GUARD 2: har query check hoti hai chalne se pehle ───────────
const executed = [];

async function q(conn, sql, params = []) {
  const head = sql.trim().split(/\s+/)[0].toUpperCase();
  if (head !== 'SELECT' && head !== 'SHOW') {
    console.error(`\n🛑 ROKA GAYA — read-only script mein "${head}" query.`);
    console.error(`   ${sql.trim().slice(0, 120)}\n`);
    process.exit(1);
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE|GRANT)\b/i.test(sql)) {
    console.error(`\n🛑 ROKA GAYA — query mein write keyword mila.\n   ${sql.trim().slice(0, 120)}\n`);
    process.exit(1);
  }
  executed.push(sql.trim().replace(/\s+/g, ' '));
  const [rows] = await conn.query(sql, params);
  return rows;
}

async function main() {
  console.log(`🔌 Connecting to ${host}:${port} as ${user}...`);

  let conn;
  try {
    conn = await mysql.createConnection({
      host,
      port: Number(port),
      user,
      password,
      ssl: useSsl === 'true' ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 15_000,
      multipleStatements: false, // GUARD 3
    });
  } catch (err) {
    console.error(`\n❌ Connect nahi hua: ${err.message}\n`);
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
      console.error('   Sabse common wajah: Remote MySQL access band hai.');
      console.error('   cPanel → Remote MySQL → apna current IP add karo.');
      console.error('   Apna IP: curl ifconfig.me\n');
    } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('   Username/password galat, ya user ko is host se access nahi.');
      console.error('   cPanel usernames prefixed hote hain: lpcliimp_xxx\n');
    }
    process.exit(1);
  }

  // ── GUARD 4: server-side read-only transaction ────────────────
  // Iske andar koi bhi INSERT/UPDATE/DELETE server khud reject karega
  // (MySQL error 1792: Cannot execute statement in a READ ONLY transaction)
  await conn.query('START TRANSACTION READ ONLY');
  console.log('✅ Connected · READ ONLY transaction active\n');

  const out = [];
  out.push('# cPanel MySQL — Schema Dump');
  out.push('');
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push(`Host: \`${host}\` · Databases: ${databases.join(', ')}`);
  out.push('');
  out.push('> Sirf structure + row counts + date ranges. Koi row content nahi.');
  out.push('');

  const summary = [];

  for (const db of databases) {
    console.log(`📂 ${db}`);
    out.push('---');
    out.push('');
    out.push(`## Database: \`${db}\``);
    out.push('');

    let tables;
    try {
      tables = await q(
        conn,
        `SELECT TABLE_NAME, TABLE_ROWS
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME`,
        [db],
      );
    } catch (err) {
      console.log(`   ⚠️  skip: ${err.message}`);
      out.push(`_Padh nahi paaye: ${err.message}_`, '');
      continue;
    }

    if (tables.length === 0) {
      out.push('_Koi table nahi._', '');
      continue;
    }

    for (const t of tables) {
      const table = t.TABLE_NAME;

      let rowCount = '?';
      try {
        const r = await q(conn, `SELECT COUNT(*) AS n FROM \`${db}\`.\`${table}\``);
        rowCount = r[0].n;
      } catch {
        rowCount = `~${t.TABLE_ROWS ?? '?'}`;
      }

      const cols = await q(
        conn,
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_COMMENT
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [db, table],
      );

      // Freshness — sabse recent date, agar koi date column hai
      let freshness = null;
      const dateCols = cols.filter((c) => DATE_TYPES.has(c.DATA_TYPE)).map((c) => c.COLUMN_NAME);
      if (dateCols.length && typeof rowCount === 'number' && rowCount > 0) {
        const picked =
          dateCols.find((c) => /updat|modif/i.test(c)) ??
          dateCols.find((c) => /creat|added|date/i.test(c)) ??
          dateCols[0];
        try {
          const r = await q(conn, `SELECT MAX(\`${picked}\`) AS latest FROM \`${db}\`.\`${table}\``);
          if (r[0].latest) freshness = { column: picked, latest: String(r[0].latest) };
        } catch {
          /* ignore */
        }
      }

      console.log(`   • ${table} (${rowCount} rows)`);
      summary.push({ db, table, rowCount, freshness });

      out.push(`### \`${table}\` — ${rowCount} rows`, '');
      if (freshness) out.push(`**Latest \`${freshness.column}\`:** ${freshness.latest}`, '');
      out.push('| Column | Type | Null | Key | Comment |');
      out.push('|---|---|---|---|---|');
      for (const c of cols) {
        out.push(
          `| \`${c.COLUMN_NAME}\` | ${c.DATA_TYPE} | ${c.IS_NULLABLE} | ${c.COLUMN_KEY || ''} | ${c.COLUMN_COMMENT || ''} |`,
        );
      }
      out.push('');
    }
  }

  // ── Freshness summary — data quality ka sabse seedha signal ───
  out.push('---', '', '## Freshness summary', '');
  out.push('Kaunsi tables actually maintain ho rahi hain vs abandoned hain.', '');
  out.push('| Table | Rows | Latest date |');
  out.push('|---|---|---|');
  for (const s of summary.slice().sort((a, b) => (Number(b.rowCount) || 0) - (Number(a.rowCount) || 0))) {
    out.push(
      `| \`${s.db}.${s.table}\` | ${s.rowCount} | ${s.freshness ? `${s.freshness.latest} (${s.freshness.column})` : '—'} |`,
    );
  }
  out.push('');

  // ── Audit trail: har query jo chali ───────────────────────────
  out.push('---', '', '## Audit — jo queries chalein', '');
  out.push(`Total ${executed.length} queries. Sab SELECT hain.`, '');
  out.push('```sql');
  for (const s of [...new Set(executed.map((s) => s.replace(/`[^`]+`/g, '`…`')))]) {
    out.push(s);
  }
  out.push('```', '');

  await conn.query('COMMIT'); // read-only txn band karo
  await conn.end();

  writeFileSync(new URL('../schema-dump.md', import.meta.url), out.join('\n'), 'utf8');
  console.log(`\n✅ ${summary.length} tables → schema-dump.md`);
  console.log(`   ${executed.length} queries chalein, sab SELECT. Audit file ke end mein hai.`);
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
