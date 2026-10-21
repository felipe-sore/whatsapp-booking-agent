// In-memory state. Swap for a database in production: the agent only uses
// these methods.

export class MemoryStore {
  constructor() {
    this.conversations = new Map();
    this.decisions = [];
    this.audit = [];
    this.replies = new Map();
  }

  conversation(id, phone) {
    if (!this.conversations.has(id)) {
      this.conversations.set(id, { id, phone, state: 'active', labels: [], history: [], profile: {}, signals: {}, offered: [], eventId: null });
    }
    return this.conversations.get(id);
  }

  get(id) { return this.conversations.get(id) || null; }
  save() {}
  logDecision(record) { this.decisions.push(record); }
  logAudit(convId, events) { for (const e of events) this.audit.push({ convId, ...e }); }
  repliesOn(day) { return this.replies.get(day) || 0; }
  countReply(day) { this.replies.set(day, this.repliesOn(day) + 1); }
}
