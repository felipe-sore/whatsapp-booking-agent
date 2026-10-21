#!/usr/bin/env node
// Talk to the agent in your terminal. No WhatsApp, no calendar account.
//   npm run chat                 scripted brain, no API key needed
//   npm run chat -- --claude     real model (needs ANTHROPIC_API_KEY or `ant auth login`)
//   npm run chat -- --en         English config

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createAgent } from '../src/agent.js';
import { scriptedBrain } from '../src/brain/scripted.js';
import { demoCalendar } from '../src/demo-world.js';

const args = new Set(process.argv.slice(2));
const locale = args.has('--en') ? 'en' : 'pt-BR';
const brain = args.has('--claude')
  ? (await import('../src/brain/claude.js')).claudeBrain()
  : scriptedBrain({ locale });

// Pin "now" to a weekday morning so the demo always has availability.
const now = new Date();
const calendar = demoCalendar(now);
const agent = createAgent({
  cfg: { locale, replyHours: { start: 0, end: 24 } },
  brain,
  calendar,
  send: async ({ text }) => { stdout.write(`\x1b[32m${agent.cfg.business.agentName}:\x1b[0m ${text}\n`); },
  notify: async ({ reason }) => { stdout.write(`\x1b[33m[handoff to a human: ${reason}]\x1b[0m\n`); },
});

stdout.write(`Simulator (${args.has('--claude') ? 'Claude' : 'scripted brain'}, ${locale}). Commands: /events, /log, /quit\n\n`);
const rl = readline.createInterface({ input: stdin, output: stdout });
for (;;) {
  const line = (await rl.question('\x1b[36mYou:\x1b[0m ')).trim();
  if (!line) continue;
  if (line === '/quit') break;
  if (line === '/events') { console.table(calendar.events.map(({ id, start, title }) => ({ id, start, title }))); continue; }
  if (line === '/log') { console.dir(agent.store.decisions.at(-1), { depth: 4 }); continue; }
  const r = await agent.handle({ conversationId: 'sim', phone: '+5521999990000', texts: [line] });
  if (r.outcome !== 'sent') stdout.write(`\x1b[90m[${r.outcome}${r.why ? `: ${r.why}` : ''}]\x1b[0m\n`);
  if (r.notes.length) stdout.write(`\x1b[90m[code: ${r.notes.join(', ')}]\x1b[0m\n`);
}
rl.close();
