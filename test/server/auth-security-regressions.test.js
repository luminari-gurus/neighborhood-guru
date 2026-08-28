import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createAuthBackend } from '../../server/auth/backend.js';
import { LOGIN_STATE_COOKIE_NAME, LOGIN_STATE_DURATION_MS, SESSION_COOKIE_NAME } from '../../server/auth/constants.js';

const NOW = 1_900_000_000_000;
const databases = [];
let seed = 0;
const randomBytes = (length) => Uint8Array.from({ length }, (_, i) => (i + ++seed * 13) % 256);
const config = (secret = 'a'.repeat(32)) => ({ mode: 'optional', secret, databasePath: ':memory:', production: false });
const req = (path, init) => new Request(`https://app.example${path}`, init);
const cookieValue = (response, name) => response.headers.getSetCookie().map((value) => value.match(new RegExp(`^${name}=([^;]*)`))?.[1]).find(Boolean);
const callbackHeaders = (state, session) => ({ cookie: `${LOGIN_STATE_COOKIE_NAME}=${state}${session ? `; ${SESSION_COOKIE_NAME}=${session}` : ""}` });
const provider = (id = 'generic', overrides = {}) => ({ id, displayName: id, createAuthorizationUrl: async ({ state }) => `https://id.example/auth?state=${state}`, exchangeCallback: async () => ({ identity: { issuer: 'https://id.example', subject: 'subject' }, user: { displayName: 'Ada', email: null, avatarUrl: null }, returnPath: '/evil' }), ...overrides });
function backend(options = {}) { const database = options.database || new Database(':memory:'); databases.push(database); return createAuthBackend({ config: config(), database, clock: () => NOW, randomBytes, providers: [provider()], ...options }); }
async function login(api, id = 'generic', path = '/owned') { const response = await api.fetch(req(`/api/auth/login/${id}?returnPath=${encodeURIComponent(path)}`)); return cookieValue(response, LOGIN_STATE_COOKIE_NAME); }
afterEach(() => { seed = 0; while (databases.length) try { databases.pop().close(); } catch {} });

