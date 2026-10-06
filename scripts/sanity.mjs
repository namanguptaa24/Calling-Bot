#!/usr/bin/env node
/**
 * Railway Postgres copy pe sanity queries.
 *
 * Sirf SELECT. Ye check karta hai ki copy sach mein usable hai
 * aur data se matlab ke sawaal nikalte hain.
 *
 * Chalao: npm run sanity
 */

import pg from 'pg';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const l of raw.split('\n')) {
  if (/^\s*#/.test(l)) continue;
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const show = async (title, sql) => {
  try {
    const { rows } = await c.query(sql);
    console.log(`\n── ${title} ──`);
    if (rows.length === 0) console.log('(khaali)');
    else console.table(rows);
  } catch (e) {
    console.log(`\n── ${title} ──\n⚠️  ${e.message}`);
  }
};

await show(
  'Team — role breakdown',
  `SELECT role, COUNT(*)::int AS n FROM source.users GROUP BY role ORDER BY n DESC`,
);

await show(
  'Logged hours — last 7 days (top 8)',
  `SELECT u.name, ROUND(SUM(d.duration_min)/60.0, 1) AS hours, COUNT(*)::int AS entries
     FROM source.daily_tasks d
     JOIN source.users u ON u.id = d.user_id
    WHERE d.entry_date >= CURRENT_DATE - 7
    GROUP BY u.name
    ORDER BY hours DESC NULLS LAST
    LIMIT 8`,
);

await show(
  'Delegation tasks — status breakdown',
  `SELECT status, COUNT(*)::int AS n FROM source.delegation_tasks GROUP BY status ORDER BY n DESC`,
);

await show(
  'Checklist tasks — status breakdown',
  `SELECT status, COUNT(*)::int AS n FROM source.checklist_tasks GROUP BY status ORDER BY n DESC`,
);

await show(
  'Top clients by logged hours — last 30 days',
  `SELECT client_name, ROUND(SUM(duration_min)/60.0, 1) AS hours
     FROM source.daily_tasks
    WHERE entry_date >= CURRENT_DATE - 30
    GROUP BY client_name
    ORDER BY hours DESC NULLS LAST
    LIMIT 8`,
);

await show(
  'Active clients with NO work logged in 30 days',
  `SELECT COUNT(*)::int AS stale_clients
     FROM source.clients c
    WHERE c.is_active = 1
      AND NOT EXISTS (
        SELECT 1 FROM source.daily_tasks d
         WHERE d.client_name = c.name AND d.entry_date >= CURRENT_DATE - 30)`,
);

await show(
  'Meetings — next 7 days',
  `SELECT meeting_date, COUNT(*)::int AS n
     FROM source.meetings
    WHERE meeting_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
    GROUP BY meeting_date ORDER BY meeting_date`,
);

await show(
  'Leave — approved, aaj ya aage',
  `SELECT u.name, l.leave_type, l.from_date, l.to_date
     FROM source.leave_requests l
     JOIN source.users u ON u.id = l.user_id
    WHERE l.to_date >= CURRENT_DATE AND lower(l.status::text) LIKE 'approve%'
    ORDER BY l.from_date LIMIT 10`,
);

await c.end();
