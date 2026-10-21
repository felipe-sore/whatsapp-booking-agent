// People type in bursts: "oi" / "tudo bem?" / "queria saber do preço".
// The buffer waits for a quiet period and hands the burst over as one turn.
// Duplicate webhook deliveries (same message id) are ignored.

export class MessageBuffer {
  constructor({ quietMs = 8000, onFlush, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { quietMs, onFlush, setTimer, clearTimer });
    this.pending = new Map();
    this.seen = new Set();
  }

  push({ conversationId, phone, messageId, text }) {
    if (messageId && this.seen.has(messageId)) return false;
    if (messageId) this.seen.add(messageId);
    const p = this.pending.get(conversationId) || { phone, texts: [], timer: null };
    p.texts.push(text);
    if (p.timer) this.clearTimer(p.timer);
    p.timer = this.setTimer(() => this.flush(conversationId), this.quietMs);
    this.pending.set(conversationId, p);
    return true;
  }

  async flush(conversationId) {
    const p = this.pending.get(conversationId);
    if (!p) return null;
    this.pending.delete(conversationId);
    return this.onFlush({ conversationId, phone: p.phone, texts: p.texts });
  }
}
