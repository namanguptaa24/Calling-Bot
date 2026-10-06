import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { allTools } from './tools.js';
import { getSnapshot } from './snapshot.js';
import { buildSystemPrompt } from './prompt.js';

const client = new Anthropic();

/**
 * Voice ke liye tuning:
 *
 *  effort "low"  — call pe 2 second ki chuppi maut hai. Kam effort matlab kam
 *                  sochna, jaldi jawaab. Agar jawaab halke lagein to "medium" karo.
 *  max_tokens    — spoken jawaab chhote hote hain. 1500 kaafi hai; isse zyada
 *                  ka matlab hai agent bhashan de raha hai, jo call pe bura hai.
 *  thinking on   — Opus 5 pe thinking disable karna do tarah se ulta padta hai
 *                  (tool call text mein leak ho jaata hai). On rakho, effort girao.
 */
const MODEL = process.env.AGENT_MODEL ?? 'claude-opus-5';
const EFFORT = (process.env.AGENT_EFFORT ?? 'low') as 'low' | 'medium' | 'high';

export type Turn = Anthropic.Beta.BetaMessageParam;

export type AgentReply = {
  text: string;
  toolsUsed: string[];
  ms: number;
};

/**
 * Ek turn chalao. `history` mein poori baat-cheet aati hai aur updated
 * hoke wapas jaati hai — API stateless hai, har baar poora bhejna padta hai.
 */
export async function respond(
  history: Turn[],
  userText: string,
  opts: { callerName?: string } = {},
): Promise<AgentReply> {
  const started = Date.now();
  const snap = await getSnapshot();

  history.push({ role: 'user', content: userText });

  const toolsUsed: string[] = [];
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 1500,
    system: buildSystemPrompt(snap, opts.callerName),
    output_config: { effort: EFFORT },
    tools: allTools,
    messages: history,
  });

  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === 'tool_use') toolsUsed.push(block.name);
    }
  }

  const final = await runner.done();

  // Runner apni copy mein assistant turns aur tool_result blocks jodta hai.
  // Poori history wahan se wapas lo — sirf text rakhoge to agli turn pe API
  // 400 dega, kyunki tool_use ka jodidar tool_result gayab hoga.
  const updated = [...runner.params.messages];
  history.length = 0;
  history.push(...updated);

  const text = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();

  return { text, toolsUsed, ms: Date.now() - started };
}

/** Call ka pehla jawaab — user ke bole bina. */
export async function opening(callerName?: string): Promise<AgentReply> {
  const history: Turn[] = [];
  return respond(history, 'Aaj ka status batao.', { callerName });
}
