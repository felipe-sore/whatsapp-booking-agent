// The only thing the model returns. It proposes; src/agent.js decides.

export const ACTIONS = ['reply', 'offer_slots', 'book', 'reschedule', 'cancel', 'handoff', 'stay_silent'];

const nullableString = { type: ['string', 'null'] };

export const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'messages', 'extracted', 'signals', 'slot_choice', 'offer_from_date', 'confirmed', 'handoff_reason', 'reason'],
  properties: {
    action: { type: 'string', enum: ACTIONS },
    messages: { type: 'array', items: { type: 'string' } },
    extracted: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'company', 'email', 'need', 'role'],
      properties: { name: nullableString, company: nullableString, email: nullableString, need: nullableString, role: nullableString },
    },
    signals: {
      type: 'object',
      additionalProperties: false,
      required: ['asked_price', 'wants_meeting', 'urgent'],
      properties: { asked_price: { type: 'boolean' }, wants_meeting: { type: 'boolean' }, urgent: { type: 'boolean' } },
    },
    slot_choice: { ...nullableString, description: 'start of one of the OFFERED slots, copied exactly' },
    offer_from_date: { ...nullableString, description: 'YYYY-MM-DD, earliest day the lead wants' },
    confirmed: { type: 'boolean', description: 'the lead explicitly confirmed this cancel or reschedule' },
    handoff_reason: nullableString,
    reason: { type: 'string', description: 'one line: why this action' },
  },
};

// Hand-written check: a malformed decision never reaches the actions.
export function validateDecision(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (!ACTIONS.includes(d.action)) errors.push(`unknown action ${d.action}`);
  if (!Array.isArray(d.messages) || d.messages.some((m) => typeof m !== 'string')) errors.push('messages must be strings');
  if (!d.extracted || typeof d.extracted !== 'object') errors.push('extracted missing');
  if (d.offer_from_date && !/^\d{4}-\d{2}-\d{2}$/.test(d.offer_from_date)) errors.push('offer_from_date format');
  return errors;
}
