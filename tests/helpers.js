import { createAgent } from '../src/agent.js';
import { MemoryCalendar } from '../src/adapters/memory-calendar.js';

export const NOW = new Date('2026-10-20T13:00:00Z'); // Tuesday 10:00 in Sao Paulo
export const PHONE = '+5521999990000';

export const decision = (over = {}) => ({
  action: 'reply', messages: [], slot_choice: null, offer_from_date: null, confirmed: false, handoff_reason: null, reason: 'test',
  extracted: { name: null, company: null, email: null, need: null, role: null },
  signals: { asked_price: false, wants_meeting: false, urgent: false },
  ...over,
});

// A brain that returns queued decisions and records what it was shown.
export function stubBrain(queue) {
  const seen = [];
  return {
    seen,
    async decide(input) {
      seen.push(input);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(input) : next;
    },
  };
}

export function setup({ queue = [], events = [], cfg = {}, clock = () => NOW } = {}) {
  const calendar = new MemoryCalendar(events);
  const brain = stubBrain(queue);
  const sent = [];
  const notified = [];
  const agent = createAgent({
    cfg, brain, calendar, clock,
    send: async (m) => sent.push(m.text), notify: async (n) => notified.push(n),
  });
  const say = (text) => agent.handle({ conversationId: 'c1', phone: PHONE, texts: [text] });
  return { agent, calendar, brain, sent, notified, say };
}

export const known = { name: 'Carla', company: 'Contoso', email: 'carla@contoso.com', need: 'CRM setup' };
