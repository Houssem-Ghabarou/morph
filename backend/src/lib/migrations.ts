import { query } from './postgres';

export async function runMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS morph_sessions (
      id SERIAL PRIMARY KEY,
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
}
