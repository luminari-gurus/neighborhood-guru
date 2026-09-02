import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createAuthBackend } from '../../server/auth/backend.js';
import { loadAuthConfig } from '../../server/auth/config.js';
import {
  AUTH_MODES,
  LOGIN_STATE_COOKIE_NAME,
  LOGIN_STATE_DURATION_MS,
  SESSION_COOKIE_NAME,
} from '../../server/auth/constants.js';
import { createOidcProvider } from '../../server/auth/oidc/adapter.js';
import { loadOidcConfig } from '../../server/auth/oidc/config.js';
import { createServer } from '../../server/server.js';
import { createFakeOidcIssuer } from './fake-oidc-issuer.js';

const NOW = 1_700_000_000_000;
const databases = [];
let randomCall = 0;
const deterministicRandom = (length) => {
  randomCall += 1;
  return Uint8Array.from({ length }, (_, index) => (index + randomCall * 17) % 256);
};
const request = (path, init) => new Request(`https://app.example${path}`, init);
const cookieValue = (response, name) => response.headers.getSetCookie().map((value) => value.match(new RegExp(`^${name}=([^;]*)`))?.[1]).find(Boolean);
function collectText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function expectNoProviderTokens(values) {
  const text = values.map(collectText).join('\n');
  expect(text).not.toContain('provider-access-token-must-not-leak');
  expect(text).not.toContain('provider-refresh-token-must-not-leak');
  expect(text).not.toContain('codeVerifier');
}

function authConfig(overrides = {}) {
  return { mode: AUTH_MODES.OPTIONAL, databasePath: ':memory:', secret: 'x'.repeat(32), production: false, ...overrides };
}

function capturingLogger() {
  const entries = [];
  return {
    entries,
    error(message, details) { entries.push({ level: 'error', message, details }); },
    warn(message, details) { entries.push({ level: 'warn', message, details }); },
    info(message, details) { entries.push({ level: 'info', message, details }); },
  };
}

async function createHarness({ issuer, issuerOptions, fetch: fetchImpl, logger, clock } = {}) {
  issuer = issuer || await createFakeOidcIssuer({ clock: clock || (() => NOW), randomBytes: deterministicRandom, ...issuerOptions });
  const logs = logger || capturingLogger();
  const database = new Database(':memory:');
  databases.push(database);
  const provider = createOidcProvider({
    issuer: issuer.issuer,
    clientId: issuer.clientId,
    scopes: 'openid profile email',
    redirectPath: '/api/auth/callback/oidc',
    production: false,
    fetch: fetchImpl || issuer.fetch,
    clock: clock || (() => NOW),
    randomBytes: deterministicRandom,
    logger: logs,
  });
  const api = createAuthBackend({
    config: authConfig(),
    database,
    clock: clock || (() => NOW),
    randomBytes: deterministicRandom,
    providers: [provider],
  });
  return { api, issuer, logs, provider };
}

async function beginLogin(api, returnPath = '/map') {
  const response = await api.fetch(request(`/api/auth/login/oidc?returnPath=${encodeURIComponent(returnPath)}`));
  const state = cookieValue(response, LOGIN_STATE_COOKIE_NAME);
  return { response, state, location: response.headers.get('location'), cookie: `${LOGIN_STATE_COOKIE_NAME}=${state}` };
}

async function authorize(issuer, location) {
  return issuer.fetch(location, { method: 'GET', redirect: 'manual' });
}

async function completeLogin(api, issuer, returnPath = '/map') {
  const login = await beginLogin(api, returnPath);
  const authorized = await authorize(issuer, login.location);
  const callback = await api.fetch(new Request(authorized.headers.get('location'), { headers: { cookie: login.cookie } }));
  return { login, authorized, callback, sessionCookie: cookieValue(callback, SESSION_COOKIE_NAME) };
}

afterEach(() => {
  randomCall = 0;
  while (databases.length) {
    try { databases.pop().close(); } catch {}
  }
});

