import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeMessages, splitBubble, mentionedTimes } from '../src/messages.js';
import { mergeProfile, score, missingFields } from '../src/lead.js';
import { checkGates } from '../src/gates.js';
import { MessageBuffer } from '../src/buffer.js';
import { validateDecision } from '../src/decision.js';
import { defaultConfig as cfg } from '../src/config.js';
import { NOW, decision } from './helpers.js';

test('times are recognized in common formats', () => {
  assert.deepEqual(mentionedTimes('às 15:00 ou 9h ou 10h30'), ['15:00', '09:00', '10:30']);
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
