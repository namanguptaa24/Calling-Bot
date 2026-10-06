import { readFileSync, readdirSync } from 'node:fs';
import type pg from 'pg';

/**
 * sql/*.sql — `public` schema ka derived layer.
 *
 * Sab statements `CREATE OR REPLACE` / `IF NOT EXISTS` hain, isliye inhe
 * baar-baar chalana surakshit hai. Sync ke andar bhi yahi chalti hain,
 * usi transaction mein — kyunki tables dobara banane se views gir jaate hain
 * aur unhe usi commit mein wapas aana chahiye.
 */

const SQL_DIR = new URL('../../../sql/', import.meta.url);

export function migrationFiles(): { name: string; body: string }[] {
  return readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, body: readFileSync(new URL(name, SQL_DIR), 'utf8') }));
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
