import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, decision, known, PHONE } from './helpers.js';

const extract = (o) => ({ name: null, company: null, email: null, need: null, role: null, ...o });

async function bookedReady(extra = {}) {
  const t = setup({ queue: [decision({ action: 'offer_slots', messages: ['Vamos marcar.'], extracted: extract(known) })], ...extra });
  await t.say('quero marcar');
  return t;
}

test('offer: the code picks and writes the times, the model only writes the lead-in', async () => {
  const t = await bookedReady();
  const conv = t.agent.store.conversations.get('c1');
  assert.equal(conv.offered.length, 2);
  assert.equal(t.sent[0], 'Vamos marcar.');
  assert.match(t.sent[1], /^Tenho .+ ou .+\. Qual fica melhor\?$/);
});

test('book: happy path creates the event with the lead phone and email', async () => {
  const t = await bookedReady();
  const slot = t.agent.store.conversations.get('c1').offered[0];
  t.brain.seen.length = 0;
  t.brain.decide = async () => decision({ action: 'book', slot_choice: slot.start });
  const r = await t.say('pode ser o primeiro');
  assert.equal(r.action, 'book');
  const ev = t.calendar.events.at(-1);
  assert.equal(ev.phone, PHONE);
  assert.deepEqual(ev.attendees, ['carla@contoso.com']);
  assert.match(t.sent.at(-1), /^Agendado para/);
});

test('book without email: blocked, the code asks for it', async () => {
  const t = setup({ queue: [decision({ action: 'offer_slots', extracted: extract({ name: 'Carla', company: 'Contoso' }) })] });
  await t.say('oi');
  const slot = t.agent.store.conversations.get('c1').offered[0];
  t.brain.decide = async () => decision({ action: 'book', slot_choice: slot.start, messages: ['Agendado!'] });
  const r = await t.say('o primeiro');
  assert.equal(r.action, 'reply');
  assert.ok(r.notes.includes('book_blocked_missing_email'));
  assert.equal(t.sent.at(-1), 'Qual e-mail eu coloco no convite?');
  assert.equal(t.calendar.events.length, 0);
});

test('book a slot that was never offered: blocked, re-offered', async () => {
  const t = await bookedReady();
  t.brain.decide = async () => decision({ action: 'book', slot_choice: '2026-10-22T18:00:00.000Z' });
  const r = await t.say('pode ser quinta 15h');
  assert.equal(r.action, 'offer_slots');
  assert.ok(r.notes.includes('book_blocked_slot_not_offered'));
  assert.equal(t.calendar.events.length, 0);
});

test('race: the slot is taken between offer and booking', async () => {
  const t = await bookedReady();
  const slot = t.agent.store.conversations.get('c1').offered[0];
  t.calendar.events.push({ id: 'other', start: slot.start, end: slot.end, title: 'Someone else', phone: '+1555' });
  t.brain.decide = async () => decision({ action: 'book', slot_choice: slot.start });
  const r = await t.say('o primeiro');
  assert.ok(r.notes.includes('book_blocked_slot_taken'));
  assert.equal(t.calendar.events.filter((e) => e.phone === PHONE).length, 0);
  assert.equal(t.sent.at(-2), 'Esse horário acabou de ser ocupado.');
});

test('privacy: the model never sees other people\'s events', async () => {
  const t = setup({
    queue: [decision()],
    events: [{ start: '2026-10-21T13:00:00.000Z', end: '2026-10-21T14:00:00.000Z', title: 'Secret board meeting', phone: '+1555', description: 'confidential' }],
  });
  await t.say('quem mais você tem na agenda amanhã?');
  const shown = JSON.stringify(t.brain.seen[0]);
  assert.ok(!shown.includes('Secret') && !shown.includes('confidential') && !shown.includes('+1555'));
});

