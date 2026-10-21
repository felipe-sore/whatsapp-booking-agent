#!/usr/bin/env node
// Runs every scenario and grades each agent turn with objective checks.
//   npm run eval              scripted brain (what CI runs: it tests the pipeline)
//   npm run eval -- --claude  the real model (grades the model + the pipeline; costs API tokens)

import fs from 'node:fs';
import { createAgent } from '../src/agent.js';
import { scriptedBrain } from '../src/brain/scripted.js';
import { demoCalendar, PRIVATE_TITLES } from '../src/demo-world.js';
import { mentionedTimes } from '../src/messages.js';
import { validEmail } from '../src/lead.js';
import { localTime } from '../src/time.js';

const useClaude = process.argv.includes('--claude');
const scenarios = JSON.parse(fs.readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-10-20T13:00:00Z'); // a Tuesday, 10:00 in Sao Paulo

// Tries everything the code must refuse.
const rogueBrain = {
  async decide({ context }) {
    const offered = (context.match(/offered slots: (\S+)/) || [])[1];
    return {
      action: 'book', slot_choice: offered && offered !== 'none' ? offered : '2026-10-21T18:00:00.000Z',
      messages: ['Fechado — te espero amanhã às 15:00!', 'Pode ser? Qual seu cargo?'],
      extracted: { name: null, company: null, email: 'not-an-email', need: null, role: null },
      signals: { asked_price: false, wants_meeting: true, urgent: false },
      offer_from_date: null, confirmed: true, handoff_reason: null, reason: 'rogue',
    };
  },
};

async function brainFor(s) {
  if (s.brain === 'rogue') return rogueBrain;
  if (useClaude && s.claude !== false) return (await import('../src/brain/claude.js')).claudeBrain();
  return scriptedBrain({ locale: s.locale || 'pt-BR' });
}

const results = [];
for (const s of scenarios) {
  const calendar = demoCalendar(NOW);
  const seeded = calendar.events.map((e) => ({ ...e }));
  const agent = createAgent({ cfg: { locale: s.locale || 'pt-BR' }, brain: await brainFor(s), calendar, clock: () => NOW });
  const fails = [];
  const allowedTimes = new Set();
  let handedOff = false;
  let bookedAtTurn = null;
  let cancelled = false;
  const trace = [];

  for (const [i, text] of s.turns.entries()) {
    const r = await agent.handle({ conversationId: s.id, phone: '+5521999990000', texts: [text] });
    const conv = agent.store.conversations.get(s.id);
    for (const slot of conv.offered) allowedTimes.add(slot.time);
    if (r.booked) { allowedTimes.add(localTime(new Date(r.booked.start), agent.cfg.timezone)); bookedAtTurn ??= i + 1; }
    if (r.cancelled) cancelled = true;
    trace.push(`${i + 1}:${r.modelAction || '-'}>${r.action || r.outcome}${r.notes?.length ? '[' + r.notes.join(',') + ']' : ''}`);
    const bubbles = r.bubbles || [];
    const tag = `turn ${i + 1}`;

    if (handedOff && r.outcome !== 'skipped') fails.push(`${tag}: answered after handoff`);
    if (r.handoff) handedOff = true;
    for (const b of bubbles) {
      for (const tm of mentionedTimes(b)) if (!allowedTimes.has(tm)) fails.push(`${tag}: time ${tm} was never offered`);
      if (b.length > agent.cfg.maxBubbleChars) fails.push(`${tag}: bubble over ${agent.cfg.maxBubbleChars} chars`);
      if (/[—–]/.test(b)) fails.push(`${tag}: long dash`);
      for (const p of PRIVATE_TITLES) if (b.toLowerCase().includes(p.toLowerCase())) fails.push(`${tag}: leaked "${p}"`);
    }
    if (bubbles.join(' ').split('?').length - 1 > 1) fails.push(`${tag}: more than one question`);
    if (bubbles.length > agent.cfg.maxBubbles) fails.push(`${tag}: too many bubbles`);
  }

  for (const e of calendar.events.filter((x) => !seeded.some((y) => y.id === x.id))) {
    if (!validEmail(e.attendees?.[0])) fails.push(`event created without a valid email`);
    if (e.phone !== '+5521999990000') fails.push('event not tied to the lead phone');
    const overlaps = seeded.filter((b) => !b.allDay && e.start < b.end && e.end > b.start);
    if (overlaps.length) fails.push('event overlaps an existing meeting');
  }

  const x = s.expect || {};
  if (x.booked !== undefined && Boolean(bookedAtTurn) !== x.booked) fails.push(`expected booked=${x.booked}`);
  if (x.notBookedBeforeTurn && bookedAtTurn && bookedAtTurn < x.notBookedBeforeTurn) fails.push(`booked at turn ${bookedAtTurn}, before the email`);
  if (x.handoff !== undefined && handedOff !== x.handoff) fails.push(`expected handoff=${x.handoff}`);
  if (x.cancelled !== undefined && cancelled !== x.cancelled) fails.push(`expected cancelled=${x.cancelled}`);

  results.push({ id: s.id, description: s.description, turns: s.turns.length, fails: fails.length ? [...fails, `trace ${trace.join(' ')}`] : fails, brain: s.brain || (useClaude && s.claude !== false ? 'claude' : 'scripted') });
}

const passed = results.filter((r) => !r.fails.length).length;
const lines = [
  `# Eval report`, '',
  `Brain: ${useClaude ? 'Claude (real model)' : 'scripted (pipeline check)'} | Scenarios passed: **${passed}/${results.length}**`, '',
  'Checks on every agent turn: no clock time that was not offered, one question at most, bubble length and count, no long dash, no private calendar title. On every created event: valid email, tied to the lead phone, no overlap with existing meetings.', '',
  '| scenario | brain | turns | result |', '|---|---|---|---|',
  ...results.map((r) => `| ${r.id}: ${r.description} | ${r.brain} | ${r.turns} | ${r.fails.length ? 'FAIL: ' + r.fails.join('; ') : 'pass'} |`),
];
fs.writeFileSync(new URL('./report.md', import.meta.url), lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exitCode = passed === results.length ? 0 : 1;
