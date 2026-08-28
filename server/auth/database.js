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
  users: { id: ["TEXT", 1, 1], display_name: ["TEXT", 0, 0], email: ["TEXT", 0, 0], avatar_url: ["TEXT", 0, 0], created_at: ["INTEGER", 1, 0], updated_at: ["INTEGER", 1, 0] },
  external_identities: { id: ["TEXT", 1, 1], user_id: ["TEXT", 1, 0], issuer: ["TEXT", 1, 0], subject: ["TEXT", 1, 0], created_at: ["INTEGER", 1, 0], updated_at: ["INTEGER", 1, 0] },
  sessions: { id: ["TEXT", 1, 1], user_id: ["TEXT", 1, 0], token_hash: ["TEXT", 1, 0], csrf_hash: ["TEXT", 1, 0], expires_at: ["INTEGER", 1, 0], revoked_at: ["INTEGER", 0, 0], created_at: ["INTEGER", 1, 0] },
  login_transactions: { id: ["TEXT", 1, 1], state_hash: ["TEXT", 1, 0], provider_id: ["TEXT", 1, 0], return_path: ["TEXT", 1, 0], adapter_context: ["TEXT", 0, 0], created_at: ["INTEGER", 1, 0], expires_at: ["INTEGER", 1, 0], consumed_at: ["INTEGER", 0, 0] },
});
const UNIQUE = Object.freeze({ external_identities: [["issuer", "subject"]], sessions: [["token_hash"]], login_transactions: [["state_hash"]] });
const INDEXES = Object.freeze({ sessions_user_id_idx: ["sessions", ["user_id"]], login_transactions_expires_at_idx: ["login_transactions", ["expires_at"]] });
function pragma(database, sql) { return database.query(sql).all(); }
function columnsOf(database, index) { return pragma(database, `PRAGMA index_info(${JSON.stringify(index)})`).sort((x, y) => x.seqno - y.seqno).map((row) => row.name); }
function sameColumns(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function malformed(detail) { throw new Error(`Authentication schema is malformed: ${detail}`); }
function verifySchema(database) {
  for (const [table, expected] of Object.entries(REQUIRED)) {
    const rows = pragma(database, `PRAGMA table_info(${JSON.stringify(table)})`);
    if (rows.length !== Object.keys(expected).length) malformed(table);
    for (const row of rows) {
      const specification = expected[row.name];
      if (!specification || row.type.toUpperCase() !== specification[0] || (row.name !== "id" && row.notnull !== specification[1]) || row.pk !== specification[2]) malformed(`${table}.${row.name}`);
    }
  }
  for (const table of ["external_identities", "sessions"]) {
    const foreignKeys = pragma(database, `PRAGMA foreign_key_list(${JSON.stringify(table)})`);
    if (!foreignKeys.some((key) => key.from === "user_id" && key.table === "users" && key.to === "id" && key.on_delete.toUpperCase() === "CASCADE")) malformed(`${table} foreign key`);
  }
  for (const [table, groups] of Object.entries(UNIQUE)) {
    const indexes = pragma(database, `PRAGMA index_list(${JSON.stringify(table)})`);
    for (const group of groups) if (!indexes.some((index) => index.unique === 1 && sameColumns(columnsOf(database, index.name), group))) malformed(`${table} unique`);
  }
  for (const [name, [table, columns]] of Object.entries(INDEXES)) {
    const index = pragma(database, `PRAGMA index_list(${JSON.stringify(table)})`).find((entry) => entry.name === name);
    if (!index || !sameColumns(columnsOf(database, name), columns)) malformed(name);
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
