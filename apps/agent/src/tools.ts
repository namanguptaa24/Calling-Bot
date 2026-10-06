import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { rows, row, ymd } from './db.js';

/**
 * Agent ke tools — sirf 7. Zyada tools LLM ko confuse karte hain aur
 * har extra tool latency badhata hai.
 *
 * 6 read-only hain, ek (`create_note`) likhta hai — aur wo bhi sirf
 * `public.agent_note` mein. Source MySQL is process se pahunch ke bahar hai.
 *
 * Naam aksar adhoore aayenge ("Pradhuman" not "Pradhuman Kumar") kyunki
 * bolte waqt log poora naam nahi lete — isliye har lookup ILIKE hai,
 * aur ek se zyada match hone pe list wapas jaati hai, andaaza nahi.
 */

const short = (s: unknown, n = 100) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

// ════════════════════════════════════════════════════════════════
export const getPerson = betaZodTool({
  name: 'get_person',
  description:
    'Ek team member ki puri picture: kitne ghante log kiye, kaunse tasks open hain, ' +
    'kitne overdue, chhutti pe hai ya nahi. Aadha naam bhi chalega.',
  inputSchema: z.object({
    name: z.string().describe('Person ka naam ya uska hissa, jaise "Pradhuman" ya "Sneha"'),
  }),
  run: async ({ name }) => {
    const matches = await rows(
      `SELECT id, name, department, role FROM public.staff WHERE name ILIKE $1 ORDER BY name LIMIT 6`,
      [`%${name}%`],
    );
    if (matches.length === 0) return JSON.stringify({ found: false, searched: name });
    if (matches.length > 1)
      return JSON.stringify({ ambiguous: true, matches: matches.map((m) => m.name) });

    const p = matches[0];
    const [hours, tasks, leave] = await Promise.all([
      row(`SELECT hours, entries, last_logged FROM public.staff_utilisation_7d WHERE user_id = $1`, [p.id]),
      rows(
        `SELECT o.kind, o.description, o.bucket, o.days_overdue, o.due_date, o.priority,
                o.needs_approval, cl.name AS client
           FROM public.open_task o LEFT JOIN source.clients cl ON cl.id = o.client_id
          WHERE o.assigned_to = $1 AND o.bucket <> 'future'
          ORDER BY o.days_overdue DESC NULLS LAST LIMIT 15`,
        [p.id],
      ),
      row(`SELECT leave_type, from_date, to_date FROM public.on_leave_today WHERE user_id = $1`, [p.id]),
    ]);

    return JSON.stringify({
      name: p.name,
      department: p.department,
      hoursLast7d: Number(hours?.hours ?? 0),
      lastLogged: ymd(hours?.last_logged),
      onLeaveToday: leave ? { type: leave.leave_type, until: ymd(leave.to_date) } : null,
      openTasks: {
        overdue: tasks.filter((t) => t.bucket === 'overdue').length,
        dueToday: tasks.filter((t) => t.bucket === 'today').length,
        noDueDate: tasks.filter((t) => t.bucket === 'no_due_date').length,
      },
      tasks: tasks.map((t) => ({
        what: short(t.description),
        client: t.client,
        status: t.bucket,
        daysOverdue: t.days_overdue,
        needsApproval: t.needs_approval,
      })),
    });
  },
});

