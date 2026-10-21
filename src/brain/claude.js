import Anthropic from '@anthropic-ai/sdk';
import { DECISION_SCHEMA } from '../decision.js';

// The model behind the agent. One call per turn, JSON out, nothing else.
//
// - The system prompt is static and cached; the per-turn context rides on the
//   last user message, so the cached prefix never changes.
// - Structured outputs constrain the reply to DECISION_SCHEMA; src/decision.js
//   validates it again anyway.
// - Server-side fallback ("default") re-runs a declined request on another
//   model; a final refusal throws, and the agent hands over to a human.

export function toMessages(history, context) {
  const msgs = [];
  for (const h of history) {
    const role = h.role === 'lead' ? 'user' : 'assistant';
    const last = msgs.at(-1);
    if (last && last.role === role) last.content += `\n${h.text}`;
    else msgs.push({ role, content: h.text });
  }
  if (!msgs.length || msgs.at(-1).role !== 'user') msgs.push({ role: 'user', content: '(no new message)' });
  if (msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: '(conversation started by the business)' });
  msgs.at(-1).content = `${context}\n\nLatest message(s) from the person:\n${msgs.at(-1).content}`;
  return msgs;
}

export function claudeBrain({
  client = new Anthropic(),
  model = process.env.BOOKING_AGENT_MODEL || 'claude-opus-5-5',
  effort = process.env.BOOKING_AGENT_EFFORT || 'low',
} = {}) {
  return {
    async decide({ system, history, context }) {
      const res = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        output_config: { effort, format: { type: 'json_schema', schema: DECISION_SCHEMA } },
        messages: toMessages(history, context),
      });
      if (res.stop_reason === 'refusal') throw new Error('model refused');
      if (res.stop_reason === 'max_tokens') throw new Error('model output truncated');
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return JSON.parse(text);
    },
  };
}