describe('login transaction security regressions', () => {
  test('state is hashed, provider-bound, return-bound, and consumed once', async () => {
    const api = backend({ providers: [provider(), provider('other')] });
    const state = await login(api);
    expect(JSON.stringify(api.database.query('SELECT * FROM login_transactions').get())).not.toContain(state);
    expect((await api.fetch(req(`/api/auth/callback/other?state=${state}`))).status).toBe(400);
    const response = await api.fetch(req(`/api/auth/callback/generic?state=${state}`, { headers: callbackHeaders(state) }));
    expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('/owned');
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect((await api.fetch(req(`/api/auth/callback/generic?state=${state}`, { headers: callbackHeaders(state) }))).status).toBe(400);
    expect(api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(1);
  });
  test('form_post succeeds with state cookie and expiry fails', async () => {
    let now = NOW; const api = backend({ clock: () => now }); const state = await login(api);
    const post = await api.fetch(req('/api/auth/callback/generic', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...callbackHeaders(state) }, body: `state=${state}` }));
    expect(post.status).toBe(302);
    const expired = await login(api); now += LOGIN_STATE_DURATION_MS + 1;
    expect((await api.fetch(req(`/api/auth/callback/generic?state=${expired}`, { headers: callbackHeaders(expired) }))).status).toBe(400);
  });
  test('duplicate security cookies and malformed provider encoding fail closed', async () => {
    const api = backend(); const state = await login(api);
    expect((await api.fetch(req(`/api/auth/callback/generic?state=${state}`, { headers: { cookie: `${LOGIN_STATE_COOKIE_NAME}=bad; ${LOGIN_STATE_COOKIE_NAME}=${state}` } }))).status).toBe(400);
    expect((await api.fetch(req('/api/auth/login/%E0%A4%A'))).status).toBe(400);
  });
  test('secret changes hashes and invalidates existing state and session material', async () => {
    const apiA = backend({ config: config('a'.repeat(32)) }); const state = await login(apiA);
    const hashA = apiA.database.query('SELECT state_hash FROM login_transactions').get().state_hash; seed = 0;
    const shared = new Database(':memory:'); databases.push(shared);
    const apiB = createAuthBackend({ config: config('b'.repeat(32)), database: shared, clock: () => NOW, randomBytes, providers: [provider()] });
    await apiB.fetch(req('/api/auth/login/generic'));
    const hashB = shared.query('SELECT state_hash FROM login_transactions').get().state_hash;
    expect(hashA).not.toBe(hashB);
    const apiRotated = createAuthBackend({ config: config("b".repeat(32)), database: apiA.database, clock: () => NOW, randomBytes, providers: [provider()] });
    expect((await apiRotated.fetch(req(`/api/auth/callback/generic?state=${state}`, { headers: callbackHeaders(state) }))).status).toBe(400);
    apiA.database.run("INSERT INTO users VALUES (?,NULL,NULL,NULL,?,?)", ["existing", NOW, NOW]); const issued = apiA.issueSession("existing");
    expect(await (await apiRotated.fetch(req("/api/auth/session", { headers: { cookie: `${SESSION_COOKIE_NAME}=${issued.raw}` } }))).json()).toBeNull();
  });
  test('invalid provider scalars and oversized fields are rejected before writes', async () => {
    for (const result of [
      { identity: { issuer: 'relative', subject: 's' }, user: {} },
      { identity: { issuer: 'https://id.example', subject: ['bad'] }, user: {} },
      { identity: { issuer: 'https://id.example', subject: 's' }, user: { displayName: 'x'.repeat(2049) } },
    ]) {
      const api = backend({ providers: [provider('generic', { exchangeCallback: async () => result })] }); const state = await login(api);
      expect((await api.fetch(req(`/api/auth/callback/generic?state=${state}`, { headers: callbackHeaders(state) }))).status).toBe(400);
      expect(api.database.query('SELECT count(*) count FROM users').get().count).toBe(0);
    }
  });
  test('competing callbacks deterministically create one identity and replay loses', async () => {
    const api = backend(); const first = await login(api, 'generic', '/one'); const second = await login(api, 'generic', '/two');
    const results = await Promise.all([api.fetch(req(`/api/auth/callback/generic?state=${first}`, { headers: callbackHeaders(first) })), api.fetch(req(`/api/auth/callback/generic?state=${second}`, { headers: callbackHeaders(second) }))]);
    expect(results.map(({ status }) => status)).toEqual([302, 302]); expect(api.database.query('SELECT count(*) count FROM external_identities').get().count).toBe(1);
    const replayResults = await Promise.all([api.fetch(req(`/api/auth/callback/generic?state=${first}`, { headers: callbackHeaders(first) })), api.fetch(req(`/api/auth/callback/generic?state=${first}`, { headers: callbackHeaders(first) }))]);
    expect(replayResults.every(({ status }) => status === 400)).toBe(true);
  });
  test('provider discovery exceptions become redacted API failures', async () => {
    const api = backend({ providerRegistry: { list() { throw new Error('registry-secret'); }, get() { return null; } } }); const response = await api.fetch(req('/api/auth/providers'));
    expect(response.status).toBe(500); expect(await response.text()).not.toContain('registry-secret');
  });
  test('callback failure preserves consumption, identity, revocation, and replacement session', async () => {
    const api = backend({ beforeCallbackCommit() { throw new Error("forced"); } });
    api.database.run("INSERT INTO users VALUES (?,NULL,NULL,NULL,?,?)", ["old-user", NOW, NOW]); const old = api.issueSession("old-user"); const state = await login(api);
    expect((await api.fetch(req(`/api/auth/callback/generic?state=${state}`, { headers: callbackHeaders(state, old.raw) }))).status).toBe(500);
    expect(api.database.query('SELECT consumed_at FROM login_transactions').get().consumed_at).toBe(NOW);
    expect(api.database.query("SELECT count(*) count FROM users").get().count).toBe(1);
    expect(api.database.query("SELECT count(*) count FROM sessions").get().count).toBe(1); expect(api.database.query("SELECT revoked_at FROM sessions").get().revoked_at).toBeNull();
  });
});
