/**
 * Call pe exactly kya bola jayega — bina kisi account ke, abhi.
 *
 *   npm run briefing
 *   npm run briefing -- --people 8 --tasks 3
 */
import 'dotenv/config';
import { buildBriefing } from './briefing.js';
import { db } from './db.js';

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? Number(process.argv[i + 1]) : undefined;
};

const b = await buildBriefing({
  topPeople: arg('people'),
  tasksPerPerson: arg('tasks'),
});

console.log('\n' + '═'.repeat(70));
console.log('📞 CALL SCRIPT');
console.log('═'.repeat(70) + '\n');
console.log(b.script);
console.log('\n' + '═'.repeat(70));
console.log(`${b.wordCount} shabd · ~${b.estSeconds} second ki call`);
console.log(
  b.stale.days > 7 ? `⚠️  STALE — copy ${b.stale.days} din purani (${b.stale.latest}), briefing rok di gayi`
  : b.polished ? 'descriptions: LLM polished'
  : 'descriptions: truncated (koi OPENAI_API_KEY nahi, ya sab reject hue)'
);
console.log(`${b.facts.totalOverdue} overdue · ${b.facts.peopleWithOverdue} log · sabse purana ${b.facts.oldestDays} din`);
console.log('═'.repeat(70) + '\n');

await db.end();
