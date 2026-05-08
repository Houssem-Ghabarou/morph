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
}