describe('OIDC configuration schema', () => {
  test('defaults remain disabled and anonymous with no issuer configured', () => {
    const config = loadAuthConfig({});
    expect(config.mode).toBe(AUTH_MODES.DISABLED);
    expect(config.oidc).toBeNull();
    expect(loadOidcConfig({})).toBeNull();
    expect(loadOidcConfig({ OIDC_ISSUER: '' })).toBeNull();
  });

  test('loads generic issuer, client id, scopes, and redirect path', () => {
    const oidc = loadOidcConfig({
      OIDC_ISSUER: 'https://issuer.example/',
      OIDC_CLIENT_ID: 'test-client',
      OIDC_SCOPES: 'openid profile email',
      OIDC_REDIRECT_PATH: '/api/auth/callback/oidc',
    });
    expect(oidc).toEqual({
      issuer: 'https://issuer.example',
      clientId: 'test-client',
      clientSecret: null,
      scopes: 'openid profile email',
      redirectPath: '/api/auth/callback/oidc',
      redirectOrigin: null,
      providerId: 'oidc',
      displayName: 'Sign in',
      production: false,
    });
  });

  test('repository examples stay generic and redacted', async () => {
    const example = await Bun.file(new URL('../../.env.example', import.meta.url)).text();
    expect(example).toContain('OIDC_ISSUER=');
    expect(example).toContain('OIDC_CLIENT_ID=');
    expect(example).toContain('OIDC_REDIRECT_PATH=/api/auth/callback/oidc');
    expect(example).not.toMatch(/OIDC_ISSUER=https:\/\/(accounts\.google\.com|appleid\.apple\.com)/);
    expect(example).not.toMatch(/OIDC_CLIENT_SECRET=\S+/);
    expect(example).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
  });

  test('rejects insecure issuers, missing client ids, and mismatched redirect paths', () => {
    expect(() => loadOidcConfig({ OIDC_ISSUER: 'http://issuer.example', OIDC_CLIENT_ID: 'id' })).toThrow('OIDC_ISSUER');
    expect(() => loadOidcConfig({ OIDC_ISSUER: 'https://issuer.example/?q=1', OIDC_CLIENT_ID: 'id' })).toThrow('OIDC_ISSUER');
    expect(() => loadOidcConfig({ OIDC_ISSUER: 'https://issuer.example' })).toThrow('OIDC_CLIENT_ID');
    expect(() => loadOidcConfig({
      OIDC_ISSUER: 'https://issuer.example',
      OIDC_CLIENT_ID: 'id',
      OIDC_REDIRECT_PATH: '/elsewhere',
    })).toThrow('OIDC_REDIRECT_PATH');
  });

  test('createServer registers the generic OIDC adapter from deployment config', async () => {
    const issuer = await createFakeOidcIssuer({ clock: () => NOW, randomBytes: deterministicRandom });
    const instance = createServer({
      config: authConfig({
        oidc: {
          issuer: issuer.issuer,
          clientId: issuer.clientId,
          fetch: issuer.fetch,
          clock: () => NOW,
          randomBytes: deterministicRandom,
        },
      }),
      serve: false,
    });
    databases.push(instance.backend.database);
    expect(await (await instance.fetch(request('/api/auth/providers'))).json()).toEqual([{ id: 'oidc', displayName: 'Sign in' }]);
    instance.close();
  });

  test('disabled auth mode stays closed even when OIDC configuration is present', async () => {
    const backend = createAuthBackend({ config: authConfig({ mode: AUTH_MODES.DISABLED, oidc: { issuer: 'https://issuer.example', clientId: 'test-client' } }) });
    expect((await backend.fetch(request('/api/auth/providers'))).status).toBe(404);
    expect((await backend.fetch(request('/api/auth/login/oidc'))).status).toBe(404);
    backend.close();
  });
});