// ════════════════════════════════════════════════════════════════
export const getClient = betaZodTool({
  name: 'get_client',
  description:
    'Ek client ka status: kitne ghante lage, kaun handle karta hai, kaunse tasks ' +
    'open hain, aakhri baar kab kaam hua, aage koi meeting hai kya.',
  inputSchema: z.object({
    name: z.string().describe('Client ka naam ya uska hissa'),
  }),
  run: async ({ name }) => {
    const matches = await rows(
      `SELECT id, name, is_active FROM source.clients WHERE name ILIKE $1 ORDER BY name LIMIT 6`,
      [`%${name}%`],
    );
    if (matches.length === 0) return JSON.stringify({ found: false, searched: name });
    if (matches.length > 1)
      return JSON.stringify({ ambiguous: true, matches: matches.map((m) => m.name) });

    const c = matches[0];
    const [cov, tasks, meetings, handler] = await Promise.all([
      row(`SELECT last_worked, days_since, hours_30d FROM public.client_coverage WHERE client_id = $1`, [c.id]),
      rows(
        `SELECT o.description, o.bucket, o.days_overdue, s.name AS assignee
           FROM public.open_task o LEFT JOIN public.staff s ON s.id = o.assigned_to
          WHERE o.client_id = $1 AND o.bucket <> 'future'
          ORDER BY o.days_overdue DESC NULLS LAST LIMIT 10`,
        [c.id],
      ),
      rows(
        `SELECT title, meeting_date, start_time FROM source.meetings
          WHERE client_id = $1 AND meeting_date >= CURRENT_DATE
          ORDER BY meeting_date LIMIT 3`,
        [c.id],
      ),
      row(`SELECT s.name FROM source.clients c JOIN public.staff s ON s.id = c.handler_id WHERE c.id = $1`, [c.id]),
    ]);

    return JSON.stringify({
      name: c.name,
      isActive: c.is_active === 1,
      handler: handler?.name ?? null,
      hoursLast30d: Number(cov?.hours_30d ?? 0),
      lastWorked: ymd(cov?.last_worked),
      daysSinceWork: cov?.days_since ?? null,
      openTasks: tasks.map((t) => ({
        what: short(t.description), assignee: t.assignee,
        status: t.bucket, daysOverdue: t.days_overdue,
      })),
      upcomingMeetings: meetings.map((m) => ({
        title: m.title, date: ymd(m.meeting_date), time: String(m.start_time),
      })),
    });
  },
});

// ════════════════════════════════════════════════════════════════
export const getOverdueTasks = betaZodTool({
  name: 'get_overdue_tasks',
  description:
    'Overdue tasks ki list, sabse purane pehle. Kisi ek banda ya client pe filter kar sakte ho.',
  inputSchema: z.object({
    assignee: z.string().optional().describe('Sirf is banda ke tasks'),
    client: z.string().optional().describe('Sirf is client ke tasks'),
    limit: z.number().int().min(1).max(25).optional().describe('Default 10'),
  }),
  run: async ({ assignee, client, limit }) => {
    const res = await rows(
      `SELECT o.description, o.days_overdue, o.priority, o.kind,
              s.name AS assignee, cl.name AS client
         FROM public.open_task o
         LEFT JOIN public.staff s    ON s.id  = o.assigned_to
         LEFT JOIN source.clients cl ON cl.id = o.client_id
        WHERE o.bucket = 'overdue'
          AND ($1::text IS NULL OR s.name  ILIKE '%'||$1||'%')
          AND ($2::text IS NULL OR cl.name ILIKE '%'||$2||'%')
        ORDER BY o.days_overdue DESC LIMIT $3`,
      [assignee ?? null, client ?? null, limit ?? 10],
    );
    return JSON.stringify({
      count: res.length,
      tasks: res.map((t) => ({
        what: short(t.description), assignee: t.assignee,
        client: t.client, daysOverdue: t.days_overdue, priority: t.priority,
      })),
    });
  },
});

// ════════════════════════════════════════════════════════════════
export const getTeamHours = betaZodTool({
  name: 'get_team_hours',
  description:
    'Team ne kitne ghante log kiye — har banda alag se. Kis client pe kitna gaya wo bhi.',
  inputSchema: z.object({
    days: z.number().int().min(1).max(90).optional().describe('Kitne din peeche, default 7'),
    byClient: z.boolean().optional().describe('true = client ke hisaab se, na ki banda ke hisaab se'),
  }),
  run: async ({ days, byClient }) => {
    const d = days ?? 7;
    if (byClient) {
      const res = await rows(
        `SELECT cl.name, ROUND(SUM(dt.duration_min)/60.0, 1) AS hours
           FROM public.daily_task dt JOIN source.clients cl ON cl.id = dt.client_id
          WHERE dt.entry_date >= CURRENT_DATE - $1::int AND NOT dt.is_outlier
          GROUP BY cl.name ORDER BY hours DESC LIMIT 15`,
        [d],
      );
      return JSON.stringify({ days: d, byClient: res.map((r) => ({ client: r.name, hours: Number(r.hours) })) });
    }
    const res = await rows(
      `SELECT s.name, s.department, ROUND(SUM(dt.duration_min)/60.0, 1) AS hours,
              COUNT(dt.id)::int AS entries
         FROM public.staff s
         LEFT JOIN public.daily_task dt
           ON dt.user_id = s.id AND dt.entry_date >= CURRENT_DATE - $1::int AND NOT dt.is_outlier
        GROUP BY s.name, s.department ORDER BY hours DESC NULLS LAST`,
      [d],
    );
    return JSON.stringify({
      days: d,
      people: res.map((r) => ({
        name: r.name, department: r.department,
        hours: Number(r.hours ?? 0), entries: r.entries,
      })),
    });
  },
});

