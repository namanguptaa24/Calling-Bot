import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db } from '../apps/agent/src/db.js';
import { dataAge } from '../apps/agent/src/briefing.js';
import { syncConfigured } from '../apps/agent/src/sync.js';
import { vapiConfigured } from '../apps/agent/src/vapi.js';

export const config = { maxDuration: 30 };

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    await db.query('SELECT 1');
    const age = await dataAge();
    return res.status(200).json({
      ok: true,
      dataAge: age,
      stale: age.days > 7,
      sync: syncConfigured() ? 'on' : 'no credentials',
      vapi: vapiConfigured() ? 'on' : 'not configured',
      polish: process.env.OPENAI_API_KEY ? 'on' : 'truncation fallback',
    });
  } catch (e: any) {
    return res.status(503).json({ ok: false, error: e.message });
  }
}
