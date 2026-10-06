import type pg from 'pg';
import { SQL_FILES } from './sql-embedded.js';

/**
 * sql/*.sql — `public` schema ka derived layer.
 *
 * SQL code mein embed hai (sql-embedded.ts, `npm run embed-sql` se banti hai).
 * Serverless function ke bundle mein sql/ folder nahi hota, isliye filesystem
 * se padhna wahan tootta hai.
 *
 * Sab statements CREATE OR REPLACE / IF NOT EXISTS hain, to baar-baar chalana
 * surakshit hai. Sync ke andar bhi yahi chalti hain, usi transaction mein —
 * tables dobara banane se views gir jaate hain aur unhe usi commit mein
 * wapas aana chahiye.
 */

export function migrationFiles() {
  return SQL_FILES;
}

/** Guard: koi migration source ko modify na kare, na kuch drop kare. */
export function assertSafe(files = migrationFiles()): void {
  for (const f of files) {
    const stripped = f.body.replace(/--[^\n]*/g, '');
    if (/\bDROP\s+(TABLE|SCHEMA|DATABASE|VIEW)\b/i.test(stripped)) {
      throw new Error(`${f.name} mein DROP hai — migration se kuch delete nahi hota`);
    }
    if (/\b(INSERT|UPDATE|DELETE|ALTER|TRUNCATE)\s+[^\n;]*\bsource\./i.test(stripped)) {
      throw new Error(`${f.name} source schema ko modify kar raha hai — wo read-only hai`);
    }
  }
}

/** Maujooda client/transaction par chalao — apna BEGIN nahi karti. */
export async function applyMigrations(client: pg.PoolClient | pg.Client): Promise<string[]> {
  const files = migrationFiles();
  assertSafe(files);
  for (const f of files) await client.query(f.body);
  return files.map((f) => f.name);
}
