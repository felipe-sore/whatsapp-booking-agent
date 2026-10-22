import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shapeMessages, splitBubble, mentionedTimes, mentionedWeekdays } from '../src/messages.js';
import { systemPrompt } from '../src/prompt.js';
import { mergeProfile, score, missingFields } from '../src/lead.js';
import { checkGates, countConversationReply, conversationReplies } from '../src/gates.js';
import { MessageBuffer } from '../src/buffer.js';
import { validateDecision } from '../src/decision.js';
import { defaultConfig as cfg } from '../src/config.js';
import { NOW, decision } from './helpers.js';

test('times are recognized in common formats', () => {
  assert.deepEqual(mentionedTimes('às 15:00 ou 9h ou 10h30'), ['15:00', '09:00', '10:30']);
  assert.deepEqual(mentionedTimes('amanhã às 15 horas'), ['15:00']);
  assert.deepEqual(mentionedTimes('at 15 hrs, or 3pm, or 3 PM, or 3:30 p.m.'), ['15:00', '15:00', '15:00', '15:30']);
  assert.deepEqual(mentionedTimes('12am e 12pm'), ['00:00', '12:00']);
});

test('numbers that are not clock times are left alone', () => {
  for (const s of ['uma call de 45 minutos', 'são 2 horas de conversa', 'R$ 1.500', 'temos 3 amigos', 'turma de 25 alunos']) {
    assert.deepEqual(mentionedTimes(s), [], s);
  }
});

test('days named in a message', () => {
  const today = '2026-10-20'; // Tuesday
  assert.deepEqual([...mentionedWeekdays('Quinta-feira às 10h', today)], [4]);
  assert.deepEqual([...mentionedWeekdays('amanhã às 10h', today)], [3]);
  assert.deepEqual([...mentionedWeekdays('depois de amanhã', today)], [4]);
  assert.deepEqual([...mentionedWeekdays('Thursday at 10:00', today)], [4]);
});

test('messages: an offered time on another day is dropped too', () => {
  const offered = [{ day: '2026-10-22', time: '10:00' }]; // Thursday
  const today = '2026-10-20';
  const keep = (m) => shapeMessages([m], cfg, { offered, today }).bubbles.length === 1;
  assert.equal(keep('Quinta às 10:00 funciona?'), true);
  assert.equal(keep('10:00 fica bom?'), true);
  assert.equal(keep('depois de amanhã às 10h?'), true);
  assert.equal(keep('Terça às 10:00?'), false);
  assert.equal(keep('amanhã às 10h?'), false);
  assert.equal(keep('Quinta às 15 horas?'), false);
  assert.equal(keep('Thursday at 3 PM?'), false);
  assert.equal(keep('Quinta ou sexta às 10:00?'), false);
});

test('prompt: asked if it is a bot, the agent says it is a virtual assistant', () => {
  const p = systemPrompt(cfg);
  assert.match(p, new RegExp(`you are ${cfg.business.agentName}, ${cfg.business.name}'s virtual assistant`));
  assert.match(p, /Never say or suggest you are human/);
  assert.doesNotMatch(p, /deflect/i);
});

test('messages: long dash replaced, unoffered time dropped, one question, split at sentence end', () => {
  const r = shapeMessages(['Ótimo — vamos lá.', 'Pode ser amanhã às 15:00?', 'Qual seu cargo?'], cfg, { allowedTimes: ['09:30'] });
  assert.deepEqual(r.bubbles, ['Ótimo, vamos lá.', 'Qual seu cargo?']);
  assert.ok(r.notes.includes('dropped_unoffered_time'));
  const two = shapeMessages(['Você usa CRM? E quantos vendedores?'], cfg);
  assert.deepEqual(two.bubbles, ['Você usa CRM?']);
  assert.deepEqual(splitBubble('Uma frase curta. Outra frase curta.', 20), ['Uma frase curta.', 'Outra frase curta.']);
});

test('profile: invalid email rejected and logged, changes audited', () => {
  const p = {};
  const ev = mergeProfile(p, { name: 'Ana', email: 'ana@x' }, NOW);
  assert.equal(p.name, 'Ana');
  assert.equal(p.email, undefined);
  assert.deepEqual(ev.map((e) => e.type), ['field_detected', 'rejected_value']);
  const ev2 = mergeProfile(p, { name: 'Ana Lima' }, NOW);
  assert.equal(ev2[0].type, 'field_changed');
  assert.equal(ev2[0].old, 'Ana');
});

test('score is computed in code, not by the model', () => {
  assert.deepEqual(score({}), { score: 0, status: 'cold' });
  assert.equal(score({ need: 'x', company: 'y', name: 'z', email: 'a@corp.com' }).status, 'warm');
  assert.equal(score({ need: 'x', company: 'y', email: 'a@corp.com' }, { wants_meeting: true, urgent: true }).status, 'hot');
  assert.ok(score({ email: 'a@gmail.com' }).score < score({ email: 'a@corp.com' }).score);
  assert.deepEqual(missingFields({ name: 'a' }, ['name', 'company', 'email']), ['company', 'email']);
});

