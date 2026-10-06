#!/usr/bin/env node
/**
 * Phase 1 se pehle ki khudai — un sawaalon ke jawaab jo design
 * ka rukh badalte hain. Sirf SELECT, sirf Railway copy pe.
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

// ── 1. Client name matching kitna bura hai? ──────────────────────
await show(
  'client_name — kitne match hote hain',
  `WITH names AS (
     SELECT DISTINCT trim(client_name) AS raw FROM source.daily_tasks
      WHERE client_name IS NOT NULL AND trim(client_name) <> ''
   )
   SELECT
     COUNT(*)::int AS distinct_names,
     COUNT(*) FILTER (WHERE EXISTS (
       SELECT 1 FROM source.clients c WHERE c.name = n.raw))::int AS exact_match,
     COUNT(*) FILTER (WHERE NOT EXISTS (
       SELECT 1 FROM source.clients c WHERE c.name = n.raw)
       AND EXISTS (SELECT 1 FROM source.clients c
                    WHERE lower(trim(c.name)) = lower(n.raw)))::int AS case_only,
     COUNT(*) FILTER (WHERE NOT EXISTS (
       SELECT 1 FROM source.clients c WHERE lower(trim(c.name)) = lower(n.raw)))::int AS no_match
   FROM names n`,
);

await show(
  'Jo match NAHI hote — top 15 by hours',
  `SELECT trim(d.client_name) AS raw_name,
          ROUND(SUM(d.duration_min)/60.0, 1) AS hours,
          COUNT(*)::int AS entries
     FROM source.daily_tasks d
    WHERE trim(coalesce(d.client_name,'')) <> ''
      AND NOT EXISTS (SELECT 1 FROM source.clients c
                       WHERE lower(trim(c.name)) = lower(trim(d.client_name)))
    GROUP BY 1 ORDER BY hours DESC NULLS LAST LIMIT 15`,
);

// ── 2. duration_min — outlier kitne hain? ────────────────────────
await show(
  'duration_min — distribution',
  `SELECT
     COUNT(*)::int AS entries,
     MIN(duration_min)::int AS min,
     ROUND(AVG(duration_min))::int AS avg,
     PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_min)::int AS median,
     PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_min)::int AS p95,
     MAX(duration_min)::int AS max,
     COUNT(*) FILTER (WHERE duration_min > 720)::int AS over_12h,
     COUNT(*) FILTER (WHERE duration_min > 1440)::int AS over_24h
   FROM source.daily_tasks`,
);

await show(
  'Ek din mein ek banda — 12 ghante se zyada wale din',
  `SELECT u.name, d.entry_date,
          ROUND(SUM(d.duration_min)/60.0, 1) AS hours,
          COUNT(*)::int AS entries
     FROM source.daily_tasks d JOIN source.users u ON u.id = d.user_id
    GROUP BY u.name, d.entry_date
   HAVING SUM(d.duration_min) > 720
    ORDER BY hours DESC LIMIT 12`,
);

// ── 3. Task tables ka asli semantics ─────────────────────────────
await show(
  'delegation_tasks — approval / waiting flags',
  `SELECT status, approval, waiting_approval, COUNT(*)::int AS n
     FROM source.delegation_tasks GROUP BY 1,2,3 ORDER BY n DESC LIMIT 12`,
);

await show(
  'delegation_tasks — pending, due date ke hisaab se',
  `SELECT
     COUNT(*) FILTER (WHERE due_date < CURRENT_DATE)::int AS overdue,
     COUNT(*) FILTER (WHERE due_date = CURRENT_DATE)::int AS due_today,
     COUNT(*) FILTER (WHERE due_date > CURRENT_DATE)::int AS future,
     COUNT(*) FILTER (WHERE due_date IS NULL)::int AS no_due_date
   FROM source.delegation_tasks WHERE status <> 'completed'`,
);

await show(
  'checklist_tasks — pending, due date ke hisaab se',
  `SELECT
     COUNT(*) FILTER (WHERE due_date < CURRENT_DATE)::int AS overdue,
     COUNT(*) FILTER (WHERE due_date = CURRENT_DATE)::int AS due_today,
     COUNT(*) FILTER (WHERE due_date > CURRENT_DATE)::int AS future,
     COUNT(*) FILTER (WHERE due_date IS NULL)::int AS no_due_date
   FROM source.checklist_tasks WHERE status <> 'completed'`,
);

// ── 4. Staff — kaun asli employee hai ────────────────────────────
await show(
  'users — role vs user_role',
  `SELECT role, user_role, COUNT(*)::int AS n
     FROM source.users GROUP BY 1,2 ORDER BY n DESC`,
);

await show(
  'Timesheet bharne wale — pichhle 30 din',
  `SELECT COUNT(DISTINCT d.user_id)::int AS logged_hours,
          (SELECT COUNT(*)::int FROM source.users WHERE role <> 'client') AS non_client_users
     FROM source.daily_tasks d WHERE d.entry_date >= CURRENT_DATE - 30`,
);

// ── 5. task_activity — blocked duration nikal sakte hain? ────────
await show(
  'task_activity — kaunse fields track hote hain',
  `SELECT field, COUNT(*)::int AS n FROM source.task_activity
    GROUP BY 1 ORDER BY n DESC LIMIT 10`,
);

await c.end();
