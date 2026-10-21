// Postgres store. Every value goes through a query parameter ($1, $2...):
// text written by a lead never becomes part of a SQL string.
// `db` is anything with query(text, params): a pg Pool or Client.

const fresh = (id, phone) => ({ id, phone, state: 'active', labels: [], history: [], profile: {}, signals: {}, offered: [], eventId: null });

export class PostgresStore {
  constructor(db) { this.db = db; }

  async get(id) {
    const r = await this.db.query('SELECT data FROM conversations WHERE id = $1', [id]);
    return r.rows[0]?.data || null;
  }

  async conversation(id, phone) {
    return (await this.get(id)) || fresh(id, phone);
  }

  async save(conv) {
    await this.db.query(
      `INSERT INTO conversations (id, phone, data, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [conv.id, conv.phone, JSON.stringify(conv)],
    );
  }

  async logDecision(record) {
    await this.db.query('INSERT INTO decisions (conversation_id, at, record) VALUES ($1, $2, $3)', [record.conversationId, record.at, JSON.stringify(record)]);
  }

  async logAudit(conversationId, events) {
    for (const e of events) {
      await this.db.query(
        'INSERT INTO lead_audit (conversation_id, type, field, old_value, new_value, at) VALUES ($1, $2, $3, $4, $5, $6)',
        [conversationId, e.type, e.field, e.old ?? null, e.new ?? e.value ?? null, e.at],
      );
    }
  }

  async repliesOn(day) {
    const r = await this.db.query('SELECT count FROM daily_replies WHERE day = $1', [day]);
    return r.rows[0]?.count || 0;
  }

  async countReply(day) {
    await this.db.query(
      'INSERT INTO daily_replies (day, count) VALUES ($1, 1) ON CONFLICT (day) DO UPDATE SET count = daily_replies.count + 1',
      [day],
    );
  }
}
