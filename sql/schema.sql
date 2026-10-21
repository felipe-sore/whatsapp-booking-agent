CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  phone       TEXT NOT NULL,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decisions (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  at               TIMESTAMPTZ NOT NULL,
  record           JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_conversation ON decisions (conversation_id, at);

CREATE TABLE IF NOT EXISTS lead_audit (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  type             TEXT NOT NULL,
  field            TEXT,
  old_value        TEXT,
  new_value        TEXT,
  at               TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_replies (
  day    DATE PRIMARY KEY,
  count  INTEGER NOT NULL DEFAULT 0
);
