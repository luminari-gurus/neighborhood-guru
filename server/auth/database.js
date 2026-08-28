import { DATABASE_SCHEMA_VERSION } from './constants.js';

const MIGRATIONS = new Map([
  [0, `
    CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, email TEXT, avatar_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE external_identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (issuer, subject));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL);
    CREATE INDEX sessions_user_id_idx ON sessions(user_id);
  `],
  [1, `
    CREATE TABLE login_transactions (
      id TEXT PRIMARY KEY,
      state_hash TEXT NOT NULL UNIQUE,
      provider_id TEXT NOT NULL,
      return_path TEXT NOT NULL,
      adapter_context TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX login_transactions_expires_at_idx ON login_transactions(expires_at);
  `],
]);

const REQUIRED = Object.freeze({
  users: ['id', 'display_name', 'email', 'avatar_url', 'created_at', 'updated_at'],
  external_identities: ['id', 'user_id', 'issuer', 'subject', 'created_at', 'updated_at'],
  sessions: ['id', 'user_id', 'token_hash', 'csrf_hash', 'expires_at', 'revoked_at', 'created_at'],
  login_transactions: ['id', 'state_hash', 'provider_id', 'return_path', 'adapter_context', 'created_at', 'expires_at', 'consumed_at'],
});

function verifySchema(database) {
  for (const [table, columns] of Object.entries(REQUIRED)) {
    const actual = new Set(database.query(`PRAGMA table_info(${table})`).all().map(({ name }) => name));
    if (columns.some((column) => !actual.has(column))) throw new Error(`Authentication schema is malformed: ${table}`);
  }
  const identitySql = database.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='external_identities'").get()?.sql || '';
  const transactionSql = database.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='login_transactions'").get()?.sql || '';
  if (!/UNIQUE\s*\(\s*issuer\s*,\s*subject\s*\)/i.test(identitySql) || !/state_hash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(transactionSql)) {
    throw new Error('Authentication schema constraints are malformed');
  }
}

export function applyAuthMigrations(database, { beforeVersion } = {}) {
  database.exec('PRAGMA foreign_keys = ON');
  const current = database.query('PRAGMA user_version').get().user_version;
  if (!Number.isInteger(current) || current < 0 || current > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Unsupported authentication schema version: ${current}`);
  }
  database.transaction(() => {
    for (let version = current; version < DATABASE_SCHEMA_VERSION; version += 1) {
      const sql = MIGRATIONS.get(version);
      if (!sql) throw new Error(`No authentication migration from version ${version}`);
      beforeVersion?.(version + 1, database);
      database.exec(sql);
      database.exec(`PRAGMA user_version = ${version + 1}`);
    }
    verifySchema(database);
  })();
  return DATABASE_SCHEMA_VERSION;
}

export { verifySchema as verifyAuthSchema };