describe('OIDC contract: login, callback, identity, and logout', () => {
  test('successful authorization-code + PKCE login validates issuer audience signature expiry nonce and state', async () => {
    const { api, issuer } = await createHarness();
    const login = await beginLogin(api, '/map?tab=nearby');
    expect(login.response.status).toBe(302);
    const authorizeUrl = new URL(login.location);
    expect(authorizeUrl.origin).toBe(issuer.issuer);
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('client_id')).toBe(issuer.clientId);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('https://app.example/api/auth/callback/oidc');
    expect(authorizeUrl.searchParams.get('scope')).toContain('openid');
    expect(authorizeUrl.searchParams.get('state')).toBe(login.state);
    expect(authorizeUrl.searchParams.get('nonce')).toBeString();
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeString();
    expect(login.location).not.toContain('code_verifier');
    expect(login.location).not.toContain(JSON.parse(api.database.query('SELECT adapter_context FROM login_transactions').get().adapter_context).codeVerifier);

    const pending = api.database.query('SELECT adapter_context, consumed_at FROM login_transactions').get();
    const context = JSON.parse(pending.adapter_context);
    expect(context.codeVerifier).toBeString();
    expect(context.nonce).toBe(authorizeUrl.searchParams.get('nonce'));
    expect(pending.consumed_at).toBeNull();

    const authorized = await authorize(issuer, login.location);
    expect(authorized.status).toBe(302);
    const callbackUrl = new URL(authorized.headers.get('location'));
    expect(callbackUrl.pathname).toBe('/api/auth/callback/oidc');
    expect(callbackUrl.searchParams.get('state')).toBe(login.state);
    expect(callbackUrl.searchParams.get('code')).toBeString();

    const callback = await api.fetch(new Request(callbackUrl, { headers: { cookie: login.cookie } }));
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/map?tab=nearby');
    const sessionCookie = cookieValue(callback, SESSION_COOKIE_NAME);
    expect(sessionCookie).toBeString();
    expectNoProviderTokens([
      ...callback.headers.getSetCookie(),
      await callback.text(),
      api.database.query('SELECT * FROM login_transactions').all(),
      api.database.query('SELECT * FROM sessions').all(),
      api.database.query('SELECT * FROM users').all(),
    ]);
    expect(api.database.query('SELECT adapter_context, consumed_at FROM login_transactions').get()).toEqual({
      adapter_context: null,
      consumed_at: NOW,
    });

    const session = await (await api.fetch(request('/api/auth/session', { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` } }))).json();
    expect(session.user).toEqual({
      id: expect.any(String),
      displayName: 'Ada Lovelace',
      email: 'ada@example.test',
      avatarUrl: null,
    });
    expectNoProviderTokens([session]);
    const identity = api.database.query('SELECT issuer, subject FROM external_identities').get();
    expect(identity).toEqual({ issuer: new URL(issuer.issuer).href, subject: 'subject-1' });
  });

  test('identity is keyed by issuer and subject; email is profile data', async () => {
    const { api, issuer } = await createHarness();
    const first = await completeLogin(api, issuer);
    expect(first.callback.status).toBe(302);
    const original = api.database.query('SELECT users.id id, users.email email, external_identities.issuer issuer, external_identities.subject subject FROM users JOIN external_identities ON external_identities.user_id = users.id').get();

    issuer.mutateNextIdToken(({ header, payload }) => ({
      header,
      payload: { ...payload, email: 'ada+new@example.test', name: 'Ada' },
    }));
    const second = await completeLogin(api, issuer);
    expect(second.callback.status).toBe(302);
    const updated = api.database.query('SELECT users.id id, users.email email, count(*) count FROM users JOIN external_identities ON external_identities.user_id = users.id').get();
    expect(updated.count).toBe(1);
    expect(updated.id).toBe(original.id);
    expect(updated.email).toBe('ada+new@example.test');

    issuer.mutateNextIdToken(({ header, payload }) => ({
      header,
      payload: { ...payload, sub: 'subject-2', email: 'ada+new@example.test' },
    }));
    const third = await completeLogin(api, issuer);
    expect(third.callback.status).toBe(302);
    const identities = api.database.query('SELECT subject, user_id FROM external_identities ORDER BY subject').all();
    expect(identities.map((row) => row.subject)).toEqual(['subject-1', 'subject-2']);
    expect(identities[0].user_id).not.toBe(identities[1].user_id);
    expect(api.database.query('SELECT count(*) count FROM users').get().count).toBe(2);
  });

  test('login return paths are restricted to same-origin application paths', async () => {
    const { api } = await createHarness();
    expect((await api.fetch(request('/api/auth/login/oidc?returnPath=https://evil.example'))).status).toBe(400);
    expect((await api.fetch(request('/api/auth/login/oidc?returnPath=//evil.example'))).status).toBe(400);
    expect((await api.fetch(request('/api/auth/login/oidc?returnPath=/\\evil'))).status).toBe(400);
  });

  test('cancellation does not create a session', async () => {
    const { api, issuer } = await createHarness();
    const login = await beginLogin(api);
    issuer.cancelNextAuthorize('access_denied');
    const authorized = await authorize(issuer, login.location);
    const callback = await api.fetch(new Request(authorized.headers.get('location'), { headers: { cookie: login.cookie } }));
    expect(callback.status).toBe(400);
    expect(api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(0);
    expect(api.database.query('SELECT count(*) count FROM users').get().count).toBe(0);
    expect(api.database.query('SELECT consumed_at FROM login_transactions').get().consumed_at).toBe(NOW);
  });

  test('replay of callback state or authorization code fails closed', async () => {
    const { api, issuer } = await createHarness();
    const login = await beginLogin(api);
    const authorized = await authorize(issuer, login.location);
    const callbackUrl = authorized.headers.get('location');
    expect((await api.fetch(new Request(callbackUrl, { headers: { cookie: login.cookie } }))).status).toBe(302);
    expect((await api.fetch(new Request(callbackUrl, { headers: { cookie: login.cookie } }))).status).toBe(400);
    expect(api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(1);
  });

  test('invalid state and nonce are rejected', async () => {
    const { api, issuer } = await createHarness();
    const login = await beginLogin(api);
    const authorized = await authorize(issuer, login.location);
    const callbackUrl = new URL(authorized.headers.get('location'));
    expect((await api.fetch(new Request(callbackUrl, { headers: { cookie: `${LOGIN_STATE_COOKIE_NAME}=not-the-state` } }))).status).toBe(400);

    const again = await createHarness();
    again.issuer.mutateNextIdToken(({ header, payload }) => ({ header, payload: { ...payload, nonce: 'forged-nonce' } }));
    const forged = await completeLogin(again.api, again.issuer);
    expect(forged.callback.status).toBe(400);
    expect(again.api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(0);
  });

  test('bad issuer, audience, signature, and expiry fail closed', async () => {
    const faults = [
      ({ header, payload }) => ({ header, payload: { ...payload, iss: 'https://evil.example' } }),
      ({ header, payload }) => ({ header, payload: { ...payload, aud: 'someone-else' } }),
      ({ header, payload }) => ({ header, payload, corruptSignature: true }),
      ({ header, payload }) => ({ header, payload: { ...payload, exp: Math.floor(NOW / 1000) - 120 } }),
    ];
    for (const mutate of faults) {
      const { api, issuer } = await createHarness();
      issuer.mutateNextIdToken(mutate);
      const result = await completeLogin(api, issuer);
      expect(result.callback.status).toBe(400);
      expect(api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(0);
      expect(api.database.query('SELECT count(*) count FROM external_identities').get().count).toBe(0);
    }
  });

  test('PKCE verifier is short-lived and one-time-use', async () => {
    let now = NOW;
    const { api, issuer } = await createHarness({ clock: () => now });
    const login = await beginLogin(api);
    const authorized = await authorize(issuer, login.location);
    now += LOGIN_STATE_DURATION_MS + 1;
    expect((await api.fetch(new Request(authorized.headers.get('location'), { headers: { cookie: login.cookie } }))).status).toBe(400);
    expect(api.database.query('SELECT consumed_at FROM login_transactions').get().consumed_at).toBeNull();
    expect(api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(0);
  });

  test('logout revokes the OIDC session server-side', async () => {
    const { api, issuer } = await createHarness();
    const { callback, sessionCookie } = await completeLogin(api, issuer);
    expect(callback.status).toBe(302);
    const session = await (await api.fetch(request('/api/auth/session', { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` } }))).json();
    const logout = await api.fetch(request('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`, 'x-csrf-token': session.csrfToken },
    }));
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await (await api.fetch(request('/api/auth/session', { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` } }))).json()).toBeNull();
    expect(api.database.query('SELECT revoked_at FROM sessions').get().revoked_at).toBe(NOW);
    expectNoProviderTokens([await logout.text(), ...logout.headers.getSetCookie()]);
  });

  test('POST callback completes the same authorization-code exchange', async () => {
    const { api, issuer } = await createHarness();
    const login = await beginLogin(api, '/owned');
    const authorized = await authorize(issuer, login.location);
    const callbackUrl = new URL(authorized.headers.get('location'));
    const callback = await api.fetch(new Request(`${callbackUrl.origin}${callbackUrl.pathname}`, {
      method: 'POST',
      headers: { cookie: login.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: callbackUrl.searchParams.toString(),
    }));
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/owned');
    expect(cookieValue(callback, SESSION_COOKIE_NAME)).toBeString();
    expect(api.database.query('SELECT subject FROM external_identities').get().subject).toBe('subject-1');
  });
});

describe('OIDC discovery, JWKS, and key rotation failures', () => {
  test('discovery network failures and invalid metadata fail safely with actionable logs', async () => {
    const network = await createHarness({
      fetch: async () => { throw new Error('ECONNREFUSED secret-should-not-leak'); },
    });
    const networkLogin = await beginLogin(network.api);
    expect(networkLogin.response.status).toBe(502);
    expect(await networkLogin.response.text()).not.toContain('secret-should-not-leak');
    expect(network.logs.entries.some((entry) => entry.level === 'error' && entry.message.includes('discovery_failed') && entry.details.reason === 'network_error')).toBe(true);

    const invalid = await createHarness();
    invalid.issuer.setMetadata({
      issuer: 'https://evil.example',
      authorization_endpoint: 'https://evil.example/authorize',
      token_endpoint: 'https://evil.example/token',
      jwks_uri: 'https://evil.example/jwks',
    });
    const invalidLogin = await beginLogin(invalid.api);
    expect(invalidLogin.response.status).toBe(502);
    expect(invalid.logs.entries.some((entry) => entry.details?.reason === 'issuer_mismatch')).toBe(true);
  });

  test('unknown kid refreshes JWKS and succeeds after rotation', async () => {
    const issuer = await createFakeOidcIssuer({ clock: () => NOW, randomBytes: deterministicRandom });
    let jwksCalls = 0;
    const fetchImpl = async (url, init) => {
      const response = await issuer.fetch(url, init);
      if (String(url).includes('/jwks') && jwksCalls++ === 0) {
        return Response.json({ keys: [{ ...issuer.publicJwk, kid: 'retired-key' }] });
      }
      return response;
    };
    const { api, logs } = await createHarness({ issuer, fetch: fetchImpl });
    const result = await completeLogin(api, issuer);
    expect(result.callback.status).toBe(302);
    expect(jwksCalls).toBeGreaterThanOrEqual(2);
    expect(logs.entries.some((entry) => entry.level === 'warn' && String(entry.message).includes('jwks_key_rotation'))).toBe(true);
    expect(logs.entries.some((entry) => entry.level === 'info' && entry.details?.reason === 'refreshed')).toBe(true);
  });

  test('key rotation still unknown after refresh fails closed', async () => {
    const issuer = await createFakeOidcIssuer({ clock: () => NOW, randomBytes: deterministicRandom });
    const fetchImpl = async (url, init) => {
      const response = await issuer.fetch(url, init);
      if (String(url).includes('/jwks')) return Response.json({ keys: [{ ...issuer.publicJwk, kid: 'other-key' }] });
      return response;
    };
    const { api, logs } = await createHarness({ issuer, fetch: fetchImpl });
    const result = await completeLogin(api, issuer);
    expect(result.callback.status).toBe(400);
    expect(api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(0);
    expect(logs.entries.some((entry) => entry.level === 'error' && String(entry.message).includes('jwks_key_rotation_failed'))).toBe(true);
  });
});
