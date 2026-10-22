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
  if (conversationReplies(conv, dayKey(now, cfg)) >= cfg.conversationDailyCap) return { ok: false, defer: 'conversation_daily_cap' };
  if (repliesToday >= cfg.dailyCap) return { ok: false, defer: 'daily_cap' };
  return { ok: true };
}

export function dayKey(now, cfg) {
  return localDate(now, cfg.timezone);
}

// Replies sent today in this conversation. Kept on the conversation itself, so
// it needs no extra table and resets when the day changes.
export function conversationReplies(conv, day) {
  return conv.replies?.day === day ? conv.replies.count : 0;
}

export function countConversationReply(conv, day) {
  conv.replies = conv.replies?.day === day ? { ...conv.replies, count: conv.replies.count + 1 } : { day, count: 1 };
}
