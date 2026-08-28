import { DATABASE_SCHEMA_VERSION } from './constants.js';
export function applyAuthMigrations(database) {
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, display_name TEXT, email TEXT, avatar_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS external_identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (issuer, subject));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id); PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};`);
}
