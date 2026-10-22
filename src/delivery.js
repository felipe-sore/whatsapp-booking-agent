// What a failed send means, from the Meta WhatsApp Cloud API error code.
// Ported from the outbound sender I run in production, where it decides what
// happens to every failed message.
//
// action:
//   'retry_fast'  transient or on the recipient's side; trying again later works
//   'retry_slow'  low phone number reputation; retrying fast makes it worse
//   'permanent'   broken template, wrong number or account problem; retrying never works
//   'unknown'     unmapped code; treated as permanent (conservative)
//
// Two codes look like the opposite of what they are: 131049 (the contact's
// inbox is full) reads as final but clears on its own, and 131048 (low
// reputation) reads as temporary but every fast retry digs the hole deeper.
//
// reason is always written for a human: it goes to the decision log and to the
// team alert, so whoever reads it knows why the message did not arrive.

const MAP = {
  131049: { action: 'retry_fast', reason: "the contact's inbox is full (Meta marketing limit, on their side)" },
  131048: { action: 'retry_slow', reason: 'the phone number reputation is low and Meta is holding sends' },
  131056: { action: 'retry_fast', reason: 'too many messages to this contact in a short time' },
  130429: { action: 'retry_fast', reason: 'Meta API rate limit reached' },
  80007: { action: 'retry_fast', reason: 'Meta API rate limit reached' },
  131000: { action: 'retry_fast', reason: 'temporary Meta error' },

  131026: { action: 'permanent', reason: 'the number has no WhatsApp, blocked the business, or cannot receive' },
  132000: { action: 'permanent', reason: 'the template has the wrong number of parameters' },
  132001: { action: 'permanent', reason: 'the template does not exist or was removed' },
  132005: { action: 'permanent', reason: 'the template text changed and needs new approval' },
  132007: { action: 'permanent', reason: 'the template content violates Meta policies' },
  132012: { action: 'permanent', reason: 'the template is paused or disabled by Meta' },
  132015: { action: 'permanent', reason: 'the template is paused or disabled by Meta' },
  132016: { action: 'permanent', reason: 'the template is paused or disabled by Meta' },
  131047: { action: 'permanent', reason: 'free-form text sent outside the 24h window' },
  131045: { action: 'permanent', reason: 'phone number certificate problem' },
  131031: { action: 'permanent', reason: 'parameter or permission error in the call' },
  100: { action: 'permanent', reason: 'parameter or permission error in the call' },
  10: { action: 'permanent', reason: 'parameter or permission error in the call' },
};

export function classifyMetaError(code) {
  const n = code === null || code === undefined || code === '' ? NaN : Number(code);
  if (Number.isFinite(n)) {
    if (MAP[n]) return { code: n, ...MAP[n] };
    // 133xxx = account or phone number registration problem.
    if (n >= 133000 && n < 134000) {
      return { code: n, action: 'permanent', reason: 'the account or phone number registration has a problem, check WhatsApp Manager' };
    }
  }
  return {
    code: Number.isFinite(n) ? n : null,
    action: 'unknown',
    reason: Number.isFinite(n) ? `Meta rejected the send (code ${n})` : 'Meta rejected the send without a code',
  };
}

export const isTransient = (cls) => cls.action === 'retry_fast' || cls.action === 'retry_slow';

// Ready-to-read note for the team. The agent only answers inside a live
// conversation, so it never retries on its own: a transient failure clears
// when the lead writes again, a permanent one needs a person.
export function deliveryFailureNote(cls, { sent = 0, total = 0, calendarChanged = false } = {}) {
  const parts = [`Not delivered: ${cls.reason}.`];
  if (total > 1) parts.push(`${sent} of ${total} messages went out.`);
  if (calendarChanged) parts.push('The calendar was already changed, but the lead was not told.');
  if (cls.action === 'retry_slow') parts.push('Slow down sends from this number; do not retry in a loop.');
  else if (isTransient(cls)) parts.push('Temporary: the conversation resumes when the lead writes again.');
  else parts.push('Decide how to proceed (reach out with an approved template, another channel, or lost).');
  return parts.join(' ');
}
