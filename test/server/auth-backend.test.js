import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { applyAuthMigrations } from '../../server/auth/database.js';

describe('authentication database migrations', () => {
  test('create users, identities, and sessions with identity uniqueness', () => {
    const database = new Database(':memory:');
    applyAuthMigrations(database);

    database.run(
      'INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['user-1', 'Ada', 'ada@example.test', null, 1, 1],
    );
    database.run(
      'INSERT INTO external_identities (id, user_id, issuer, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['identity-1', 'user-1', 'https://issuer.example', 'subject-1', 1, 1],
    );

    expect(() => database.run(
      'INSERT INTO external_identities (id, user_id, issuer, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['identity-2', 'user-1', 'https://issuer.example', 'subject-1', 1, 1],
    )).toThrow();
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      .toEqual(expect.arrayContaining([
        { name: 'external_identities' },
        { name: 'sessions' },
        { name: 'users' },
      ]));
    database.close();
  });
});
