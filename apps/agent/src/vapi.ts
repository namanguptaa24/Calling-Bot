import { rows } from './db.js';

/**
 * Vapi outbound call adapter.
 *
 * Design: Vapi dashboard mein assistant EK BAAR banega, jiska
 * `firstMessage` sirf itna hoga — `{{script}}`. Awaaz, model, bhasha,
 * silence timeout — sab wahan set hoga. Hum har call pe sirf script
 * bhejte hain `assistantOverrides.variableValues` se.
 *
 * Isse do faayde: Vapi ki assistant config ka poora shape humein jaanne
 * ki zaroorat nahi, aur aap awaaz dashboard se badal sakte ho bina code
 * chhue. (Confirmed shape: POST /call with assistantId + phoneNumberId
 * + customer.number + assistantOverrides.variableValues.)
 *
 * Briefing ek-tarfa hai, isliye assistant ko LLM ki zaroorat nahi — wo
 * bas `{{script}}` bolta hai aur call kaat deta hai.
 */

const API = 'https://api.vapi.ai/call';

export type CallResult =
  | { placed: false; reason: 'not_configured' | 'no_recipient'; detail?: string }
  | { placed: true; callId: string; to: string };

export function vapiConfigured(): boolean {
  return Boolean(
    process.env.VAPI_API_KEY && process.env.VAPI_ASSISTANT_ID && process.env.VAPI_PHONE_NUMBER_ID,
  );
}

/** Kisko call jaani hai — allowed_caller table se, warna env se. */
async function recipients(): Promise<{ phone: string; name: string }[]> {
  const fromDb = await rows<{ phone: string; name: string }>(
    `SELECT phone, name FROM public.allowed_caller WHERE active ORDER BY added_at`,
  ).catch(() => []);
  if (fromDb.length > 0) return fromDb;

  const env = process.env.BRIEFING_TO;
  return env ? [{ phone: env.trim(), name: 'owner' }] : [];
}

export async function placeBriefingCall(script: string): Promise<CallResult[]> {
  if (!vapiConfigured()) return [{ placed: false, reason: 'not_configured' }];

  const to = await recipients();
  if (to.length === 0) return [{ placed: false, reason: 'no_recipient' }];

  const results: CallResult[] = [];

  for (const r of to) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assistantId: process.env.VAPI_ASSISTANT_ID,
          phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
          customer: { number: r.phone },
          assistantOverrides: {
            variableValues: { script, name: r.name },
          },
        }),
      });

      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        results.push({
          placed: false,
          reason: 'not_configured',
          detail: `${res.status} ${body?.message ?? JSON.stringify(body).slice(0, 200)}`,
        });
        continue;
      }
      results.push({ placed: true, callId: body.id, to: r.phone });
    } catch (e: any) {
      results.push({ placed: false, reason: 'not_configured', detail: e.message });
    }
  }

  return results;
}
