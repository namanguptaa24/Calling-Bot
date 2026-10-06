import 'dotenv/config';
import express from 'express';
import { getSnapshot } from './snapshot.js';
import { respond, opening, type Turn } from './agent.js';
import { authoriseCaller, verifyPin } from './auth.js';
import { db, rows } from './db.js';
import { buildBriefing } from './briefing.js';
import { startScheduler, doSync, doBriefingCall, nextBriefing, currentDataAge } from './scheduler.js';
import { syncConfigured } from './sync.js';
import { vapiConfigured } from './vapi.js';

/**
 * Agent HTTP API.
 *
 * Ye jaan-boojhkar telephony-neutral hai. Vapi, Exotel, Plivo, Twilio —
 * sabka payload alag hota hai, aur India mein kaunsa provider milega ye
 * abhi tay nahi hai (PLAN.md §4.4). Isliye core yahan hai aur har provider
 * ke liye ek patla adapter alag se banega.
 *
 * Isse ek aur faayda: ye API terminal, Postman, ya kisi bhi cheez se
 * test ho jaati hai — phone number ka intezaar kiye bina.
 */

const app = express();
app.use(express.json({ limit: '1mb' }));

// Sessions memory mein — ek call ki umr chhoti hoti hai. Agar kabhi
// ek se zyada server instance chale to ye Redis mein jaana chahiye.
type Session = {
  history: Turn[];
  callerName: string;
  callerPhone: string;
  authorised: boolean;
  toolsUsed: string[];
  logId?: number;
  startedAt: number;
};
const sessions = new Map<string, Session>();

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, s] of sessions) if (s.startedAt < cutoff) sessions.delete(id);
}, 10 * 60 * 1000).unref();

// ════════════════════════════════════════════════════════════════
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    const age = await currentDataAge();
    res.json({
      ok: true,
      sessions: sessions.size,
      dataAge: age,
      stale: age.days > 7,
      sync: syncConfigured() ? 'on' : 'no credentials',
      vapi: vapiConfigured() ? 'on' : 'not configured',
      nextBriefing: nextBriefing(),
    });
  } catch (e: any) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// Briefing — jo call pe bola jayega
// ════════════════════════════════════════════════════════════════

/** Preview. Call nahi jaati, sirf script dikhti hai. */
app.get('/briefing', async (_req, res) => {
  const b = await buildBriefing();
  res.type('text/plain').send(
    `${b.script}

---
${b.wordCount} shabd · ~${b.estSeconds}s` +
    `
polished: ${b.polished}` +
    `
data: ${b.stale.latest} (${b.stale.days} din purana)`,
  );
});

/** Abhi call karo. Cron ka intezaar kiye bina test karne ke liye. */
app.post('/briefing/call', async (_req, res) => {
  void doBriefingCall('manual');
  res.json({ triggered: true, note: 'logs dekho' });
});

/** Abhi sync karo. */
app.post('/sync', async (_req, res) => {
  if (!syncConfigured()) {
    return res.status(400).json({ error: 'DB_* credentials nahi hain' });
  }
  void doSync('manual');
  res.json({ triggered: true, note: 'logs dekho' });
});

/** Debugging — agent ko abhi business kaisa dikh raha hai. */
app.get('/snapshot', async (_req, res) => {
  res.json(await getSnapshot(_req.query.force === '1'));
});

// ════════════════════════════════════════════════════════════════
/** Call shuru. Number check hota hai; PIN set ho to pehle wo maanga jaata hai. */
app.post('/call/start', async (req, res) => {
  const { sessionId, phone } = req.body ?? {};
  if (!sessionId || !phone) return res.status(400).json({ error: 'sessionId aur phone chahiye' });

  const auth = await authoriseCaller(phone);

  const log = await rows(
    `INSERT INTO public.call_log (caller_number, caller_name, authorised, auth_failure)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [phone, auth.ok ? auth.caller.name : null, auth.ok, auth.ok ? null : auth.reason],
  );

  if (!auth.ok) {
    return res.status(403).json({
      authorised: false,
      say: 'Maaf kijiye, ye number authorised nahi hai.',
    });
  }

  sessions.set(sessionId, {
    history: [],
    callerName: auth.caller.name,
    callerPhone: phone,
    authorised: !auth.needsPin,
    toolsUsed: [],
    logId: log[0]?.id,
    startedAt: Date.now(),
  });

  if (auth.needsPin) {
    return res.json({ authorised: false, needsPin: true, say: 'Apna PIN boliye.' });
  }

  const first = await opening(auth.caller.name);
  return res.json({ authorised: true, say: first.text, ms: first.ms });
});

/** PIN check. Teen galat koshishon ke baad session khatam. */
app.post('/call/pin', async (req, res) => {
  const { sessionId, pin } = req.body ?? {};
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: 'session nahi mila' });

  if (!(await verifyPin(s.callerPhone, String(pin ?? '')))) {
    return res.status(403).json({ authorised: false, say: 'PIN galat hai. Dobara boliye.' });
  }

  s.authorised = true;
  const first = await opening(s.callerName);
  return res.json({ authorised: true, say: first.text, ms: first.ms });
});

/** Ek turn — user ne jo bola, agent kya bolega. */
app.post('/call/turn', async (req, res) => {
  const { sessionId, text } = req.body ?? {};
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: 'session nahi mila' });
  if (!s.authorised) return res.status(403).json({ error: 'authorised nahi' });
  if (!text) return res.status(400).json({ error: 'text chahiye' });

  try {
    const r = await respond(s.history, String(text), { callerName: s.callerName });
    s.toolsUsed.push(...r.toolsUsed);
    res.json({ say: r.text, ms: r.ms, toolsUsed: r.toolsUsed });
  } catch (e: any) {
    console.error('turn failed:', e.message);
    res.status(500).json({ say: 'Maaf kijiye, kuch gadbad ho gayi. Dobara poochhiye.' });
  }
});

/** Call khatam — transcript aur tools log karo. */
app.post('/call/end', async (req, res) => {
  const { sessionId } = req.body ?? {};
  const s = sessions.get(sessionId);
  if (!s) return res.json({ ok: true });

  if (s.logId) {
    await db.query(
      `UPDATE public.call_log
          SET transcript = $1, tools_used = $2, duration_sec = $3, ended_at = now()
        WHERE id = $4`,
      [
        JSON.stringify(s.history),
        [...new Set(s.toolsUsed)],
        Math.round((Date.now() - s.startedAt) / 1000),
        s.logId,
      ],
    );
  }
  sessions.delete(sessionId);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
const PORT = Number(process.env.PORT ?? 3000);

// Pehli query pe SSL handshake ~2 second leta hai. Call ke beech mein wo
// chuppi bardasht nahi hoti, isliye boot pe hi pool aur snapshot garam kar lo.
async function warmup() {
  const t0 = Date.now();
  await db.query('SELECT 1');
  await getSnapshot(true);
  console.log(`🔥 warm in ${Date.now() - t0}ms`);
}

app.listen(PORT, async () => {
  console.log(`🎧 agent api → http://localhost:${PORT}`);
  await warmup().catch((e) => console.error('warmup failed:', e.message));
  // Snapshot ko taaza rakho taaki call kabhi thandi cache pe na aaye
  setInterval(() => getSnapshot(true).catch(() => {}), 9 * 60 * 1000).unref();
  startScheduler();
});
