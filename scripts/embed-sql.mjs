#!/usr/bin/env node
/**
 * sql/*.sql ko ek TS module mein embed karta hai.
 *
 * Serverless mein bundled function ke paas sql/ folder nahi hota aur
 * import.meta.url wala path tootta hai. Source of truth sql/ hi rehti hai —
 * ye file usse generate hoti hai, haath se edit nahi karni.
 *
 * prebuild mein chalti hai.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const dir = new URL('../sql/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const out = [
  '// AUTO-GENERATED — `npm run embed-sql` se banti hai. Haath se mat badalna.',
  '// Source: sql/*.sql',
  '',
  'export const SQL_FILES: { name: string; body: string }[] = [',
  ...files.map((name) => {
    const body = readFileSync(new URL(name, dir), 'utf8');
    return `  { name: ${JSON.stringify(name)}, body: ${JSON.stringify(body)} },`;
  }),
  '];',
  '',
].join('\n');

writeFileSync(new URL('../apps/agent/src/sql-embedded.ts', import.meta.url), out, 'utf8');
console.log(`embed-sql: ${files.length} files → apps/agent/src/sql-embedded.ts`);
