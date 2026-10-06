import pg from 'pg';
import 'dotenv/config';

/**
 * Railway Postgres copy. Source cPanel MySQL yahan se pahunch se hi bahar hai —
 * uske credentials process mein load hi nahi hote.
 */
export const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

export async function rows<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(sql, params);
  return res.rows as T[];
}

export async function row<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(sql, params))[0];
}

/** pg `date` columns ko local midnight Date deta hai — toISOString din badal deta hai. */
export function ymd(d: unknown): string | null {
  if (!(d instanceof Date)) return (d as string) ?? null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
