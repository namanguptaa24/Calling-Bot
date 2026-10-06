#!/usr/bin/env node
/**
 * BusinessSnapshot builder — Phase 1 ka core.
 *
 * Poore business ka state ek JSON mein. Call shuru hote hi ye seedha
 * agent ke system prompt mein chala jaata hai, isliye pehla jawaab
 * instant hota hai — koi tool call nahi, koi DB wait nahi.
 *
 * `attentionItems` ko CODE rank karta hai, LLM nahi. Isliye "aaj kya
 * important hai" har call pe wahi rehta hai, mood ke hisaab se nahi badalta.
 *
 * Chalao: npm run snapshot          # readable + preview
 *         npm run snapshot -- --json # sirf JSON (pipe karne ke liye)
 */

import pg from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';

const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const l of raw.split('\n')) {
  if (/^\s*#/.test(l)) continue;
  const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const JSON_ONLY = process.argv.includes('--json');
const log = (...a) => { if (!JSON_ONLY) console.log(...a); };

// pg date columns ko JS Date deta hai — toISOString UTC mein kheench
// leta hai, isliye local components se banao warna din badal jaata hai.
const ymd = (d) =>
  d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : d;

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const one = async (sql, p) => (await c.query(sql, p)).rows[0];
const all = async (sql, p) => (await c.query(sql, p)).rows;

// ════════════════════════════════════════════════════════════════
// Team
// ════════════════════════════════════════════════════════════════
const headcount = (await one(`SELECT COUNT(*)::int AS n FROM public.staff`)).n;
const onLeave = await all(`SELECT name, leave_type FROM public.on_leave_today ORDER BY name`);

const util = await all(
  `SELECT name, department, hours, entries, outlier_entries, last_logged
     FROM public.staff_utilisation_7d ORDER BY hours DESC`,
);
const notLogging = util
  .filter((u) => Number(u.hours) === 0)
  .map((u) => ({
    name: u.name,
    lastLogged: ymd(u.last_logged),
    daysSince: u.last_logged
      ? Math.floor((Date.now() - u.last_logged.getTime()) / 86400000)
      : null,
  }));

const activeLoggers = util.filter((u) => Number(u.hours) > 0);
const avgHours = activeLoggers.length
  ? +(activeLoggers.reduce((s, u) => s + Number(u.hours), 0) / activeLoggers.length).toFixed(1)
  : 0;

// ════════════════════════════════════════════════════════════════
// Tasks
// ════════════════════════════════════════════════════════════════
const buckets = await one(`
  SELECT COUNT(*) FILTER (WHERE bucket='overdue')::int     AS overdue,
         COUNT(*) FILTER (WHERE bucket='today')::int       AS due_today,
         COUNT(*) FILTER (WHERE bucket='no_due_date')::int AS no_due_date,
         COUNT(*) FILTER (WHERE bucket='future')::int      AS future
    FROM public.open_task`);

const oldestOverdue = await all(`
  SELECT o.kind, o.description, o.days_overdue, o.priority,
         s.name AS assignee, cl.name AS client
    FROM public.open_task o
    LEFT JOIN public.staff s   ON s.id  = o.assigned_to
    LEFT JOIN source.clients cl ON cl.id = o.client_id
   WHERE o.bucket = 'overdue'
   ORDER BY o.days_overdue DESC LIMIT 5`);

const overdueByPerson = await all(`
  SELECT s.name, COUNT(*)::int AS overdue, MAX(o.days_overdue)::int AS worst
    FROM public.open_task o JOIN public.staff s ON s.id = o.assigned_to
   WHERE o.bucket = 'overdue'
   GROUP BY s.name ORDER BY overdue DESC LIMIT 6`);

const awaitingApproval = await all(`
  SELECT o.description, s.name AS assignee, o.due_date, o.bucket
    FROM public.open_task o LEFT JOIN public.staff s ON s.id = o.assigned_to
   WHERE o.needs_approval ORDER BY o.due_date NULLS LAST LIMIT 5`);

const postponed = await all(`
  SELECT p.times_pushed, o.description, o.bucket, o.due_date, s.name AS assignee
    FROM public.task_postponed p
    JOIN public.open_task o ON o.id = p.task_id AND o.kind = 'delegation'
    LEFT JOIN public.staff s ON s.id = o.assigned_to
   WHERE p.task_type IN ('delegation','delegation_tasks')
   ORDER BY p.times_pushed DESC LIMIT 5`);

// ════════════════════════════════════════════════════════════════
// Clients
// ════════════════════════════════════════════════════════════════
const clientStats = await one(`
  SELECT COUNT(*) FILTER (WHERE is_active = 1)::int AS active,
         COUNT(*) FILTER (WHERE is_active = 1 AND hours_30d > 0)::int AS worked_30d,
         COUNT(*) FILTER (WHERE is_active = 1 AND last_worked IS NULL)::int AS never_worked
    FROM public.client_coverage`);

const staleClients = await all(`
  SELECT name, days_since, last_worked FROM public.client_coverage
   WHERE is_active = 1 AND last_worked IS NOT NULL AND days_since > 30
   ORDER BY days_since DESC LIMIT 8`);

const topClients = await all(`
  SELECT name, hours_30d FROM public.client_coverage
   WHERE hours_30d > 0 ORDER BY hours_30d DESC LIMIT 5`);

// ════════════════════════════════════════════════════════════════
// Meetings
// ════════════════════════════════════════════════════════════════
const meetingsToday = await all(`
  SELECT m.title, m.start_time, cl.name AS client, s.name AS organizer
    FROM source.meetings m
    LEFT JOIN source.clients cl ON cl.id = m.client_id
    LEFT JOIN public.staff s    ON s.id  = m.organizer_id
   WHERE m.meeting_date = CURRENT_DATE
   ORDER BY m.start_time`);

const meetingsWeek = (await one(`
  SELECT COUNT(*)::int AS n FROM source.meetings
   WHERE meeting_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7`)).n;

// ════════════════════════════════════════════════════════════════
// Data quality — agent ko pata hona chahiye ki kya bharose ka nahi
// ════════════════════════════════════════════════════════════════
const dq = await one(`
  SELECT COUNT(*) FILTER (WHERE is_outlier)::int  AS outlier_entries,
         COUNT(*) FILTER (WHERE is_unmapped)::int AS unmapped_entries
    FROM public.daily_task`);

// ════════════════════════════════════════════════════════════════
// attentionItems — RULES se, LLM se nahi
// ════════════════════════════════════════════════════════════════
const attention = [];

if (buckets.overdue > 0) {
  const worst = oldestOverdue[0];
  attention.push({
    severity: worst?.days_overdue > 14 ? 'high' : 'medium',
    text: `${buckets.overdue} tasks overdue hain${
      worst ? `, sabse purana ${worst.days_overdue} din se — ${worst.assignee ?? 'kisi'} ke paas` : ''
    }.`,
  });
}
if (notLogging.length > 0) {
  attention.push({
    severity: notLogging.length >= 5 ? 'high' : 'medium',
    text: `${notLogging.length} logon ne pichhle 7 din mein timesheet nahi bhara: ${notLogging
      .slice(0, 4).map((n) => n.name).join(', ')}${notLogging.length > 4 ? ' aur baaki' : ''}.`,
  });
}
if (awaitingApproval.length > 0) {
  attention.push({
    severity: 'medium',
    text: `${awaitingApproval.length} tasks approval ka intezaar kar rahe hain.`,
  });
}
if (postponed.length > 0) {
  const p = postponed[0];
  attention.push({
    severity: p.times_pushed >= 4 ? 'high' : 'low',
    text: `${postponed.length} tasks ki due date baar-baar aage khiski hai — ek to ${p.times_pushed} baar.`,
  });
}
// Do bilkul alag cheezein hain, inhe jodna galat picture deta hai:
//   - dormant  = pehle kaam hota tha, ab ruk gaya  → asli business signal
//   - never    = kabhi kaam log hi nahi hua        → purana/galat record
const dormant = clientStats.active - clientStats.worked_30d - clientStats.never_worked;
if (dormant > 0) {
  attention.push({
    severity: 'medium',
    text: `${dormant} clients pe pehle kaam hota tha par 30 din se nahi ho raha. Sabse purana: ${staleClients[0].name}, ${staleClients[0].days_since} din.`,
  });
}
if (clientStats.never_worked > 0) {
  attention.push({
    severity: 'low',
    text: `${clientStats.never_worked} clients "active" mark hain par unpe kabhi koi ghanta log nahi hua — shayad purane records hain.`,
  });
}
if (buckets.no_due_date > 0) {
  attention.push({
    severity: 'low',
    text: `${buckets.no_due_date} open tasks ki koi due date hi nahi hai.`,
  });
}
if (dq.outlier_entries > 0) {
  attention.push({
    severity: 'low',
    text: `${dq.outlier_entries} timesheet entry 12 ghante se lambi hai — galat lagti hai, utilisation se hata di gayi.`,
  });
}

const RANK = { high: 0, medium: 1, low: 2 };
attention.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

// ════════════════════════════════════════════════════════════════
const snapshot = {
  generatedAt: new Date().toISOString(),
  date: ymd(new Date()),
  team: {
    headcount,
    onLeaveToday: onLeave,
    presentToday: headcount - onLeave.length,
    loggedLast7d: activeLoggers.length,
    avgHoursLast7d: avgHours,
    notLogging,
    topHours: util.slice(0, 6).map((u) => ({ name: u.name, hours: Number(u.hours) })),
  },
  tasks: {
    overdue: buckets.overdue,
    dueToday: buckets.due_today,
    noDueDate: buckets.no_due_date,
    scheduledFuture: buckets.future,
    oldestOverdue: oldestOverdue.map((t) => ({
      description: t.description?.slice(0, 120),
      assignee: t.assignee,
      client: t.client,
      daysOverdue: t.days_overdue,
    })),
    overdueByPerson,
    awaitingApproval: awaitingApproval.map((t) => ({
      description: t.description?.slice(0, 120),
      assignee: t.assignee,
      dueDate: ymd(t.due_date),
    })),
    postponed: postponed.map((t) => ({
      description: t.description?.slice(0, 120),
      assignee: t.assignee,
      timesPushed: t.times_pushed,
    })),
  },
  clients: {
    active: clientStats.active,
    workedLast30d: clientStats.worked_30d,
    neverWorked: clientStats.never_worked,
    stale: staleClients.map((s) => ({ name: s.name, daysSince: s.days_since })),
    top: topClients.map((t) => ({ name: t.name, hours30d: Number(t.hours_30d) })),
  },
  meetings: {
    today: meetingsToday.map((m) => ({
      title: m.title, time: m.start_time, client: m.client, organizer: m.organizer,
    })),
    next7Days: meetingsWeek,
  },
  dataQuality: {
    outlierEntries: dq.outlier_entries,
    unmappedClientEntries: dq.unmapped_entries,
  },
  attentionItems: attention,
};

await c.end();

writeFileSync(new URL('../snapshot.json', import.meta.url), JSON.stringify(snapshot, null, 2));

if (JSON_ONLY) {
  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(0);
}

// ── Readable output ──────────────────────────────────────────────
const size = JSON.stringify(snapshot).length;
log(`\n📸 Snapshot — ${snapshot.date}   (${(size / 1024).toFixed(1)} KB)\n`);

log(`TEAM      ${snapshot.team.presentToday}/${headcount} present` +
    (onLeave.length ? ` · chhutti: ${onLeave.map((l) => l.name).join(', ')}` : '') +
    `\n          ${snapshot.team.loggedLast7d} ne 7 din mein log kiya · avg ${avgHours}h`);
log(`TASKS     ${buckets.overdue} overdue · ${buckets.due_today} aaj due · ${buckets.no_due_date} bina due date` +
    `\n          ${buckets.future} future scheduled (ye overdue NAHI hain)`);
log(`CLIENTS   ${clientStats.active} active · ${clientStats.worked_30d} pe 30 din mein kaam hua · ${clientStats.never_worked} pe kabhi nahi`);
log(`MEETINGS  ${meetingsToday.length} aaj · ${meetingsWeek} agle 7 din mein`);

log(`\n⚠️  ATTENTION (code ne rank kiya, LLM ne nahi)\n`);
for (const a of attention) {
  const icon = { high: '🔴', medium: '🟡', low: '⚪' }[a.severity];
  log(`   ${icon} ${a.text}`);
}

// ── Agent call pe kya bolega ─────────────────────────────────────
const top = attention.slice(0, 3);
log(`\n📞 Call pe agent ka opening (draft):\n`);
log(`   "${top.length} cheezein dhyan dene layak hain. ` +
    top.map((a) => a.text).join(' ') +
    ` Kuch aur detail chahiye?"`);
log(`\n   → snapshot.json mein poora data hai\n`);
