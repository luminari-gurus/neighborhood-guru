import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createAuthBackend } from '../../server/auth/backend.js';
import { loadAuthConfig } from '../../server/auth/config.js';
import { AUTH_MODES, LOGIN_STATE_COOKIE_NAME, SESSION_COOKIE_NAME, SESSION_DURATION_MS } from '../../server/auth/constants.js';

const NOW = 1_800_000_000_000;
const databases = [];
let randomCall = 0;
const deterministicRandom = (length) => {
  randomCall += 1;
  return Uint8Array.from({ length }, (_, index) => (index + randomCall * 17) % 256);
};
const request = (path, init) => new Request(`https://app.example${path}`, init);
const valueFromCookie = (header, name) => header.match(new RegExp(`${name}=([^;,]+)`))?.[1];
function config(mode = AUTH_MODES.OPTIONAL) { return { mode, databasePath: ':memory:', secret: 'x'.repeat(32), production: false }; }
function fakeProvider(overrides = {}) {
  return { id: 'generic', displayName: 'Generic Login',
    createAuthorizationUrl: async ({ state, returnPath }) => `https://identity.example/authorize?state=${state}&return=${encodeURIComponent(returnPath)}`,
    exchangeCallback: async () => ({ identity: { issuer: 'https://identity.example', subject: 'subject-1' }, user: { displayName: 'Ada', email: 'ada@example.test', avatarUrl: null }, returnPath: '/map' }), ...overrides };
}
function backend(options = {}) {
  const database = new Database(':memory:'); databases.push(database);
  return createAuthBackend({ config: config(), database, clock: () => NOW, randomBytes: deterministicRandom, providers: [fakeProvider()], ...options });
}
function seedUser(api) { api.database.run('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)', ['user-1', 'Ada', 'ada@example.test', null, NOW, NOW]); }
async function sessionCookie(api) { seedUser(api); const issued = await api.issueSession('user-1'); return { issued, cookie: `${SESSION_COOKIE_NAME}=${issued.raw}` }; }
afterEach(() => { randomCall = 0; while (databases.length) { try { databases.pop().close(); } catch {} } });

describe('authentication configuration', () => {
  test('defaults to disabled and validates all startup modes', () => {
    expect(loadAuthConfig({}).mode).toBe(AUTH_MODES.DISABLED);
    expect(loadAuthConfig({ AUTH_MODE: 'optional' }).mode).toBe(AUTH_MODES.OPTIONAL);
    expect(loadAuthConfig({ AUTH_MODE: 'required' }).mode).toBe(AUTH_MODES.REQUIRED);
    expect(() => loadAuthConfig({ AUTH_MODE: 'bad' })).toThrow('AUTH_MODE');
  });
  test('fails production startup clearly when enabled configuration is absent', () => {
    expect(() => loadAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'required', AUTH_SECRET: 'secret' })).toThrow('AUTH_DATABASE_PATH');
    expect(loadAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'disabled' }).mode).toBe('disabled');
  });
  test('disabled backend remains unavailable without opening SQLite', async () => {
    expect((await createAuthBackend({ config: config('disabled') }).fetch(request('/api/auth/providers'))).status).toBe(404);
  });
});

describe('provider discovery and login', () => {
  test('discovers normalized plural providers and handles discovery failure safely', async () => {
    const api = backend();
    expect(await (await api.fetch(request('/api/auth/providers'))).json()).toEqual([{ id: 'generic', displayName: 'Generic Login' }]);
    expect(() => backend({ providers: [{ id: 'broken', displayName: 'Broken' }] })).toThrow('Invalid authentication provider');
  });
  test('redirects known provider with protected state and exact local return path', async () => {
    const response = await backend().fetch(request('/api/auth/login/generic?returnPath=%2Fmap%3Ftab%3Dnearby'));
    expect(response.status).toBe(302); expect(response.headers.get('location')).toContain('identity.example/authorize');
    const header = response.headers.get('set-cookie');
    expect(header).toContain(`${LOGIN_STATE_COOKIE_NAME}=`); expect(header).toContain('HttpOnly'); expect(header).toContain('Secure'); expect(header).toContain('SameSite=Lax');
  });
  test('rejects unknown providers, open redirects, and adapter failures without secrets', async () => {
    const api = backend({ providers: [fakeProvider({ createAuthorizationUrl: async () => { throw new Error('client-secret-value'); } })] });
    expect((await api.fetch(request('/api/auth/login/missing'))).status).toBe(404);
    expect((await api.fetch(request('/api/auth/login/generic?returnPath=https://evil.example'))).status).toBe(400);
    const failure = await api.fetch(request('/api/auth/login/generic')); expect(failure.status).toBe(502); expect(await failure.text()).not.toContain('client-secret-value');
  });
});

