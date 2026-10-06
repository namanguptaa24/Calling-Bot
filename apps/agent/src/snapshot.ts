import { rows, row, ymd } from './db.js';

/**
 * Poore business ka state ek object mein.
 *
 * Call shuru hote hi ye system prompt mein chala jaata hai, isliye agent ka
 * pehla jawaab instant hota hai — koi tool call nahi, koi DB wait nahi.
 * Tools sirf drill-down ke liye hain.
 */
export type BusinessSnapshot = {
  generatedAt: string;
  date: string;
  team: {
    headcount: number;
    presentToday: number;
    onLeaveToday: { name: string; leaveType: string }[];
    loggedLast7d: number;
    avgHoursLast7d: number;
    notLogging: { name: string; lastLogged: string | null; daysSince: number | null }[];
    topHours: { name: string; hours: number }[];
  };
  tasks: {
    overdue: number;
    dueToday: number;
    noDueDate: number;
    scheduledFuture: number;
    oldestOverdue: { description: string; assignee: string | null; client: string | null; daysOverdue: number }[];
    overdueByPerson: { name: string; overdue: number; worst: number }[];
    awaitingApproval: { description: string; assignee: string | null; dueDate: string | null }[];
    postponed: { description: string; assignee: string | null; timesPushed: number }[];
  };
  clients: {
    active: number;
    workedLast30d: number;
    neverWorked: number;
    dormant: number;
    stale: { name: string; daysSince: number }[];
    top: { name: string; hours30d: number }[];
  };
  meetings: {
    today: { title: string; time: string; client: string | null; organizer: string | null }[];
    next7Days: number;
  };
  dataQuality: {
    outlierEntries: number;
    unmappedClientEntries: number;
  };
  attentionItems: { severity: 'high' | 'medium' | 'low'; text: string }[];
};

const RANK = { high: 0, medium: 1, low: 2 } as const;

