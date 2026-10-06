import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronAuthorised } from '../_auth.js';
import { runSync, syncConfigured } from '../../apps/agent/src/sync.js';

// Sync ~60-90 second leti hai (24k rows). Pro ka default 300s hai,
// par saaf likh dena behtar hai taaki data badhne pe surprise na ho.
export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!cronAuthorised(req, res)) return;

  if (!syncConfigured()) {
    return res.status(200).json({ ran: false, reason: 'DB_* credentials nahi hain' });
  }

  try {
    const r = await runSync();
    console.log('[sync]', JSON.stringify(r));
    return res.status(200).json(r);
  } catch (e: any) {
    // Sync fail hone se briefing jhooth nahi bolti — dataAge guard use
    // purani copy pe khud rok deta hai. Isliye 500 dena theek hai.
    console.error('[sync] FAILED:', e.message);
    return res.status(500).json({ ran: false, error: e.message });
  }
}
