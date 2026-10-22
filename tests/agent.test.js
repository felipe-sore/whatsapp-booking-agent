import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, decision, known, PHONE, NOW } from './helpers.js';

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
  await t.agent.humanReplied('c1');
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

test('shadow mode never writes to the calendar or pings the team', async () => {
  const t = setup({ queue: [decision({ action: 'offer_slots', extracted: extract(known) })], cfg: { mode: 'shadow' } });
  await t.say('quero marcar');
  const slot = t.agent.store.conversations.get('c1').offered[0];
  t.brain.decide = async () => decision({ action: 'book', slot_choice: slot.start });
  const r = await t.say('pode ser o primeiro');
  assert.equal(r.outcome, 'shadow');
  assert.deepEqual(r.booked, { eventId: 'shadow', start: slot.start });
  assert.ok(r.notes.includes('shadow_calendar_not_written'));
  assert.equal(t.calendar.events.length, 0);
  assert.deepEqual(t.sent, []);
});

test('two bursts at the same time are handled one after the other: one booking', async () => {
  const t = await bookedReady();
  const slot = t.agent.store.conversations.get('c1').offered[0];
  t.brain.decide = async () => {
    await new Promise((r) => setTimeout(r, 20));
    return decision({ action: 'book', slot_choice: slot.start });
  };
  await Promise.all([t.say('sim, o primeiro'), t.say('meu email é carla@contoso.com')]);
  assert.equal(t.calendar.events.length, 1);
  assert.equal(t.agent.store.conversations.get('c1').history.filter((h) => h.role === 'lead').length, 3);
});

test('a human who replies while the bot is thinking wins: nothing is sent', async () => {
  let human;
  const t = setup({ queue: [async () => { human = t.agent.humanReplied('c1'); return decision({ messages: ['Oi!'] }); }] });
  const r = await t.say('oi');
  assert.equal(await human, true);
  assert.equal(r.outcome, 'human_took_over');
  assert.deepEqual(t.sent, []);
  assert.equal(t.agent.store.conversations.get('c1').state, 'human');
});

test('an offered slot that went stale is not booked', async () => {
  let now = NOW;
  const t = setup({ queue: [decision({ action: 'offer_slots', extracted: extract(known) })], clock: () => now });
  await t.say('quero marcar');
  const slot = t.agent.store.conversations.get('c1').offered[0];
  now = new Date(Date.parse(slot.start) + 86400000);
  t.brain.decide = async () => decision({ action: 'book', slot_choice: slot.start });
  const r = await t.say('pode ser o primeiro');
  assert.ok(r.notes.includes('book_blocked_slot_expired'));
  assert.equal(r.action, 'offer_slots');
  assert.equal(t.calendar.events.length, 0);
});

const metaError = (code) => Object.assign(new Error(`WhatsApp send failed: ${code}`), { code });

// A sender that delivers the first `after` messages, then fails with a Meta error code.
function failingSend(code, { after = 0 } = {}) {
  let n = 0;
  return async (m, sent) => { if (n++ >= after) throw metaError(code); sent.push(m.text); };
}

test('send failure: a transient error is logged, the team is not bothered', async () => {
  const t = setup({ queue: [decision({ messages: ['Oi!'] })], send: failingSend(131049) });
  const r = await t.say('oi');
  assert.equal(r.outcome, 'send_failed');
  assert.equal(r.delivery.action, 'retry_fast');
  assert.match(r.delivery.note, /inbox is full/);
  assert.deepEqual(t.notified, []);
  assert.equal(t.agent.store.conversations.get('c1').history.filter((h) => h.role === 'agent').length, 0);
});

test('send failure: a permanent error alerts the team with the reason', async () => {
  const t = setup({ queue: [decision({ messages: ['Oi!'] })], send: failingSend(131047) });
  const r = await t.say('oi');
  assert.equal(r.delivery.action, 'permanent');
  assert.equal(t.notified[0].reason, 'delivery_failed');
  assert.match(t.notified[0].note, /outside the 24h window/);
});

test('send failure after booking: the team hears about it even when the error is transient', async () => {
  const t = await bookedReady({ send: failingSend(131000, { after: 2 }) });
  assert.equal(t.sent.length, 2);
  const slot = t.agent.store.conversations.get('c1').offered[0];
  t.brain.decide = async () => decision({ action: 'book', slot_choice: slot.start });
  const r = await t.say('o primeiro');
  assert.equal(r.outcome, 'send_failed');
  assert.equal(t.calendar.events.length, 1);
  assert.equal(t.agent.store.conversations.get('c1').state, 'booked');
  assert.match(t.notified.at(-1).note, /calendar was already changed, but the lead was not told/);
});

test('send failure midway: only what went out goes to the history', async () => {
  const t = setup({ queue: [decision({ action: 'offer_slots', messages: ['Vamos marcar.'], extracted: extract({}) })], send: failingSend(131026, { after: 1 }) });
  const r = await t.say('quero marcar');
  assert.equal(r.delivery.sent, 1);
  assert.deepEqual(t.agent.store.conversations.get('c1').history.filter((h) => h.role === 'agent').map((h) => h.text), ['Vamos marcar.']);
  assert.match(t.notified[0].note, /1 of 2 messages went out/);
});
