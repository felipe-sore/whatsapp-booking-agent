import { zonedParts, localDate } from './time.js';

// Should the agent answer this conversation right now?
// skip  = never answer this message.
// defer = answer later (outside reply hours, daily cap reached).
export function checkGates(conv, cfg, now, repliesToday) {
  if (!cfg.enabled) return { ok: false, skip: 'disabled' };
  if (conv.state === 'human') return { ok: false, skip: 'human_took_over' };
  if (conv.state === 'booked' && cfg.stopAfterBooking) return { ok: false, skip: 'already_booked' };
  if ((conv.labels || []).some((l) => cfg.stopLabels.includes(l))) return { ok: false, skip: 'stop_label' };
  if (cfg.canaryConversations.length && !cfg.canaryConversations.includes(conv.id)) return { ok: false, skip: 'not_canary' };
  const hour = zonedParts(now, cfg.timezone).hour;
  if (hour < cfg.replyHours.start || hour >= cfg.replyHours.end) return { ok: false, defer: 'outside_reply_hours' };
  if (repliesToday >= cfg.dailyCap) return { ok: false, defer: 'daily_cap' };
  return { ok: true };
}

export function dayKey(now, cfg) {
  return localDate(now, cfg.timezone);
}
