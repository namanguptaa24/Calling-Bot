import { rows, row, ymd } from './db.js';
import { polishDescriptions, truncate } from './polish.js';

/**
 * Briefing script generator.
 *
 * Agent call karta hai aur bolta hai. User ko bolna nahi padta.
 *
 * Script yahan SQL se banta hai, LLM se nahi. Iska matlab har number,
 * har naam, har tareekh seedha database se aata hai — bolne wala kuch
 * gadh nahi sakta. Ek briefing jo aatmvishwas ke saath galat bole,
 * wo na hone se bura hai.
 *
 * Sabse badi dikkat lambai hai. 126 overdue tasks poore padhoge to
 * 20 minute ki call ho jaayegi aur aap teesre hafte se uthana band kar
 * doge. Isliye: top N log, har ek ke top 2 tasks, aur kul ginti.
 */

export type BriefingOptions = {
  /** Kitne logon ka zikr — default 5 */
  topPeople?: number;
  /** Har banda ke kitne tasks — default 2 */
  tasksPerPerson?: number;
  /** Itne din se zyada purana hi "chinta ki baat" — default 7 */
  staleDays?: number;
};

export type Briefing = {
  script: string;
  wordCount: number;
  estSeconds: number;
  /** false = LLM polish nahi chala, descriptions truncate hui hain */
  polished: boolean;
  /** copy kitni purani hai — stale data pe briefing rok di jaati hai */
  stale: { latest: string | null; days: number };
  facts: {
    totalOverdue: number;
    peopleWithOverdue: number;
    oldestDays: number | null;
    notLogging: number;
  };
};

const N = (n: number) => String(n);

function days(n: number): string {
  if (n === 1) return '1 din';
  return `${n} din`;
}

/**
 * Copy kitni purani hai.
 *
 * Ye sabse zaroori guard hai. Agar sync ruk jaye aur briefing chalti rahe,
 * to wo poore aatmvishwas ke saath jhooth bolegi — "40 logon ne timesheet
 * nahi bhara" (kyunki data hi nahi aaya), aur overdue ginti roz badhti
 * jaayegi kyunki tasks complete hote hain par copy mein nahi aate.
 *
 * Confident jhooth chup rehne se bura hai. Isliye purana data = saaf batao.
 */
export async function dataAge(): Promise<{ latest: string | null; days: number }> {
  const r = await row<{ latest: Date | null }>(
    `SELECT MAX(entry_date) AS latest FROM source.daily_tasks`,
  );
  if (!r?.latest) return { latest: null, days: 9999 };
  const days = Math.floor((Date.now() - r.latest.getTime()) / 86_400_000);
  // ymd() local components se banta hai — toISOString din peeche khisak deta hai
  return { latest: ymd(r.latest), days };
}

/** Itne din purana data = briefing rok do */
const REFUSE_AFTER_DAYS = 7;
/** Itne din purana = timesheet wali baat chhod do, baaki bol do */
const WARN_AFTER_DAYS = 2;

