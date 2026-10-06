import { row } from './db.js';

/**
 * Call authorisation.
 *
 * Ye sirf formality nahi hai. Ye number poochhne pe team ke naam, kaun kitna
 * kaam kar raha hai, aur client list bol deta hai. Jise number mil gaya,
 * use sab mil gaya — isliye do layer:
 *
 *   1. Caller ID allowlist — anjaan number ko agent uthata hi nahi
 *   2. Bola hua PIN        — caller ID spoof ho sakti hai, PIN nahi
 *
 * Dono Phase 2 mein hi ban rahe hain. Baad mein retrofit karna hamesha
 * mushkil hota hai, aur tab tak number kisi ke paas bhi ja chuka hota hai.
 */

export type Caller = {
  phone: string;
  name: string;
  canHearMoney: boolean;
};

export type AuthResult =
  | { ok: true; caller: Caller; needsPin: boolean }
  | { ok: false; reason: 'unknown_number' | 'inactive' };

/** E.164 pe normalise — Vapi/Twilio "+91 98765 43210" jaise bhi bhej sakte hain. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+91${digits}`; // India default
  return `+${digits}`;
}

export async function authoriseCaller(rawPhone: string): Promise<AuthResult> {
  const phone = normalisePhone(rawPhone);
  const r = await row(
    `SELECT phone, name, pin, can_hear_money, active FROM public.allowed_caller WHERE phone = $1`,
    [phone],
  );
  if (!r) return { ok: false, reason: 'unknown_number' };
  if (!r.active) return { ok: false, reason: 'inactive' };
  return {
    ok: true,
    caller: { phone: r.phone, name: r.name, canHearMoney: r.can_hear_money },
    needsPin: Boolean(r.pin),
  };
}

export async function verifyPin(rawPhone: string, spoken: string): Promise<boolean> {
  const phone = normalisePhone(rawPhone);
  // Bole hue PIN mein aksar space aa jaate hain: "one two three four"
  const pin = spoken.replace(/\D/g, '');
  if (!pin) return false;
  const r = await row(`SELECT pin FROM public.allowed_caller WHERE phone = $1 AND active`, [phone]);
  return Boolean(r?.pin) && r.pin === pin;
}
