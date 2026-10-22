import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySignature, parseWebhook, parseEvents, whatsappSender } from '../src/adapters/whatsapp-cloud.js';
import { googleCalendar } from '../src/adapters/google-calendar.js';
import { slackNotifier } from '../src/adapters/slack.js';
import { PostgresStore } from '../src/adapters/postgres-store.js';

const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const recorder = (responder) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url, ...init }); return responder(url, init); };
  return { calls, fetchImpl };
};

test('WhatsApp signature: valid, tampered, missing', () => {
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 'secret').update(body).digest('hex');
  assert.equal(verifySignature(body, sig, 'secret'), true);
  assert.equal(verifySignature(Buffer.from('{"a":2}'), sig, 'secret'), false);
  assert.equal(verifySignature(body, undefined, 'secret'), false);
  assert.equal(verifySignature(body, 'sha256=short', 'secret'), false);
});

test('WhatsApp webhook: text and button replies parsed, statuses ignored', () => {
  const body = { entry: [{ changes: [{ value: {
    metadata: { phone_number_id: '111' },
    messages: [
      { from: '5521999990000', id: 'wamid.1', timestamp: '1760965200', type: 'text', text: { body: 'oi' } },
      { from: '5521999990000', id: 'wamid.2', timestamp: '1760965201', type: 'interactive', interactive: { type: 'button_reply', button_reply: { title: 'Sim' } } },
      { from: '5521999990000', id: 'wamid.3', timestamp: '1760965202', type: 'audio', audio: { id: 'x' } },
    ],
    statuses: [{ id: 'wamid.0', status: 'delivered' }],
  } }] }] };
  const m = parseWebhook(body);
  assert.deepEqual(m.map((x) => [x.phone, x.text]), [['+5521999990000', 'oi'], ['+5521999990000', 'Sim'], ['+5521999990000', '[audio message]']]);
  assert.equal(m[0].phoneNumberId, '111');
  assert.deepEqual(parseWebhook({}), []);
});

test('WhatsApp send: Graph API request shape and error surfacing', async () => {
  const { calls, fetchImpl } = recorder(() => ok({ messages: [{ id: 'wamid.x' }] }));
  await whatsappSender({ token: 'T', phoneNumberId: '111', fetchImpl })({ phone: '+5521999990000', text: 'Oi!' });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/111/messages');
  assert.equal(calls[0].headers.Authorization, 'Bearer T');
  assert.deepEqual(JSON.parse(calls[0].body).text, { body: 'Oi!', preview_url: false });
  assert.equal(JSON.parse(calls[0].body).to, '5521999990000');
  const bad = whatsappSender({ token: 'T', phoneNumberId: '111', fetchImpl: async () => ok({ error: { code: 131047, message: 'Re-engagement message' } }, 400) });
  await assert.rejects(bad({ phone: '+1', text: 'x' }), (err) => err.code === 131047 && err.status === 400 && /131047/.test(err.message));
});

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const creds = { client_email: 'agent@example.iam.gserviceaccount.com', private_key: privateKey };

function googleFake(items) {
  return recorder((url) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) return ok({ access_token: 'AT', expires_in: 3600 });
    if (url.includes('/events') && !url.includes('/events/')) return ok({ items });
    return ok({ id: 'new-id' });
  });
}

