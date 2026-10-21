import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeBrain, toMessages } from '../src/brain/claude.js';
import { DECISION_SCHEMA } from '../src/decision.js';
import { decision } from './helpers.js';

const fakeClient = (response) => {
  const calls = [];
  return { calls, beta: { messages: { create: async (req) => { calls.push(req); return response; } } } };
};

test('history becomes alternating turns, context rides on the last user message', () => {
  const m = toMessages([
    { role: 'agent', text: 'Oi! Vi que você se cadastrou.' },
    { role: 'lead', text: 'oi' }, { role: 'lead', text: 'tudo bem?' },
    { role: 'agent', text: 'Tudo!' }, { role: 'lead', text: 'quero marcar' },
  ], '<context>x</context>');
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(m[2].content, 'oi\ntudo bem?');
  assert.match(m.at(-1).content, /^<context>x<\/context>[\s\S]*quero marcar$/);
});

test('request: current model, cached system prompt, JSON schema, server-side fallback', async () => {
  const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(decision()) }] });
  const out = await claudeBrain({ client }).decide({ system: 'SYS', history: [{ role: 'lead', text: 'oi' }], context: '<context/>' });
  assert.equal(out.action, 'reply');
  const req = client.calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(req.output_config.format, { type: 'json_schema', schema: DECISION_SCHEMA });
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
});

test('refusal and truncation throw, so the agent hands over', async () => {
  await assert.rejects(claudeBrain({ client: fakeClient({ stop_reason: 'refusal', content: [] }) }).decide({ system: '', history: [], context: '' }), /refused/);
  await assert.rejects(claudeBrain({ client: fakeClient({ stop_reason: 'max_tokens', content: [] }) }).decide({ system: '', history: [], context: '' }), /truncated/);
});
