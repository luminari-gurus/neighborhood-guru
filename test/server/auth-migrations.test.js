import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applyAuthMigrations } from '../../server/auth/database.js';
import { DATABASE_SCHEMA_VERSION } from '../../server/auth/constants.js';

function version(database) { return database.query('PRAGMA user_version').get().user_version; }
function createV1(database) {
  database.exec(`CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, display_name TEXT, email TEXT, avatar_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE external_identities (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (issuer, subject));
    CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL);
    CREATE INDEX sessions_user_id_idx ON sessions(user_id); PRAGMA user_version=1;`);
}

describe('transactional authentication migrations', () => {
  test('creates target schema and is idempotent at current version', () => {
    const db = new Database(':memory:'); expect(applyAuthMigrations(db)).toBe(DATABASE_SCHEMA_VERSION); expect(version(db)).toBe(2); expect(applyAuthMigrations(db)).toBe(2); db.close();
  });
  test('upgrades recognized v1 while preserving data', () => {
    const db = new Database(':memory:'); createV1(db); db.run('INSERT INTO users VALUES (?,NULL,NULL,NULL,1,1)', ['kept']); applyAuthMigrations(db);
    expect(version(db)).toBe(2); expect(db.query('SELECT id FROM users').get().id).toBe('kept'); expect(db.query("SELECT name FROM sqlite_master WHERE name='login_transactions'").get().name).toBe('login_transactions'); db.close();
  });
  test('refuses newer versions without downgrading', () => {
    const db = new Database(':memory:'); db.exec('PRAGMA user_version=99'); expect(() => applyAuthMigrations(db)).toThrow('Unsupported'); expect(version(db)).toBe(99); db.close();
  });
  test('rejects a malformed schema marked current', () => {
    const db = new Database(':memory:'); db.exec('CREATE TABLE users (id TEXT PRIMARY KEY); PRAGMA user_version=2'); expect(() => applyAuthMigrations(db)).toThrow('malformed'); expect(version(db)).toBe(2); db.close();
  });
  test('rejects nullable primary-key columns', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, email TEXT, avatar_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE external_identities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (issuer, subject));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX sessions_user_id_idx ON sessions(user_id);
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
      PRAGMA user_version=2`);
    expect(() => applyAuthMigrations(db)).toThrow('malformed');
    db.close();
  });
  test('rejects non-unique index metadata for sessions_user_id_idx', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, display_name TEXT, email TEXT, avatar_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE external_identities (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (issuer, subject));
      CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX sessions_user_id_idx ON sessions(user_id);
      CREATE TABLE login_transactions (
        id TEXT PRIMARY KEY NOT NULL,
        state_hash TEXT NOT NULL UNIQUE,
        provider_id TEXT NOT NULL,
        return_path TEXT NOT NULL,
        adapter_context TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX login_transactions_expires_at_idx ON login_transactions(expires_at);
      PRAGMA user_version=2`);
    expect(() => applyAuthMigrations(db)).toThrow('malformed');
    db.close();
  });
  test('rolls back migration DDL and version on injected failure', () => {
    const db = new Database(':memory:'); createV1(db);
    expect(() => applyAuthMigrations(db, { beforeVersion(next, database) { if (next === 2) { database.exec('CREATE TABLE migration_probe (id TEXT)'); throw new Error('stop'); } } })).toThrow('stop');
    expect(version(db)).toBe(1); expect(db.query("SELECT name FROM sqlite_master WHERE name='migration_probe'").get()).toBeNull(); expect(db.query("SELECT name FROM sqlite_master WHERE name='login_transactions'").get()).toBeNull(); db.close();
  });
});
