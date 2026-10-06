import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Cron endpoints public URL pe hote hain. Bina guard ke koi bhi
 * /api/cron/briefing hit karke aapko call karwa sakta hai, ya /api/cron/sync
 * baar-baar chala ke production MySQL pe load daal sakta hai.
 *
 * Vercel har cron invocation ke saath `Authorization: Bearer $CRON_SECRET`
 * bhejta hai — bas CRON_SECRET env var set hona chahiye.
 */
export function cronAuthorised(req: VercelRequest, res: VercelResponse): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'CRON_SECRET set nahi hai — endpoint khula reh jata' });
    return false;
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'unauthorised' });
    return false;
  }
  return true;
}