export async function buildSnapshot(): Promise<BusinessSnapshot> {
  const headcount = (await row<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.staff`))!.n;

  const onLeave = await rows(`SELECT name, leave_type FROM public.on_leave_today ORDER BY name`);

  const util = await rows(`
    SELECT name, department, hours, entries, outlier_entries, last_logged
      FROM public.staff_utilisation_7d ORDER BY hours DESC`);

  const notLogging = util
    .filter((u) => Number(u.hours) === 0)
    .map((u) => ({
      name: u.name as string,
      lastLogged: ymd(u.last_logged),
      daysSince: u.last_logged
        ? Math.floor((Date.now() - (u.last_logged as Date).getTime()) / 86_400_000)
        : null,
    }));

  const active = util.filter((u) => Number(u.hours) > 0);
  const avgHours = active.length
    ? +(active.reduce((s, u) => s + Number(u.hours), 0) / active.length).toFixed(1)
    : 0;

  const buckets = (await row(`
    SELECT COUNT(*) FILTER (WHERE bucket='overdue')::int     AS overdue,
           COUNT(*) FILTER (WHERE bucket='today')::int       AS due_today,
           COUNT(*) FILTER (WHERE bucket='no_due_date')::int AS no_due_date,
           COUNT(*) FILTER (WHERE bucket='future')::int      AS future
      FROM public.open_task`))!;

  const oldestOverdue = await rows(`
    SELECT o.description, o.days_overdue, s.name AS assignee, cl.name AS client
      FROM public.open_task o
      LEFT JOIN public.staff s    ON s.id  = o.assigned_to
      LEFT JOIN source.clients cl ON cl.id = o.client_id
     WHERE o.bucket = 'overdue'
     ORDER BY o.days_overdue DESC LIMIT 5`);

  const overdueByPerson = await rows(`
    SELECT s.name, COUNT(*)::int AS overdue, MAX(o.days_overdue)::int AS worst
      FROM public.open_task o JOIN public.staff s ON s.id = o.assigned_to
     WHERE o.bucket = 'overdue'
     GROUP BY s.name ORDER BY overdue DESC LIMIT 6`);

  const awaitingApproval = await rows(`
    SELECT o.description, o.due_date, s.name AS assignee
      FROM public.open_task o LEFT JOIN public.staff s ON s.id = o.assigned_to
     WHERE o.needs_approval ORDER BY o.due_date NULLS LAST LIMIT 5`);

  const postponed = await rows(`
    SELECT p.times_pushed, o.description, s.name AS assignee
      FROM public.task_postponed p
      JOIN public.open_task o ON o.id = p.task_id AND o.kind = 'delegation'
      LEFT JOIN public.staff s ON s.id = o.assigned_to
     ORDER BY p.times_pushed DESC LIMIT 5`);

  const cl = (await row(`
    SELECT COUNT(*) FILTER (WHERE is_active = 1)::int AS active,
           COUNT(*) FILTER (WHERE is_active = 1 AND hours_30d > 0)::int AS worked_30d,
           COUNT(*) FILTER (WHERE is_active = 1 AND last_worked IS NULL)::int AS never_worked
      FROM public.client_coverage`))!;

  const staleClients = await rows(`
    SELECT name, days_since FROM public.client_coverage
     WHERE is_active = 1 AND last_worked IS NOT NULL AND days_since > 30
     ORDER BY days_since DESC LIMIT 8`);

  const topClients = await rows(`
    SELECT name, hours_30d FROM public.client_coverage
     WHERE hours_30d > 0 ORDER BY hours_30d DESC LIMIT 5`);

  const meetingsToday = await rows(`
    SELECT m.title, m.start_time, cl.name AS client, s.name AS organizer
      FROM source.meetings m
      LEFT JOIN source.clients cl ON cl.id = m.client_id
      LEFT JOIN public.staff s    ON s.id  = m.organizer_id
     WHERE m.meeting_date = CURRENT_DATE ORDER BY m.start_time`);

  const meetingsWeek = (await row<{ n: number }>(`
    SELECT COUNT(*)::int AS n FROM source.meetings
     WHERE meeting_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7`))!.n;

  const dq = (await row(`
    SELECT COUNT(*) FILTER (WHERE is_outlier)::int  AS outlier_entries,
           COUNT(*) FILTER (WHERE is_unmapped)::int AS unmapped_entries
      FROM public.daily_task`))!;

  // ── attentionItems: rules se, LLM se nahi ──────────────────────
  // Isliye "aaj kya important hai" har call pe wahi rehta hai.
  const attention: BusinessSnapshot['attentionItems'] = [];

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
    attention.push({
      severity: postponed[0].times_pushed >= 4 ? 'high' : 'low',
      text: `${postponed.length} tasks ki due date baar-baar aage khiski hai — ek to ${postponed[0].times_pushed} baar.`,
    });
  }
  const dormant = cl.active - cl.worked_30d - cl.never_worked;
  if (dormant > 0) {
    attention.push({
      severity: 'medium',
      text: `${dormant} clients pe pehle kaam hota tha par 30 din se nahi ho raha. Sabse purana: ${staleClients[0]?.name}, ${staleClients[0]?.days_since} din.`,
    });
  }
  if (cl.never_worked > 0) {
    attention.push({
      severity: 'low',
      text: `${cl.never_worked} clients "active" mark hain par unpe kabhi koi ghanta log nahi hua — shayad purane records hain.`,
    });
  }
  if (buckets.no_due_date > 0) {
    attention.push({ severity: 'low', text: `${buckets.no_due_date} open tasks ki koi due date hi nahi hai.` });
  }
  if (dq.outlier_entries > 0) {
    attention.push({
      severity: 'low',
      text: `${dq.outlier_entries} timesheet entry 12 ghante se lambi hai — galat lagti hai, utilisation se hata di gayi.`,
    });
  }
  attention.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

  const now = new Date();
  return {
    generatedAt: now.toISOString(),
    date: ymd(now)!,
    team: {
      headcount,
      presentToday: headcount - onLeave.length,
      onLeaveToday: onLeave.map((l) => ({ name: l.name, leaveType: l.leave_type })),
      loggedLast7d: active.length,
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
        description: String(t.description ?? '').slice(0, 120),
        assignee: t.assignee, client: t.client, daysOverdue: t.days_overdue,
      })),
      overdueByPerson,
      awaitingApproval: awaitingApproval.map((t) => ({
        description: String(t.description ?? '').slice(0, 120),
        assignee: t.assignee, dueDate: ymd(t.due_date),
      })),
      postponed: postponed.map((t) => ({
        description: String(t.description ?? '').slice(0, 120),
        assignee: t.assignee, timesPushed: t.times_pushed,
      })),
    },
    clients: {
      active: cl.active,
      workedLast30d: cl.worked_30d,
      neverWorked: cl.never_worked,
      dormant,
      stale: staleClients.map((s) => ({ name: s.name, daysSince: s.days_since })),
      top: topClients.map((t) => ({ name: t.name, hours30d: Number(t.hours_30d) })),
    },
    meetings: {
      today: meetingsToday.map((m) => ({
        title: m.title, time: String(m.start_time), client: m.client, organizer: m.organizer,
      })),
      next7Days: meetingsWeek,
    },
    dataQuality: {
      outlierEntries: dq.outlier_entries,
      unmappedClientEntries: dq.unmapped_entries,
    },
    attentionItems: attention,
  };
}

// ── Cache ────────────────────────────────────────────────────────
// Call pe DB wait bardasht nahi hoti. Snapshot 10 min purana chalega.
let cached: { at: number; snap: BusinessSnapshot } | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function getSnapshot(force = false): Promise<BusinessSnapshot> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.snap;
  const snap = await buildSnapshot();
  cached = { at: Date.now(), snap };
  return snap;
}
