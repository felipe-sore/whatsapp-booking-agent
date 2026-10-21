import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';
import { createAgent } from '../src/agent.js';
import { scriptedBrain } from '../src/brain/scripted.js';
import { MemoryCalendar } from '../src/adapters/memory-calendar.js';
import { NOW } from './helpers.js';

async function start({ quietMs = 10 } = {}) {
  const sent = [];
  const agent = createAgent({ brain: scriptedBrain(), calendar: new MemoryCalendar(), clock: () => NOW, send: async (m) => sent.push(m) });
  const { server, buffer } = createServer({ agent, verifyToken: 'VT', appSecret: 'AS', adminToken: 'ADM', quietMs, log: { error: () => {} } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // fetch keeps connections alive; close them or the test process never exits.
  const stop = () => { server.closeAllConnections(); server.close(); };
  return { server, buffer, agent, sent, base, stop };
}

const payload = (id, text) => JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '111' }, messages: [{ from: '5521999990000', id, timestamp: '1', type: 'text', text: { body: text } }] } }] }] });
const sign = (body) => 'sha256=' + crypto.createHmac('sha256', 'AS').update(body).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('subscription check', async (tt) => {
  const t = await start();
  tt.after(t.stop);
  assert.equal(await (await fetch(`${t.base}/webhook?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=42`)).text(), '42');
  assert.equal((await fetch(`${t.base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`)).status, 403);
});

test('unsigned or tampered webhooks are rejected and never reach the agent', async (tt) => {
  const t = await start();
  tt.after(t.stop);
  const body = payload('w1', 'oi');
  assert.equal((await fetch(`${t.base}/webhook`, { method: 'POST', body })).status, 401);
  assert.equal((await fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(payload('w1', 'other')) } })).status, 401);
  await wait(50);
  assert.equal(t.sent.length, 0);
});

test('signed burst: answered once, duplicates ignored', async (tt) => {
  const t = await start({ quietMs: 300 }); // wider than the gap between test requests
  tt.after(t.stop);
  for (const [id, text] of [['w1', 'Oi, quero organizar o processo de vendas'], ['w1', 'Oi, quero organizar o processo de vendas'], ['w2', 'da minha empresa']]) {
    const body = payload(id, text);
    assert.equal((await fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } })).status, 200);
  }
  await wait(600);
  const conv = await t.agent.store.get('+5521999990000');
  assert.deepEqual(conv.history.filter((h) => h.role === 'lead').map((h) => h.text), ['Oi, quero organizar o processo de vendas', 'da minha empresa']);
  assert.equal(t.agent.store.decisions.length, 1);
  assert.ok(t.sent.length >= 1);
});

test('admin endpoint silences the agent; needs the token', async (tt) => {
  const t = await start();
  tt.after(t.stop);
  const body = payload('w9', 'oi');
  await fetch(`${t.base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } });
  await wait(60);
  const url = `${t.base}/conversations/${encodeURIComponent('+5521999990000')}/human`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ADM' } })).status, 200);
  assert.equal((await t.agent.store.get('+5521999990000')).state, 'human');
});
