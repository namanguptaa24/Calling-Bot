import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';

/**
 * Task descriptions ko bolne layak banata hai.
 *
 * Yahan ka sabse zaroori design faisla: LLM ko numbers, naam aur tareekhein
 * dikhayi hi nahi jaati. Wo sirf ek description string leta hai aur chhota
 * vaakya lautata hai. Script code assemble karta hai — "116 din se",
 * "Pradhuman Kumar ke paas" sab SQL se aate hain.
 *
 * Matlab LLM ek number galat bol hi nahi sakta, kyunki uske paas number
 * hai hi nahi. Ye guarantee provider se nahi, architecture se aati hai —
 * model badlo to bhi bani rehti hai.
 *
 * API key na ho, ya call fail ho jaye — tab bhi briefing chalti hai,
 * bas descriptions truncation pe gir jaati hain. Ek na aane wali call
 * kachhi phrasing se zyada nuksaan hai.
 */

const MODEL = process.env.POLISH_MODEL ?? 'gpt-4.1-mini';

const Output = z.object({
  phrases: z.array(
    z.object({
      id: z.number().describe('Wahi id jo input mein di gayi thi'),
      phrase: z.string().describe('Chhota bolne layak vaakya, 3 se 8 shabd'),
    }),
  ),
});

const SYSTEM = [
  'Tumhe ek Indian marketing agency ke task management system se raw task',
  'descriptions milengi. Har ek ko ek chhote, bolne layak vaakya mein badlo —',
  'jaisa koi phone pe bolega.',
  '',
  'Niyam:',
  '- 3 se 8 shabd. Chhota rakho.',
  '- Hinglish theek hai. Technical shabd jaise hain waise rehne do.',
  '- Adhoore ya kate hue description ko poora karne ki koshish mat karo.',
  '  Jo likha hai usi ka matlab pakdo, apne se kuch mat jodo.',
  '- Koi number, tareekh, ya aadmi ka naam mat likho — wo alag se aate hain.',
  '- Har input id ke liye exactly ek phrase lautao.',
].join('\n');

/** LLM na chale to yahi chalta hai — poore shabd pe kaato, list numbering hatao. */
export function truncate(desc: string, maxWords = 10): string {
  const clean = String(desc ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*\d+[.)]\s*/, '')       // "1. " jaisa prefix
    .replace(/\(\s*remarks?\s*\)/gi, '')
    .replace(/[|•\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = clean.split(' ');
  if (words.length <= maxWords) return clean.replace(/[.,;:]+$/, '');

  // Poore clause pe kaatne ki koshish — beech-vaakya cut sunne mein bura lagta hai
  const head = words.slice(0, maxWords).join(' ');
  const lastStop = Math.max(head.lastIndexOf(','), head.lastIndexOf(';'));
  return (lastStop > head.length * 0.5 ? head.slice(0, lastStop) : head).replace(/[.,;:]+$/, '');
}

/**
 * LLM ke output ko original ke khilaaf jaanchta hai.
 *
 * Asli ghatna: "Axis 7928 AJ payment clear" → "Clear AMEX cc payment".
 * Axis Bank AMEX ban gaya. Prompt mein "kuch mat jodo" likha tha, phir bhi.
 *
 * Isliye ab niyam prompt mein nahi, code mein hai: polished phrase ka har
 * content word original mein maujood hona chahiye. LLM sirf shabd HATA
 * sakta hai aur unka kram badal sakta hai — naya shabd nahi la sakta.
 *
 * Kabhi-kabhi ye theek phrase bhi reject kar dega (jaise "Generate" jodna).
 * Wo manzoor hai — reject hone pe truncation chalti hai, jo kaccha hai par
 * sach hai. Galat bank ka naam bol dena kaccha nahi, galat hai.
 */
const CONNECTORS = new Set([
  'ka','ki','ke','ko','se','mein','aur','hai','hain','par','wala','wali',
  'the','a','an','and','or','of','in','on','for','to','with','from','at','by','is','are',
]);

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

export function isFaithful(original: string, phrase: string): boolean {
  const src = tokens(original);
  for (const w of tokens(phrase)) {
    if (CONNECTORS.has(w)) continue;
    // Inflection chalne do: "leads"/"Lead", "daily"/"day"
    const ok = src.some(
      (o) => o === w || (w.length >= 3 && o.length >= 3 && (o.startsWith(w) || w.startsWith(o))),
    );
    if (!ok) return false;
  }
  return true;
}

export type PolishItem = { id: number; description: string };

export async function polishDescriptions(
  items: PolishItem[],
): Promise<{ map: Map<number, string>; usedLLM: boolean }> {
  const fallback = () => new Map(items.map((i) => [i.id, truncate(i.description)]));

  if (!process.env.OPENAI_API_KEY || items.length === 0) {
    return { map: fallback(), usedLLM: false };
  }

  try {
    const client = new OpenAI();
    const res = await client.chat.completions.parse({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: JSON.stringify(items.map((i) => ({ id: i.id, text: i.description }))),
        },
      ],
      response_format: zodResponseFormat(Output, 'phrases'),
    });

    const parsed = res.choices[0]?.message.parsed;
    if (!parsed) return { map: fallback(), usedLLM: false };

    const map = fallback(); // pehle sabko fallback, phir jo pass ho wo upar likho
    const byId = new Map(items.map((i) => [i.id, i.description]));
    let rejected = 0;

    for (const p of parsed.phrases) {
      const phrase = p.phrase?.trim();
      const original = byId.get(p.id);
      if (!phrase || !original) continue;
      if (phrase.split(/\s+/).length > 12) continue;
      if (!isFaithful(original, phrase)) {
        rejected++;
        continue; // fallback truncation hi rahegi
      }
      map.set(p.id, phrase);
    }

    if (rejected > 0) {
      console.warn(`polish: ${rejected}/${parsed.phrases.length} phrase reject hue (naya shabd tha) — truncation use hui`);
    }
    return { map, usedLLM: true };
  } catch {
    return { map: fallback(), usedLLM: false };
  }
}