export async function buildBriefing(opts: BriefingOptions = {}): Promise<Briefing> {
  const topPeople = opts.topPeople ?? 5;
  const perPerson = opts.tasksPerPerson ?? 2;

  const age = await dataAge();
  if (age.days > REFUSE_AFTER_DAYS) {
    const script =
      `Namaste. Aaj ka update nahi de sakti — data ${age.days} din purana hai, ` +
      `aakhri sync ${age.latest ?? 'pata nahi kab'} ka hai. ` +
      `Jo ginti main bolti wo galat hoti. Sync theek karwa lijiye.`;
    return {
      script,
      wordCount: script.split(/\s+/).length,
      estSeconds: Math.round((script.split(/\s+/).length / 140) * 60),
      polished: false,
      stale: age,
      facts: { totalOverdue: 0, peopleWithOverdue: 0, oldestDays: null, notLogging: 0 },
    };
  }

  // ── Har banda, uske overdue tasks, client ke saath ──────────────
  // Yahi wo cheez hai jo poochi gayi thi: kaun → kya → kis client ka → kab se
  const people = await rows(`
    SELECT s.name,
           COUNT(*)::int        AS total,
           MAX(o.days_overdue)::int AS worst
      FROM public.open_task o
      JOIN public.staff s ON s.id = o.assigned_to
     WHERE o.bucket = 'overdue'
     GROUP BY s.name
     ORDER BY worst DESC, total DESC
     LIMIT $1`, [topPeople]);

  const detail = await rows(`
    SELECT o.id, s.name AS person, o.description, o.days_overdue,
           COALESCE(cl.name, 'internal') AS client,
           ROW_NUMBER() OVER (PARTITION BY s.name ORDER BY o.days_overdue DESC) AS rn
      FROM public.open_task o
      JOIN public.staff s ON s.id = o.assigned_to
      LEFT JOIN source.clients cl ON cl.id = o.client_id
     WHERE o.bucket = 'overdue'`);

  // Sirf wahi descriptions polish karo jo sach mein boli jaayengi —
  // 126 bhejne ka koi matlab nahi jab 10 hi script mein aate hain.
  const spoken = detail.filter(
    (d) => people.some((p) => p.name === d.person) && Number(d.rn) <= perPerson,
  );
  const { map: phrases, usedLLM } = await polishDescriptions(
    spoken.map((d) => ({ id: Number(d.id), description: String(d.description ?? '') })),
  );
  const speakable = (d: any) =>
    phrases.get(Number(d.id)) ?? truncate(String(d.description ?? ''));

  const totals = (await row(`
    SELECT COUNT(*)::int AS total,
           COUNT(DISTINCT assigned_to)::int AS people,
           MAX(days_overdue)::int AS oldest
      FROM public.open_task WHERE bucket = 'overdue'`))!;

  const dueToday = (await row<{ n: number }>(`
    SELECT COUNT(*)::int AS n FROM public.open_task WHERE bucket = 'today'`))!.n;

  const notLogging = await rows(`
    SELECT name FROM public.staff_utilisation_7d WHERE hours = 0 ORDER BY name`);

  const approvals = (await row<{ n: number }>(`
    SELECT COUNT(*)::int AS n FROM public.open_task WHERE needs_approval AND bucket <> 'future'`))!.n;

  // ── Script ──────────────────────────────────────────────────────
  const lines: string[] = [];

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' });
  lines.push(`Namaste. Aaj ${dateStr} hai, ye aapka daily update hai.`);

  if (totals.total === 0) {
    lines.push('Koi task overdue nahi hai. Sab time pe chal raha hai.');
  } else {
    lines.push(
      `Kul ${N(totals.total)} tasks overdue hain, ${N(totals.people)} logon ke paas. ` +
      `Sabse purana ${days(totals.oldest)} se atka hai.`,
    );
    lines.push('');

    for (const p of people) {
      const theirs = detail
        .filter((d) => d.person === p.name && Number(d.rn) <= perPerson)
        .sort((a, b) => b.days_overdue - a.days_overdue);

      const head =
        p.total === 1
          ? `${p.name} ke paas 1 task pending hai.`
          : `${p.name} ke paas ${N(p.total)} tasks pending hain.`;

      const items = theirs.map((t) => {
        const what = speakable(t);
        const client = t.client === 'internal' ? 'internal kaam' : `${t.client} ka`;
        return `${client} — ${what} — ${days(t.days_overdue)} se.`;
      });

      lines.push(`${head} ${items.join(' ')}`);
    }
  }

  lines.push('');

  if (dueToday > 0) {
    lines.push(`Aaj ${N(dueToday)} tasks due hain.`);
  }
  if (approvals > 0) {
    lines.push(`${N(approvals)} tasks aapke approval ka intezaar kar rahe hain.`);
  }
  // Stale copy pe "kisi ne timesheet nahi bhara" sabse bada jhooth hota hai —
  // data hi nahi aaya, log kaam kar rahe hain.
  if (notLogging.length > 0 && age.days <= WARN_AFTER_DAYS) {
    const names = notLogging.slice(0, 4).map((n) => n.name).join(', ');
    lines.push(
      notLogging.length <= 4
        ? `${names} ne is hafte timesheet nahi bhara.`
        : `${N(notLogging.length)} logon ne is hafte timesheet nahi bhara — ${names}, aur baaki.`,
    );
  }

  if (age.days > WARN_AFTER_DAYS) {
    lines.push('');
    lines.push(
      `Dhyan rahe — data ${age.days} din purana hai, aakhri sync ${age.latest} ka. ` +
      `Jo tasks is beech complete hue, wo abhi bhi pending dikh rahe hain.`,
    );
  }

  lines.push('');
  lines.push('Bas itna hi. Detail dashboard pe mil jaayegi.');

  const script = lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  const wordCount = script.split(/\s+/).filter(Boolean).length;

  return {
    script,
    wordCount,
    polished: usedLLM,
    stale: age,
    // Hinglish TTS lagbhag 140 shabd/minute bolti hai
    estSeconds: Math.round((wordCount / 140) * 60),
    facts: {
      totalOverdue: totals.total,
      peopleWithOverdue: totals.people,
      oldestDays: totals.oldest,
      notLogging: notLogging.length,
    },
  };
}