// ════════════════════════════════════════════════════════════════
export const searchTasks = betaZodTool({
  name: 'search_tasks',
  description:
    'Task descriptions mein text dhoondo. Tab use karo jab koi kisi kaam ka zikr kare ' +
    'par wo kis banda ya client ka hai ye na pata ho.',
  inputSchema: z.object({
    query: z.string().describe('Dhoondhne wala text'),
    includeCompleted: z.boolean().optional().describe('Default false — sirf open tasks'),
  }),
  run: async ({ query, includeCompleted }) => {
    if (includeCompleted) {
      const res = await rows(
        `SELECT description, status::text AS status, due_date, assigned_to
           FROM source.delegation_tasks WHERE description ILIKE $1
          ORDER BY created_at DESC LIMIT 12`,
        [`%${query}%`],
      );
      return JSON.stringify({
        count: res.length,
        tasks: res.map((t) => ({ what: short(t.description), status: t.status, due: ymd(t.due_date) })),
      });
    }
    const res = await rows(
      `SELECT o.description, o.bucket, o.days_overdue, s.name AS assignee, cl.name AS client
         FROM public.open_task o
         LEFT JOIN public.staff s    ON s.id  = o.assigned_to
         LEFT JOIN source.clients cl ON cl.id = o.client_id
        WHERE o.description ILIKE $1 ORDER BY o.days_overdue DESC NULLS LAST LIMIT 12`,
      [`%${query}%`],
    );
    return JSON.stringify({
      count: res.length,
      tasks: res.map((t) => ({
        what: short(t.description), assignee: t.assignee,
        client: t.client, status: t.bucket, daysOverdue: t.days_overdue,
      })),
    });
  },
});

// ════════════════════════════════════════════════════════════════
export const getRecentActivity = betaZodTool({
  name: 'get_recent_activity',
  description:
    'Pichhle kuch dinon mein tasks pe kya hua — status badle, due dates khiskin, kaam kisi aur ko gaya.',
  inputSchema: z.object({
    days: z.number().int().min(1).max(30).optional().describe('Default 3'),
    person: z.string().optional().describe('Sirf is banda ne jo badla'),
  }),
  run: async ({ days, person }) => {
    const res = await rows(
      `SELECT a.field, a.old_value, a.new_value, a.old_status, a.new_status,
              a.created_at, s.name AS changed_by
         FROM source.task_activity a
         LEFT JOIN public.staff s ON s.id = a.changed_by
        WHERE a.created_at >= CURRENT_DATE - $1::int
          AND ($2::text IS NULL OR s.name ILIKE '%'||$2||'%')
        ORDER BY a.created_at DESC LIMIT 25`,
      [days ?? 3, person ?? null],
    );
    return JSON.stringify({
      count: res.length,
      changes: res.map((a) => ({
        field: a.field,
        from: a.old_status ?? a.old_value,
        to: a.new_status ?? a.new_value,
        by: a.changed_by,
        at: (a.created_at as Date)?.toISOString(),
      })),
    });
  },
});

// ════════════════════════════════════════════════════════════════
export const createNote = betaZodTool({
  name: 'create_note',
  description:
    'Call ke dauran koi baat ya reminder record karo. Tab use karo jab user kahe ' +
    '"yaad rakhna", "note kar lo", "X ko bolna". Ye humari apni table mein jaata hai — ' +
    'original system mein kuch nahi badalta.',
  inputSchema: z.object({
    text: z.string().describe('Kya yaad rakhna hai'),
    about: z.string().optional().describe('Kis banda ya client ke baare mein'),
  }),
  run: async ({ text, about }) => {
    const r = await row(
      `INSERT INTO public.agent_note (text, about, source) VALUES ($1, $2, 'call')
       RETURNING id, created_at`,
      [text, about ?? null],
    );
    return JSON.stringify({ saved: true, id: r?.id, note: text, about: about ?? null });
  },
});

export const allTools = [
  getPerson, getClient, getOverdueTasks, getTeamHours,
  searchTasks, getRecentActivity, createNote,
];
