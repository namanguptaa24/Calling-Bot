import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildBriefing } from '../apps/agent/src/briefing.js';

/** Preview — call nahi jaati, sirf script dikhti hai. */
export const config = { maxDuration: 60 };

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const b = await buildBriefing();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.status(200).send(
    `${b.script}\n\n---\n${b.wordCount} shabd · ~${b.estSeconds}s` +
    `\npolished: ${b.polished}` +
    `\ndata: ${b.stale.latest} (${b.stale.days} din purana)`,
  );
}
