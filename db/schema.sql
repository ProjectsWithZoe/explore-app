-- WalkExplore schema. Safe to re-run: every statement is idempotent.

CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  pin_hash        TEXT NOT NULL,
  pin_salt        TEXT NOT NULL,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session tokens are stored as SHA-256 hashes; the raw token only lives on the device.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS profiles (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  weight_kg  REAL CHECK (weight_kg IS NULL OR (weight_kg >= 25 AND weight_kg <= 300)),
  unit       TEXT NOT NULL DEFAULT 'kg' CHECK (unit IN ('kg', 'lb')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS walks (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  saved           BOOLEAN NOT NULL DEFAULT false,
  distance_km     REAL NOT NULL DEFAULT 0,
  duration_min    REAL NOT NULL DEFAULT 0,
  estimated_steps INT NOT NULL DEFAULT 0,
  points          JSONB NOT NULL DEFAULT '[]',
  geometry        JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS walks_user_idx ON walks (user_id, (COALESCE(completed_at, created_at)) DESC);

-- Per-IP counters for rate limiting sign-ups and failed sign-ins.
CREATE TABLE IF NOT EXISTS rate_events (
  id   BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  ip   TEXT NOT NULL,
  at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_events_lookup_idx ON rate_events (kind, ip, at);