test('Google Calendar: signed JWT once, busy without titles, all-day expanded, free/cancelled skipped', async () => {
  const { calls, fetchImpl } = googleFake([
    { start: { dateTime: '2026-10-21T10:00:00-03:00' }, end: { dateTime: '2026-10-21T11:00:00-03:00' }, summary: 'Secret' },
    { start: { date: '2026-10-22' }, end: { date: '2026-10-24' }, summary: 'Offsite' },
    { start: { dateTime: '2026-10-21T15:00:00-03:00' }, end: { dateTime: '2026-10-21T16:00:00-03:00' }, transparency: 'transparent' },
    { start: { dateTime: '2026-10-21T17:00:00-03:00' }, end: { dateTime: '2026-10-21T18:00:00-03:00' }, status: 'cancelled' },
  ]);
  const cal = googleCalendar({ credentials: creds, calendarId: 'team@example.com', fetchImpl, now: () => Date.parse('2026-10-20T13:00:00Z') });
  const busy = await cal.busy('2026-10-20T13:00:00Z', '2026-11-05T00:00:00Z');
  assert.deepEqual(busy, [
    { start: '2026-10-21T13:00:00.000Z', end: '2026-10-21T14:00:00.000Z' },
    { allDay: true, date: '2026-10-22' }, { allDay: true, date: '2026-10-23' },
  ]);
  assert.ok(!JSON.stringify(busy).includes('Secret'));
  const jwt = new URLSearchParams(calls[0].body).get('assertion').split('.');
  assert.equal(JSON.parse(Buffer.from(jwt[1], 'base64url')).iss, creds.client_email);
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${jwt[0]}.${jwt[1]}`).verify(crypto.createPublicKey(privateKey), Buffer.from(jwt[2], 'base64url')));
  await cal.busy('2026-10-20T13:00:00Z', '2026-11-05T00:00:00Z');
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1); // token reused
});

test('Google Calendar: own events filtered server-side by the private phone property; create invites the lead', async () => {
  const { calls, fetchImpl } = googleFake([{ id: 'e1', start: { dateTime: '2026-10-22T09:00:00-03:00' }, end: { dateTime: '2026-10-22T09:45:00-03:00' } }]);
  const cal = googleCalendar({ credentials: creds, calendarId: 'team@example.com', fetchImpl });
  const own = await cal.eventsFor('+5521999990000');
  assert.deepEqual(own, [{ id: 'e1', start: '2026-10-22T12:00:00.000Z', end: '2026-10-22T12:45:00.000Z' }]);
  assert.equal(new URL(calls.at(-1).url).searchParams.get('privateExtendedProperty'), 'leadPhone=+5521999990000');
  await cal.create({ start: 'a', end: 'b', phone: '+5521999990000', title: 'Call', description: 'd', attendees: ['lead@corp.com', null] });
  const req = calls.at(-1);
  assert.equal(new URL(req.url).searchParams.get('sendUpdates'), 'all');
  const body = JSON.parse(req.body);
  assert.deepEqual(body.attendees, [{ email: 'lead@corp.com' }]);
  assert.equal(body.extendedProperties.private.leadPhone, '+5521999990000');
});

test('Slack handoff message', async () => {
  const { calls, fetchImpl } = recorder(() => ok({}));
  await slackNotifier({ webhookUrl: 'https://hooks.slack.com/x', fetchImpl })({ phone: '+55', reason: 'asked_for_human', profile: { name: 'Ana', company: 'Contoso' } });
  assert.match(JSON.parse(calls[0].body).text, /Ana, Contoso \(\+55\)\. Reason: asked_for_human/);
});

test('Postgres store: lead text never enters a SQL string', async () => {
  const queries = [];
  const db = { query: async (text, params) => { queries.push({ text, params }); return { rows: [] }; } };
  const store = new PostgresStore(db);
  const evil = "x'); DROP TABLE conversations; --";
  const conv = await store.conversation('+55', '+55');
  conv.history.push({ role: 'lead', text: evil });
  await store.save(conv);
  await store.logAudit('+55', [{ type: 'field_detected', field: 'name', old: null, new: evil, at: '2026-10-20T13:00:00Z' }]);
  await store.logDecision({ conversationId: '+55', at: '2026-10-20T13:00:00Z', bubbles: [evil] });
  await store.countReply('2026-10-20');
  for (const q of queries) {
    assert.ok(!q.text.includes('DROP TABLE'), q.text);
    assert.ok(/\$1/.test(q.text));
  }
  assert.ok(queries.some((q) => JSON.stringify(q.params).includes('DROP TABLE')));
});

test('Slack: a failed send gets its own alert with the note', async () => {
  const { calls, fetchImpl } = recorder(() => ({ ok: true, status: 200, json: async () => ({}) }));
  await slackNotifier({ webhookUrl: 'https://hooks.slack.com/x', fetchImpl })({ kind: 'delivery', phone: '+55', note: 'Not delivered: x.', profile: { name: 'Ana' } });
  const text = JSON.parse(calls[0].body).text;
  assert.match(text, /not delivered: Ana \(\+55\)\. Not delivered: x\./);
  assert.doesNotMatch(text, /now silent/);
});

test('WhatsApp webhook: failed statuses are surfaced, the others ignored', () => {
  const body = { entry: [{ changes: [{ value: { statuses: [
    { id: 'wamid.1', status: 'delivered', recipient_id: '5521999990000' },
    { id: 'wamid.2', status: 'failed', recipient_id: '5521999990000', errors: [{ code: 131026, title: 'Message undeliverable' }] },
  ] } }] }] };
  const { messages, failures } = parseEvents(body);
  assert.deepEqual(messages, []);
  assert.deepEqual(failures, [{ messageId: 'wamid.2', phone: '+5521999990000', code: 131026, detail: 'Message undeliverable' }]);
});

test('Slack: an agent failure and a conversation limit get their own alerts', async () => {
  const { calls, fetchImpl } = recorder(() => ({ ok: true, status: 200, json: async () => ({}) }));
  const notify = slackNotifier({ webhookUrl: 'https://hooks.slack.com/x', fetchImpl });
  await notify({ kind: 'error', phone: '+55', note: 'Error: HTTP 503.', profile: { name: 'Ana' } });
  await notify({ kind: 'limit', phone: '+55', profile: {} });
  const [error, limit] = calls.map((c) => JSON.parse(c.body).text);
  assert.match(error, /could not answer Ana \(\+55\)\. The message is saved; reply by hand\. Error: HTTP 503\./);
  assert.match(limit, /unknown lead \(\+55\) reached the daily reply limit/);
});
