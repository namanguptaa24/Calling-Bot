#!/usr/bin/env node
/**
 * sql/*.sql ko Railway Postgres pe apply karta hai, naam ke order mein.
 *
 * Sirf `public` schema banata hai. `source` (MySQL ki copy) ko kabhi
 * nahi chhuta — aur koi DROP nahi chalta, guard neeche hai.
 *
 * Chalao: npm run migrate
 */

import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';

const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const l of raw.split('\n')) {
  if (/^\s*#/.test(l)) continue;
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const sqlDir = new URL('../sql/', import.meta.url);
const files = readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort();

if (files.length === 0) {
  console.log('sql/ khaali hai.');
  process.exit(0);
}

// ── Guard: koi migration `source` ko na chhue, na kuch drop kare ──
for (const f of files) {
  const body = readFileSync(new URL(f, sqlDir), 'utf8');
  const stripped = body.replace(/--[^\n]*/g, '');
  if (/\bDROP\s+(TABLE|SCHEMA|DATABASE|VIEW)\b/i.test(stripped)) {
    console.error(`🛑 ${f} mein DROP hai. Migration se kuch delete nahi hota.`);
    process.exit(1);
  }
  if (/\b(INSERT|UPDATE|DELETE|ALTER|TRUNCATE)\s+[^\n;]*\bsource\./i.test(stripped)) {
    console.error(`🛑 ${f} source schema ko modify kar raha hai. Wo read-only hai.`);
    process.exit(1);
  }
}

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

for (const f of files) {
  process.stdout.write(`▶ ${f} ... `);
  const body = readFileSync(new URL(f, sqlDir), 'utf8');
  try {
    await c.query('BEGIN');
    await c.query(body);
    await c.query('COMMIT');
    console.log('✅');
  } catch (e) {
    await c.query('ROLLBACK');
    console.log('❌');
    console.error(`\n${e.message}\n`);
    await c.end();
    process.exit(1);
  }
}

const { rows } = await c.query(
  `SELECT table_name, table_type FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_type, table_name`,
);
console.log(`\npublic schema — ${rows.length} objects:`);
for (const r of rows) {
  console.log(`   ${r.table_type === 'VIEW' ? '👁 ' : '📋'} ${r.table_name}`);
}

await c.end();
