import cron from 'node-cron';
import { runSync, syncConfigured } from './sync.js';
import { buildBriefing, dataAge } from './briefing.js';
import { placeBriefingCall, vapiConfigured } from './vapi.js';
import { db } from './db.js';

/**
 * Do kaam, dono IST pe:
 *
 *   sync      — har 15 minute. Copy taaza rakhti hai.
 *   briefing  — roz subah Mon-Sat. Call jaati hai.
 *
 * Dono apne aap skip ho jaate hain agar unke credentials na hon. Server
 * phir bhi chalta hai — ye jaan-boojhkar hai, taaki aadha setup bhi
 * deploy ho sake aur baaki baad mein jude.
 */

const TZ = process.env.TZ_NAME ?? 'Asia/Kolkata';
const BRIEFING_CRON = process.env.BRIEFING_CRON ?? '0 10 * * 1-6'; // Mon-Sat 10:00
const SYNC_CRON = process.env.SYNC_CRON ?? '*/15 * * * *';

let syncing = false;

export async function doSync(trigger: string) {
  if (syncing) {
    console.log(`[sync] ${trigger}: pichhla abhi chal raha hai, skip`);
    return;
  }
  syncing = true;
  try {
    const r = await runSync();
    if (!r.ran) {
      console.log(`[sync] ${trigger}: skip — DB_* credentials nahi hain`);
      return;
    }
    console.log(`[sync] ${trigger}: ${r.tables} tables, ${r.rows} rows, ${r.ms}ms`);
  } catch (e: any) {
    // Sync ka fail hona briefing ko jhooth bolne nahi deta — dataAge guard
    // purani copy pe khud mana kar dega. Isliye yahan sirf log, crash nahi.
    console.error(`[sync] ${trigger} FAILED:`, e.message);
  } finally {
    syncing = false;
  }
}

export async function doBriefingCall(trigger: string) {
  try {
    const b = await buildBriefing();

    if (b.stale.days > 7) {
      // Purani copy pe call karne ka matlab hai roz "data purana hai"
      // sunna — wo irritation hai, alert nahi. Log karo, call mat karo.
      console.warn(`[briefing] ${trigger}: SKIP — copy ${b.stale.days} din purani (${b.stale.latest})`);
      await db.query(
        `INSERT INTO public.call_log (caller_number, direction, authorised, auth_failure)
         VALUES ($1, 'outbound', false, $2)`,
        [process.env.BRIEFING_TO ?? null, `stale_data_${b.stale.days}d`],
      ).catch(() => {});
      return;
    }

    if (!vapiConfigured()) {
      console.log(`[briefing] ${trigger}: Vapi set nahi hai — script taiyaar thi (${b.estSeconds}s):`);
      console.log(b.script);
      return;
    }

    const results = await placeBriefingCall(b.script);
    for (const r of results) {
      if (r.placed) console.log(`[briefing] ${trigger}: call ${r.callId} → ${r.to}`);
      else console.error(`[briefing] ${trigger}: FAILED — ${r.reason} ${r.detail ?? ''}`);
    }

    await db.query(
      `INSERT INTO public.call_log (caller_number, direction, authorised, transcript, duration_sec)
       VALUES ($1, 'outbound', true, $2, $3)`,
      [
        results.find((r) => r.placed)?.to ?? null,
        JSON.stringify({ script: b.script, facts: b.facts, polished: b.polished }),
        b.estSeconds,
      ],
    ).catch(() => {});
  } catch (e: any) {
    console.error(`[briefing] ${trigger} FAILED:`, e.message);
  }
}

export function startScheduler() {
  cron.schedule(SYNC_CRON, () => doSync('cron'), { timezone: TZ });
  cron.schedule(BRIEFING_CRON, () => doBriefingCall('cron'), { timezone: TZ });

  console.log(`⏰ scheduler (${TZ})`);
  console.log(`   sync     ${SYNC_CRON}  ${syncConfigured() ? '✅' : '⏸  DB_* nahi hai'}`);
  console.log(`   briefing ${BRIEFING_CRON}  ${vapiConfigured() ? '✅' : '⏸  VAPI_* nahi hai'}`);

  // Boot pe ek sync — deploy ke turant baad copy taaza ho jaaye
  if (syncConfigured()) void doSync('boot');
}

/** Agli briefing kab hai — /health mein dikhane ke liye */
export function nextBriefing(): string {
  return `${BRIEFING_CRON} (${TZ})`;
}

export async function currentDataAge() {
  return dataAge();
}
