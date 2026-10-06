import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronAuthorised } from '../_auth.js';
import { buildBriefing } from '../../apps/agent/src/briefing.js';
import { placeBriefingCall, vapiConfigured } from '../../apps/agent/src/vapi.js';
import { db } from '../../apps/agent/src/db.js';

// Script banane mein OpenAI call hai + Postgres queries. 60s kaafi hai.
export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!cronAuthorised(req, res)) return;

  const b = await buildBriefing();

  if (b.stale.days > 7) {
    // Purani copy pe call karne ka matlab roz "data purana hai" sunna —
    // wo alert nahi, irritation hai. Log karo, phone mat bajao.
    console.warn(`[briefing] SKIP — copy ${b.stale.days} din purani (${b.stale.latest})`);
    await db.query(
      `INSERT INTO public.call_log (caller_number, direction, authorised, auth_failure)
       VALUES ($1, 'outbound', false, $2)`,
      [process.env.BRIEFING_TO ?? null, `stale_data_${b.stale.days}d`],
    ).catch(() => {});
    return res.status(200).json({ called: false, reason: 'stale_data', stale: b.stale });
  }

  if (!vapiConfigured()) {
    console.log('[briefing] Vapi set nahi hai. Script taiyaar thi:\n' + b.script);
    return res.status(200).json({ called: false, reason: 'vapi_not_configured', script: b.script });
  }

  const results = await placeBriefingCall(b.script);
  console.log('[briefing]', JSON.stringify(results));

  await db.query(
    `INSERT INTO public.call_log (caller_number, direction, authorised, transcript, duration_sec)
     VALUES ($1, 'outbound', $2, $3, $4)`,
    [
      results.find((r) => r.placed)?.to ?? null,
      results.some((r) => r.placed),
      JSON.stringify({ script: b.script, facts: b.facts, polished: b.polished }),
      b.estSeconds,
    ],
  ).catch(() => {});

  return res.status(200).json({ called: results.some((r) => r.placed), results });
}
