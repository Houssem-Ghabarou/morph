import { query } from './postgres';

export async function runMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS morph_users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS morph_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES morph_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'New Chat',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS morph_messages (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES morph_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'system')),
      text TEXT NOT NULL,
      warning BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS morph_session_tables (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES morph_sessions(id) ON DELETE CASCADE,
      table_name TEXT NOT NULL,
      pos_x FLOAT NOT NULL DEFAULT 80,
      pos_y FLOAT NOT NULL DEFAULT 80,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(session_id, table_name)
    )
  `);

  // Add column_sources if it doesn't exist yet
  await query(`
    ALTER TABLE morph_session_tables
    ADD COLUMN IF NOT EXISTS column_sources JSONB DEFAULT NULL
  `);

  // Add user_id to existing sessions table if not present
  await query(`
    ALTER TABLE morph_sessions
    ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES morph_users(id) ON DELETE CASCADE
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS morph_connections (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES morph_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      database_name TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      ssl BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Drop old restrictive type check — may have been created before mongodb was supported
  await query(`
    ALTER TABLE morph_connections
    DROP CONSTRAINT IF EXISTS morph_connections_type_check
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS morph_session_connections (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES morph_sessions(id) ON DELETE CASCADE,
      connection_id INTEGER NOT NULL REFERENCES morph_connections(id) ON DELETE CASCADE,
      imported_tables TEXT[] NOT NULL DEFAULT '{}',
      auto_sync_minutes INTEGER DEFAULT NULL,
      last_synced_at TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(session_id, connection_id)
    )
  `);

  // ─── Automation engine ──────────────────────────────────────────────────────

  // Per-user email/SMTP configuration. One row per user.
  await query(`
    CREATE TABLE IF NOT EXISTS morph_smtp_settings (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES morph_users(id) ON DELETE CASCADE,
      provider     TEXT NOT NULL DEFAULT 'smtp',
      host         TEXT,
      port         INTEGER,
      secure       BOOLEAN DEFAULT FALSE,
      smtp_user    TEXT,
      smtp_pass    TEXT,
      from_name    TEXT,
      from_email   TEXT,
      api_key      TEXT,
      created_at   TIMESTAMP DEFAULT NOW(),
      updated_at   TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id)
    )
  `);

  // Automation definitions. trigger_config / action_config are type-specific JSON.
  await query(`
    CREATE TABLE IF NOT EXISTS morph_automations (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER NOT NULL REFERENCES morph_users(id) ON DELETE CASCADE,
      session_id     INTEGER REFERENCES morph_sessions(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      description    TEXT,
      enabled        BOOLEAN DEFAULT TRUE,
      trigger_type   TEXT NOT NULL,
      trigger_config JSONB NOT NULL DEFAULT '{}',
      source_table   TEXT,
      query_sql      TEXT,
      condition_expr TEXT,
      action_type    TEXT NOT NULL DEFAULT 'send_email',
      action_config  JSONB NOT NULL DEFAULT '{}',
      cooldown_minutes INTEGER,
      last_run_at    TIMESTAMP,
      last_fired_at  TIMESTAMP,
      next_run_at    TIMESTAMP,
      run_count      INTEGER DEFAULT 0,
      created_at     TIMESTAMP DEFAULT NOW(),
      updated_at     TIMESTAMP DEFAULT NOW()
    )
  `);

  // Floating sticky notes pinned to the canvas, per session.
  await query(`
    CREATE TABLE IF NOT EXISTS morph_session_notes (
      id          SERIAL PRIMARY KEY,
      session_id  INTEGER NOT NULL REFERENCES morph_sessions(id) ON DELETE CASCADE,
      content     TEXT NOT NULL DEFAULT '',
      color       TEXT NOT NULL DEFAULT 'yellow',
      pos_x       FLOAT NOT NULL DEFAULT 120,
      pos_y       FLOAT NOT NULL DEFAULT 120,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    )
  `);

  // Execution log — every run is recorded regardless of outcome (audit-first).
  await query(`
    CREATE TABLE IF NOT EXISTS morph_automation_runs (
      id             SERIAL PRIMARY KEY,
      automation_id  INTEGER NOT NULL REFERENCES morph_automations(id) ON DELETE CASCADE,
      status         TEXT NOT NULL,
      trigger_reason TEXT,
      rows_affected  INTEGER,
      action_result  TEXT,
      error_message  TEXT,
      duration_ms    INTEGER,
      executed_at    TIMESTAMP DEFAULT NOW()
    )
  `);
}