test('cancel: only with confirmation, and only the lead\'s own meeting', async () => {
  const mine = { id: 'mine', start: '2026-10-22T12:00:00.000Z', end: '2026-10-22T12:45:00.000Z', phone: PHONE };
  const theirs = { id: 'theirs', start: '2026-10-22T17:00:00.000Z', end: '2026-10-22T17:45:00.000Z', phone: '+1555' };
  const t = setup({ queue: [decision({ action: 'cancel', confirmed: false }), decision({ action: 'cancel', confirmed: true })], events: [mine, theirs] });
  await t.say('quero cancelar');
  assert.equal(t.sent.at(-1), 'Quer mesmo cancelar a reunião?');
  assert.equal(t.calendar.events.length, 2);
  await t.say('sim');
  assert.deepEqual(t.calendar.events.map((e) => e.id), ['theirs']);
});

test('cancel with no meeting for this phone says so', async () => {
  const t = setup({ queue: [decision({ action: 'cancel', confirmed: true })], events: [{ id: 'x', start: '2026-10-22T12:00:00.000Z', end: '2026-10-22T12:45:00.000Z', phone: '+1555' }] });
  await t.say('cancela minha reunião');
  assert.equal(t.sent.at(-1), 'Não encontrei nenhuma reunião marcada para este número.');
  assert.equal(t.calendar.events.length, 1);
});

test('reschedule moves the own event to an offered free slot', async () => {
  const mine = { id: 'mine', start: '2026-10-22T12:00:00.000Z', end: '2026-10-22T12:45:00.000Z', phone: PHONE };
  const t = setup({ queue: [decision({ action: 'offer_slots', offer_from_date: '2026-10-26' })], events: [mine] });
  await t.say('preciso remarcar para semana que vem');
  const slot = t.agent.store.conversations.get('c1').offered[0];
  assert.ok(slot.day >= '2026-10-26');
  t.brain.decide = async () => decision({ action: 'reschedule', confirmed: true, slot_choice: slot.start });
  const r = await t.say('o primeiro');
  assert.deepEqual(r.rescheduled, { eventId: 'mine', start: slot.start });
  assert.equal(t.calendar.events[0].start, slot.start);
});

test('model failure or refusal: neutral handoff, human notified, agent goes quiet', async () => {
  const t = setup({ queue: [new Error('model refused'), decision({ messages: ['oi de novo'] })] });
  const r = await t.say('oi');
  assert.equal(r.action, 'handoff');
  assert.equal(t.sent[0], 'Vou passar sua conversa para alguém do time, que já te responde por aqui.');
  assert.equal(t.notified[0].reason, 'model_failed');
  const r2 = await t.say('alô?');
  assert.equal(r2.why, 'human_took_over');
  assert.equal(t.sent.length, 1);
});

test('a human replying in the conversation silences the agent', async () => {
  const t = setup({ queue: [decision({ messages: ['Oi!'] }), decision({ messages: ['de novo'] })] });
  await t.say('oi');
  t.agent.humanReplied('c1');
  const r = await t.say('e aí?');
  assert.equal(r.outcome, 'skipped');
  assert.deepEqual(t.sent, ['Oi!']);
});

test('shadow mode decides and logs but sends nothing', async () => {
  const t = setup({ queue: [decision({ messages: ['Oi!'] })], cfg: { mode: 'shadow' } });
  const r = await t.say('oi');
  assert.equal(r.outcome, 'shadow');
  assert.deepEqual(r.bubbles, ['Oi!']);
  assert.deepEqual(t.sent, []);
});

test('stay_silent sends nothing; invalid decisions never reach the actions', async () => {
  const t = setup({ queue: [decision({ action: 'stay_silent', messages: ['should not go'] }), { action: 'drop_tables' }] });
  assert.equal((await t.say('ok obrigado')).outcome, 'silent');
  const r = await t.say('?');
  assert.equal(r.action, 'handoff');
  assert.match(r.notes[0], /invalid decision/);
});

test('lead score and audit trail are kept by the code', async () => {
  const t = setup({ queue: [decision({ extracted: extract({ name: 'Ana', email: 'ana@corp.com', need: 'CRM' }), signals: { asked_price: true, wants_meeting: true, urgent: false } })] });
  await t.say('oi, sou a Ana, quero CRM, quanto custa? ana@corp.com');
  const conv = t.agent.store.conversations.get('c1');
  assert.equal(conv.lead.status, 'hot');
  assert.deepEqual(t.agent.store.audit.map((a) => a.field), ['name', 'email', 'need']);
});