describe('sessions, callback, and logout', () => {
  test('returns normalized sessions and fails closed for missing, malformed, expired, and revoked sessions', async () => {
    const api = backend();
    expect(await (await api.fetch(request('/api/auth/session'))).json()).toBeNull();
    expect(await (await api.fetch(request('/api/auth/session', { headers: { cookie: `${SESSION_COOKIE_NAME}=bad` } }))).json()).toBeNull();
    const { issued, cookie } = await sessionCookie(api);
    const active = await (await api.fetch(request('/api/auth/session', { headers: { cookie } }))).json();
    expect(active.user).toEqual({ id: 'user-1', displayName: 'Ada', email: 'ada@example.test', avatarUrl: null }); expect(active.expiresAt).toBe(new Date(NOW + SESSION_DURATION_MS).toISOString()); expect(active.csrfToken).toBeString();
    expect(JSON.stringify(active)).not.toContain(issued.raw); expect(JSON.stringify(api.database.query('SELECT * FROM sessions').all())).not.toContain(issued.raw);
    api.database.run('UPDATE sessions SET expires_at = ?', [NOW]); expect(await (await api.fetch(request('/api/auth/session', { headers: { cookie } }))).json()).toBeNull();
    api.database.run('UPDATE sessions SET expires_at = ?, revoked_at = ?', [NOW + 1, NOW]); expect(await (await api.fetch(request('/api/auth/session', { headers: { cookie } }))).json()).toBeNull();
    const required = backend({ config: config('required') }); expect((await required.fetch(request('/api/auth/session'))).status).toBe(401);
  });
  test('supports GET and POST callback, creates identity, and rotates an existing session', async () => {
    for (const method of ['GET', 'POST']) {
      const api = backend(); const login = await api.fetch(request('/api/auth/login/generic?returnPath=/map')); const state = valueFromCookie(login.headers.get('set-cookie'), LOGIN_STATE_COOKIE_NAME);
      const init = method === 'POST' ? { method, headers: { cookie: `${LOGIN_STATE_COOKIE_NAME}=${state}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `state=${state}` } : { headers: { cookie: `${LOGIN_STATE_COOKIE_NAME}=${state}` } };
      const response = await api.fetch(request(`/api/auth/callback/generic${method === 'GET' ? `?state=${state}` : ''}`, init));
      expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('/map'); expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`); expect(api.database.query('SELECT count(*) count FROM external_identities').get().count).toBe(1);
    }
    const api = backend(); const { cookie } = await sessionCookie(api); const login = await api.fetch(request('/api/auth/login/generic')); const state = valueFromCookie(login.headers.get('set-cookie'), LOGIN_STATE_COOKIE_NAME);
    await api.fetch(request(`/api/auth/callback/generic?state=${state}`, { headers: { cookie: `${cookie}; ${LOGIN_STATE_COOKIE_NAME}=${state}` } }));
    expect(api.database.query('SELECT count(*) count FROM sessions WHERE revoked_at IS NOT NULL').get().count).toBe(1);
  });
  test('callback rejects missing state, provider failure, invalid response, unknown provider, and open redirect', async () => {
    expect((await backend().fetch(request('/api/auth/callback/missing?state=x'))).status).toBe(404);
    expect((await backend().fetch(request('/api/auth/callback/generic?state=x'))).status).toBe(400);
    for (const result of [new Error('provider-token-secret'), { user: {} }, { identity: { issuer: 'i', subject: 's' }, user: {}, returnPath: '//evil.example' }]) {
      const provider = fakeProvider({ exchangeCallback: async () => { if (result instanceof Error) throw result; return result; } }); const api = backend({ providers: [provider] });
      const state = 'valid-state'; const response = await api.fetch(request(`/api/auth/callback/generic?state=${state}`, { headers: { cookie: `${LOGIN_STATE_COOKIE_NAME}=${state}` } }));
      expect(response.status).toBe(400); expect(await response.text()).not.toContain('provider-token-secret');
    }
  });
  test('logout requires a valid session and CSRF, revokes server-side, and expires secure cookie', async () => {
    const api = backend(); expect((await api.fetch(request('/api/auth/logout', { method: 'POST' }))).status).toBe(401);
    const { cookie } = await sessionCookie(api); expect((await api.fetch(request('/api/auth/logout', { method: 'POST', headers: { cookie } }))).status).toBe(403);
    const session = await (await api.fetch(request('/api/auth/session', { headers: { cookie } }))).json();
    const response = await api.fetch(request('/api/auth/logout', { method: 'POST', headers: { cookie, 'x-csrf-token': session.csrfToken } }));
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('Max-Age=0'); expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(api.database.query('SELECT revoked_at FROM sessions').get().revoked_at).toBe(NOW);
  });
});