test('gates', () => {
  const conv = { id: 'c', state: 'active', labels: [] };
  assert.equal(checkGates(conv, cfg, NOW, 0).ok, true);
  assert.equal(checkGates({ ...conv, state: 'human' }, cfg, NOW, 0).skip, 'human_took_over');
  assert.equal(checkGates({ ...conv, labels: ['do_not_contact'] }, cfg, NOW, 0).skip, 'stop_label');
  assert.equal(checkGates(conv, { ...cfg, canaryConversations: ['other'] }, NOW, 0).skip, 'not_canary');
  assert.equal(checkGates(conv, cfg, new Date('2026-10-21T03:00:00Z'), 0).defer, 'outside_reply_hours');
  assert.equal(checkGates(conv, cfg, NOW, 300).defer, 'daily_cap');
});

test('gates: one conversation has its own daily cap, reset when the day changes', () => {
  const conv = { id: 'c', state: 'active', labels: [] };
  for (let i = 0; i < cfg.conversationDailyCap; i++) countConversationReply(conv, '2026-10-20');
  assert.equal(conversationReplies(conv, '2026-10-20'), cfg.conversationDailyCap);
  assert.equal(checkGates(conv, cfg, NOW, 0).defer, 'conversation_daily_cap');
  assert.equal(conversationReplies(conv, '2026-10-21'), 0);
  countConversationReply(conv, '2026-10-21');
  assert.deepEqual(conv.replies, { day: '2026-10-21', count: 1 });
});

test('the Docker build context leaves secrets out', () => {
  const lines = fs.readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8').split('\n');
  for (const l of ['.env', '.env.*', '!.env.example', '*.pem', '.git', 'node_modules']) assert.ok(lines.includes(l), `.dockerignore misses ${l}`);
});

test('buffer: bursts become one turn, duplicate deliveries are ignored', async () => {
  const timers = [];
  const flushed = [];
  const buf = new MessageBuffer({
    quietMs: 5000, onFlush: async (x) => flushed.push(x),
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: (id) => { timers[id - 1] = null; },
  });
  buf.push({ conversationId: 'c', phone: 'p', messageId: 'm1', text: 'oi' });
  assert.equal(buf.push({ conversationId: 'c', phone: 'p', messageId: 'm1', text: 'oi' }), false);
  buf.push({ conversationId: 'c', phone: 'p', messageId: 'm2', text: 'tudo bem?' });
  await timers.filter(Boolean).at(-1)();
  assert.deepEqual(flushed, [{ conversationId: 'c', phone: 'p', texts: ['oi', 'tudo bem?'] }]);
});

test('decision validation', () => {
  assert.deepEqual(validateDecision(decision()), []);
  assert.ok(validateDecision(decision({ action: 'delete_everything' })).length);
  assert.ok(validateDecision(decision({ offer_from_date: 'tomorrow' })).length);
  assert.ok(validateDecision(null).length);
});

test('buffer: remembers only the most recent message ids', () => {
  const buf = new MessageBuffer({ quietMs: 5000, onFlush: async () => {}, setTimer: () => 0, clearTimer: () => {}, maxSeen: 3 });
  for (const id of ['m1', 'm2', 'm3', 'm4']) buf.push({ conversationId: 'c', phone: 'p', messageId: id, text: id });
  assert.equal(buf.seen.size, 3);
  assert.ok(!buf.seen.has('m1'));
  assert.equal(buf.push({ conversationId: 'c', phone: 'p', messageId: 'm4', text: 'again' }), false);
});

import { classifyMetaError, deliveryFailureNote } from '../src/delivery.js';

test('delivery: Meta error codes map to what to do next', () => {
  assert.equal(classifyMetaError(131049).action, 'retry_fast'); // inbox full: looks final, clears on its own
  assert.equal(classifyMetaError('131048').action, 'retry_slow'); // low reputation: fast retries make it worse
  assert.equal(classifyMetaError(131047).action, 'permanent');
  assert.equal(classifyMetaError(133010).action, 'permanent');
  assert.deepEqual(classifyMetaError(999999), { code: 999999, action: 'unknown', reason: 'Meta rejected the send (code 999999)' });
  assert.equal(classifyMetaError(null).code, null);
  assert.equal(classifyMetaError(undefined).action, 'unknown');
  assert.equal(classifyMetaError('  ').code, null);
  assert.equal(classifyMetaError(true).code, null);
  assert.equal(classifyMetaError('ECONNRESET').reason, 'Meta rejected the send without a code');
});

test('delivery: the note says what happened and what to do', () => {
  const inbox = deliveryFailureNote(classifyMetaError(131049));
  assert.match(inbox, /^Not delivered: the contact's inbox is full/);
  assert.match(inbox, /resumes when the lead writes again/);
  assert.match(deliveryFailureNote(classifyMetaError(131048)), /do not retry in a loop/);
  const booked = deliveryFailureNote(classifyMetaError(131026), { sent: 1, total: 2, calendarChanged: true });
  assert.match(booked, /1 of 2 messages went out/);
  assert.match(booked, /calendar was already changed/);
  assert.match(booked, /approved template/);
});
