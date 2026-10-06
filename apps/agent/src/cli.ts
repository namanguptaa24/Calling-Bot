#!/usr/bin/env node
/**
 * Local test harness — phone lagane se pehle agent ka dimaag test karo.
 *
 *   npm run agent          # baat karo (ANTHROPIC_API_KEY chahiye)
 *   npm run agent -- --dry # bina LLM ke: snapshot + tools seedha chalao
 *
 * --dry mode is liye hai ki data layer aur tools bina kisi API key ke
 * verify ho jaayein. Agar ye theek hai to bachi hui galti sirf prompt mein
 * ho sakti hai, data mein nahi.
 */

import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { getSnapshot } from './snapshot.js';
import { allTools } from './tools.js';
import { db } from './db.js';

const DRY = process.argv.includes('--dry');

async function dryRun() {
  console.log('\n🔍 DRY MODE — koi LLM nahi, sirf data layer\n');

  const t0 = Date.now();
  const snap = await getSnapshot(true);
  console.log(`📸 Snapshot: ${Date.now() - t0}ms · ${(JSON.stringify(snap).length / 1024).toFixed(1)} KB`);
  console.log(`   ${snap.team.presentToday}/${snap.team.headcount} present · ${snap.tasks.overdue} overdue · ${snap.clients.active} active clients\n`);

  console.log('⚠️  Attention items:');
  for (const a of snap.attentionItems) {
    console.log(`   ${{ high: '🔴', medium: '🟡', low: '⚪' }[a.severity]} ${a.text}`);
  }

  console.log('\n🔧 Tools — har ek pe ek asli call:\n');
  const probes: [string, any][] = [
    ['get_person', { name: 'Pradhuman' }],
    ['get_client', { name: 'Homeloomers' }],
    ['get_overdue_tasks', { limit: 3 }],
    ['get_team_hours', { days: 7 }],
    ['search_tasks', { query: 'website' }],
    ['get_recent_activity', { days: 3 }],
  ];

  for (const [name, input] of probes) {
    const tool = allTools.find((t) => t.name === name)!;
    const start = Date.now();
    try {
      const out = await (tool as any).run(input);
      const parsed = JSON.parse(out);
      const summary =
        parsed.ambiguous ? `ambiguous: ${parsed.matches?.length} matches`
        : parsed.found === false ? 'not found'
        : parsed.count !== undefined ? `${parsed.count} results`
        : Object.keys(parsed).slice(0, 4).join(', ');
      console.log(`   ✅ ${name.padEnd(20)} ${String(Date.now() - start).padStart(5)}ms   ${summary}`);
    } catch (e: any) {
      console.log(`   ❌ ${name.padEnd(20)} ${e.message}`);
    }
  }

  console.log('\n   create_note test nahi kiya — wo likhta hai. Baat-cheet mein try karna.\n');
  await db.end();
}

async function chat() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\n❌ ANTHROPIC_API_KEY .env mein chahiye.');
    console.error('   Bina key ke data layer test karne ke liye: npm run agent -- --dry\n');
    process.exit(1);
  }

  // Import yahan taaki --dry mode bina API key ke chale
  const { respond, opening } = await import('./agent.js');

  console.log('\n📞 Call connected. Ctrl+C se cut.\n');

  const first = await opening(process.env.CALLER_NAME);
  console.log(`🤖 ${first.text}\n`);
  console.log(`   [${first.ms}ms${first.toolsUsed.length ? ` · tools: ${first.toolsUsed.join(', ')}` : ''}]\n`);

  const history: any[] = [];
  const rl = readline.createInterface({ input: stdin, output: stdout });

  while (true) {
    const q = (await rl.question('👤 ')).trim();
    if (!q) continue;
    if (['bye', 'exit', 'quit'].includes(q.toLowerCase())) break;

    try {
      const r = await respond(history, q, { callerName: process.env.CALLER_NAME });
      console.log(`\n🤖 ${r.text}\n`);
      console.log(`   [${r.ms}ms${r.toolsUsed.length ? ` · tools: ${r.toolsUsed.join(', ')}` : ''}]\n`);
    } catch (e: any) {
      console.error(`\n❌ ${e.message}\n`);
    }
  }

  rl.close();
  await db.end();
  console.log('\nCall ended.\n');
}

await (DRY ? dryRun() : chat());
