import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';
import { createAgent } from '../src/agent.js';
import { scriptedBrain } from '../src/brain/scripted.js';
import { MemoryCalendar } from '../src/adapters/memory-calendar.js';
import { NOW } from './helpers.js';

async function start() {
  const sent = [];
  const agent = createAgent({ brain: scriptedBrain(), calendar: new MemoryCalendar(), clock: () => NOW, send: async (m) => sent.push(m) });
  const { server, buffer } = createServer({ agent, verifyToken: 'VT', appSecret: 'AS', adminToken: 'ADM', quietMs: 10, log: { error: () => {} } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, buffer, agent, sent, base };
}

const payload = (id, text) => JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '111' }, messages: [{ from: '5521999990000', id, timestamp: '1', type: 'text', text: { body: text } }] } }] }] });
const sign = (body) => 'sha256=' + crypto.createHmac('sha256', 'AS').update(body).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('subscription check', async () => {
  const t = await start();
  assert.equal(await (await fetch(`${t.base}/webhook?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=42`)).text(), '42');
  assert.equal((await fetch(`${t.base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status, 403);
  t.server.close();
});

test('unsigned or tampered webhooks are rejected and never reach the agent', async () => {
  const t = await start();
  const body = payload('w1', 'oi');
  assert.equal((await fetch(`${t.base}/webhook`, { method: 'POST', body })).status, 401);
  assert.equal((await fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(payload('w1', 'other')) } })).status, 401);
  await wait(50);
  assert.equal(t.sent.length, 0);
  t.server.close();
});

test('signed burst: answered once, duplicates ignored', async () => {
  const t = await start();
  for (const [id, text] of [['w1', 'Oi, quero organizar o processo de vendas'], ['w1', 'Oi, quero organizar o processo de vendas'], ['w2', 'da minha empresa']]) {
    const body = payload(id, text);
    assert.equal((await fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } })).status, 200);
  }
  await wait(100);
  const conv = await t.agent.store.get('+5521999990000');
  assert.deepEqual(conv.history.filter((h) => h.role === 'lead').map((h) => h.text), ['Oi, quero organizar o processo de vendas', 'da minha empresa']);
  assert.equal(t.agent.store.decisions.length, 1);
  assert.ok(t.sent.length >= 1);
  t.server.close();
});

test('admin endpoint silences the agent; needs the token', async () => {
  const t = await start();
  const body = payload('w9', 'oi');
  await fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } });
  await wait(60);
  const url = `${t.base}/conversations/${encodeURIComponent('+5521999990000')}/human`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ADM' } })).status, 200);
  assert.equal((await t.agent.store.get('+5521999990000')).state, 'human');
  t.server.close();
});
