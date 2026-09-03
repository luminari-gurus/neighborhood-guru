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
import { formEncode } from '../../server/auth/oidc/client.js';
import { loadOidcConfig } from '../../server/auth/oidc/config.js';
import { OIDC_ID_TOKEN_TTL_SECONDS, OIDC_MAX_RESPONSE_BYTES } from '../../server/auth/oidc/constants.js';
import { createServer } from '../../server/server.js';
import { createFakeOidcIssuer, generateEs256KeyPair, signJwt } from './fake-oidc-issuer.js';

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

async function createHarness({ issuer, issuerOptions, fetch: fetchImpl, logger, clock, clientSecret = null } = {}) {
  issuer = issuer || await createFakeOidcIssuer({ clock: clock || (() => NOW), randomBytes: deterministicRandom, clientSecret, ...issuerOptions });
  const logs = logger || capturingLogger();
  const database = new Database(':memory:');
  databases.push(database);
  const provider = createOidcProvider({
    issuer: issuer.issuer,
    clientId: issuer.clientId,
    clientSecret,
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

  test('client id and secret keep leading, trailing, and all-space values', () => {
    const spaced = loadOidcConfig({
      OIDC_ISSUER: 'https://issuer.example/',
      OIDC_CLIENT_ID: ' client ',
      OIDC_CLIENT_SECRET: ' secret ',
    });
    expect(spaced.clientId).toBe(' client ');
    expect(spaced.clientSecret).toBe(' secret ');
    const blankSecret = loadOidcConfig({
      OIDC_ISSUER: 'https://issuer.example/',
      OIDC_CLIENT_ID: 'id',
      OIDC_CLIENT_SECRET: '   ',
    });
    expect(blankSecret.clientId).toBe('id');
    expect(blankSecret.clientSecret).toBe('   ');
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

  test('disabled mode ignores partial OIDC environment and does not construct a provider', async () => {
    const config = loadAuthConfig({ AUTH_MODE: 'disabled', OIDC_ISSUER: 'https://issuer.example' });
    expect(config.mode).toBe(AUTH_MODES.DISABLED);
    expect(config.oidc).toBeNull();
    expect(() => loadOidcConfig({ OIDC_ISSUER: 'https://issuer.example' })).toThrow('OIDC_CLIENT_ID');
    const instance = createServer({
      config: { mode: AUTH_MODES.DISABLED, databasePath: ':memory:', secret: '', production: false, oidc: { issuer: 'https://issuer.example' } },
      serve: false,
    });
    expect((await instance.fetch(request('/api/auth/providers'))).status).toBe(404);
    instance.close();
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

  test('bad issuer, audience, signature, expiry, and issued-at fail closed', async () => {
    const now = Math.floor(NOW / 1000);
    const faults = [
      ({ header, payload }) => ({ header, payload: { ...payload, iss: 'https://evil.example' } }),
      ({ header, payload }) => ({ header, payload: { ...payload, aud: 'someone-else' } }),
      ({ header, payload }) => ({ header, payload, corruptSignature: true }),
      ({ header, payload }) => ({ header, payload: { ...payload, exp: now - 120 } }),
      ({ header, payload }) => {
        const next = { ...payload };
        delete next.iat;
        return { header, payload: next };
      },
      ({ header, payload }) => ({ header, payload: { ...payload, iat: now - OIDC_ID_TOKEN_TTL_SECONDS - 120, exp: now + 300 } }),
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

  test('chunked responses without Content-Length are cancelled at the byte bound', async () => {
    const encoder = new TextEncoder();
    let produced = 0;
    let cancelled = false;
    const fetchImpl = async () => new Response(new ReadableStream({
      pull(controller) {
        produced += 2048;
        controller.enqueue(encoder.encode(`{"pad":"${'a'.repeat(2040)}"}`));
      },
      cancel() {
        cancelled = true;
      },
    }), { headers: { 'content-type': 'application/json' } });
    const { api, logs } = await createHarness({ fetch: fetchImpl });
    const login = await beginLogin(api);
    expect(login.response.status).toBe(502);
    expect(cancelled).toBe(true);
    expect(produced).toBeGreaterThan(OIDC_MAX_RESPONSE_BYTES);
    expect(produced).toBeLessThan(OIDC_MAX_RESPONSE_BYTES + 8192);
    expect(logs.entries.some((entry) => entry.details?.reason === 'response_too_large')).toBe(true);
  });

  test('authorization, token, and JWKS query components are preserved', async () => {
    const requested = [];
    const issuer = await createFakeOidcIssuer({
      clock: () => NOW,
      randomBytes: deterministicRandom,
      endpointQuery: 'tenant=acme',
    });
    const fetchImpl = async (url, init) => {
      requested.push(String(url));
      return issuer.fetch(url, init);
    };
    const { api } = await createHarness({ issuer, fetch: fetchImpl });
    const result = await completeLogin(api, issuer);
    expect(result.callback.status).toBe(302);
    const authorize = new URL(result.login.location);
    expect(authorize.searchParams.get('tenant')).toBe('acme');
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(requested.some((url) => url.includes('/token?tenant=acme'))).toBe(true);
    expect(requested.some((url) => url.includes('/jwks?tenant=acme'))).toBe(true);
  });

  test('endpoint fragments remain rejected', async () => {
    const { api, issuer, logs } = await createHarness();
    issuer.setMetadata({
      ...issuer.metadata,
      authorization_endpoint: `${issuer.issuer}/authorize#frag`,
    });
    const login = await beginLogin(api);
    expect(login.response.status).toBe(502);
    expect(logs.entries.some((entry) => entry.details?.detail === 'endpoint_fragment' || entry.details?.reason === 'invalid_metadata')).toBe(true);
  });

  test('confidential clients use client_secret_basic when discovery omits auth methods', async () => {
    const { api, issuer } = await createHarness({
      clientSecret: 's3cret-value',
      issuerOptions: { omitTokenAuthMethods: true },
    });
    const result = await completeLogin(api, issuer);
    expect(result.callback.status).toBe(302);
    expect(issuer.lastTokenAuth).toEqual({
      method: 'client_secret_basic',
      clientId: issuer.clientId,
      clientSecret: 's3cret-value',
      encoded: `${formEncode(issuer.clientId)}:${formEncode('s3cret-value')}`,
      bodyHasSecret: false,
    });
  });

  test('confidential clients use client_secret_post when advertised', async () => {
    const { api, issuer } = await createHarness({
      clientSecret: 's3cret-value',
      issuerOptions: { tokenEndpointAuthMethods: ['client_secret_post'], requireTokenAuth: 'client_secret_post' },
    });
    const result = await completeLogin(api, issuer);
    expect(result.callback.status).toBe(302);
    expect(issuer.lastTokenAuth).toEqual({
      method: 'client_secret_post',
      clientId: issuer.clientId,
      clientSecret: 's3cret-value',
      bodyHasSecret: true,
    });
  });

  test('unsupported token endpoint auth methods fail closed', async () => {
    const { api, logs } = await createHarness({
      clientSecret: 's3cret-value',
      issuerOptions: { tokenEndpointAuthMethods: ['private_key_jwt'] },
    });
    const login = await beginLogin(api);
    expect(login.response.status).toBe(502);
    expect(logs.entries.some((entry) => entry.details?.reason === 'unsupported_token_auth')).toBe(true);
  });

  test('omitted token auth metadata does not select none for a public client', async () => {
    const { api, logs } = await createHarness({ issuerOptions: { omitTokenAuthMethods: true } });
    const login = await beginLogin(api);
    expect(login.response.status).toBe(502);
    expect(logs.entries.some((entry) => entry.details?.reason === 'unsupported_token_auth')).toBe(true);
    expect(logs.entries.some((entry) => entry.details?.detail === 'public')).toBe(true);
  });

  test('client_secret_basic form-encodes spaces and special credential characters', async () => {
    const clientId = 'id !~()\'';
    const clientSecret = 'secret !~()\'';
    const { api, issuer } = await createHarness({
      clientSecret,
      issuerOptions: { clientId, omitTokenAuthMethods: true, strictBasicEncoding: true },
    });
    const result = await completeLogin(api, issuer);
    expect(result.callback.status).toBe(302);
    expect(issuer.lastTokenAuth.encoded).toBe('id+%21%7E%28%29%27:secret+%21%7E%28%29%27');
    expect(issuer.lastTokenAuth.encoded).toBe(`${formEncode(clientId)}:${formEncode(clientSecret)}`);
    expect(issuer.lastTokenAuth.bodyHasSecret).toBe(false);
  });

  test('oversized cancel after an incomplete UTF-8 sequence does not poison the next response', async () => {
    const issuer = await createFakeOidcIssuer({ clock: () => NOW, randomBytes: deterministicRandom });
    let discoveryCalls = 0;
    const fetchImpl = async (url, init) => {
      if (String(url).includes('.well-known')) {
        discoveryCalls += 1;
        if (discoveryCalls === 1) {
          const prefix = new Uint8Array(OIDC_MAX_RESPONSE_BYTES);
          prefix.fill(0x61);
          prefix[0] = 0x7b;
          prefix[prefix.length - 1] = 0xc3;
          const overflow = new Uint8Array([0xa9, 0x61]);
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(prefix);
              controller.enqueue(overflow);
              controller.close();
            },
          }), { headers: { 'content-type': 'application/json' } });
        }
      }
      return issuer.fetch(url, init);
    };
    const { api } = await createHarness({ issuer, fetch: fetchImpl });
    expect((await beginLogin(api)).response.status).toBe(502);
    expect((await beginLogin(api)).response.status).toBe(302);
  });

  test('concurrent bounded JSON reads do not interleave decoder state', async () => {
    const issuer = await createFakeOidcIssuer({ clock: () => NOW, randomBytes: deterministicRandom });
    const encoder = new TextEncoder();
    const fetchImpl = async (url, init) => {
      if (String(url).includes('.well-known')) {
        const json = encoder.encode(JSON.stringify(issuer.metadata));
        return new Response(new ReadableStream({
          async start(controller) {
            for (let offset = 0; offset < json.length; offset += 7) {
              controller.enqueue(json.subarray(offset, offset + 7));
              await Promise.resolve();
            }
            controller.close();
          },
        }), { headers: { 'content-type': 'application/json' } });
      }
      return issuer.fetch(url, init);
    };
    const first = await createHarness({ issuer, fetch: fetchImpl });
    const second = await createHarness({ issuer, fetch: fetchImpl });
    const [left, right] = await Promise.all([beginLogin(first.api), beginLogin(second.api)]);
    expect(left.response.status).toBe(302);
    expect(right.response.status).toBe(302);
  });

  test('non-success provider bodies are cancelled before discovery returns', async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const fetchImpl = async () => new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(encoder.encode(`{"error":"${'x'.repeat(2048)}"}`));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 500, headers: { 'content-type': 'application/json' } });
    const { api, logs } = await createHarness({ fetch: fetchImpl });
    const login = await beginLogin(api);
    expect(login.response.status).toBe(502);
    expect(cancelled).toBe(true);
    expect(logs.entries.some((entry) => entry.details?.reason === 'http_error')).toBe(true);
  });

  test('malformed Content-Length cancels the body without reading it', async () => {
    let cancelled = false;
    const fetchImpl = async () => new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(2048));
      },
      cancel() {
        cancelled = true;
      },
    }), { headers: { 'content-type': 'application/json', 'content-length': 'nope' } });
    const { api, logs } = await createHarness({ fetch: fetchImpl });
    expect((await beginLogin(api)).response.status).toBe(502);
    expect(cancelled).toBe(true);
    expect(logs.entries.some((entry) => entry.details?.reason === 'invalid_content_length')).toBe(true);
  });

  test('malformed token_endpoint_auth_methods_supported is rejected rather than defaulted', async () => {
    const values = ['client_secret_basic', null, { method: 'client_secret_basic' }, ['client_secret_basic', 42], []];
    for (const value of values) {
      const { api, issuer, logs } = await createHarness({ clientSecret: 's3cret-value' });
      issuer.setMetadata({ ...issuer.metadata, token_endpoint_auth_methods_supported: value });
      expect((await beginLogin(api)).response.status).toBe(502);
      expect(logs.entries.some((entry) => entry.details?.reason === 'invalid_metadata' && entry.details?.detail === 'token_endpoint_auth_methods_supported')).toBe(true);
    }
  });

  test('required discovery capabilities reject absent, malformed, and incompatible values', async () => {
    const fields = ['response_types_supported', 'subject_types_supported', 'id_token_signing_alg_values_supported'];
    const malformed = ['code', null, { value: 'code' }, [], ['code', 42]];
    for (const field of fields) {
      const omitted = await createHarness();
      const missing = { ...omitted.issuer.metadata };
      delete missing[field];
      omitted.issuer.setMetadata(missing);
      expect((await beginLogin(omitted.api)).response.status).toBe(502);
      expect(omitted.logs.entries.some((entry) => entry.details?.detail === field || entry.details?.reason === 'unsupported_algorithm')).toBe(true);
      for (const value of malformed) {
        const { api, issuer, logs } = await createHarness();
        issuer.setMetadata({ ...issuer.metadata, [field]: value });
        expect((await beginLogin(api)).response.status).toBe(502);
        expect(logs.entries.some((entry) => entry.details?.reason === 'invalid_metadata' && entry.details?.detail === field)).toBe(true);
      }
    }
    const noCode = await createHarness();
    noCode.issuer.setMetadata({ ...noCode.issuer.metadata, response_types_supported: ['id_token'] });
    expect((await beginLogin(noCode.api)).response.status).toBe(502);
    expect(noCode.logs.entries.some((entry) => entry.details?.detail === 'response_types_supported')).toBe(true);
    const hs256 = await createHarness();
    hs256.issuer.setMetadata({ ...hs256.issuer.metadata, id_token_signing_alg_values_supported: ['HS256'] });
    expect((await beginLogin(hs256.api)).response.status).toBe(502);
    expect(hs256.logs.entries.some((entry) => entry.details?.reason === 'unsupported_algorithm')).toBe(true);
  });

  test('opaque client credentials are preserved on the token request', async () => {
    const cases = [
      { clientId: ' client ', clientSecret: ' secret ' },
      { clientId: 'id', clientSecret: '   ' },
    ];
    for (const credentials of cases) {
      const { api, issuer } = await createHarness({
        clientSecret: credentials.clientSecret,
        issuerOptions: {
          clientId: credentials.clientId,
          omitTokenAuthMethods: true,
          strictBasicEncoding: true,
        },
      });
      const result = await completeLogin(api, issuer);
      expect(result.callback.status).toBe(302);
      expect(issuer.lastTokenAuth.clientId).toBe(credentials.clientId);
      expect(issuer.lastTokenAuth.clientSecret).toBe(credentials.clientSecret);
      expect(issuer.lastTokenAuth.encoded).toBe(`${formEncode(credentials.clientId)}:${formEncode(credentials.clientSecret)}`);
    }
  });

  test('ID tokens require a single trusted audience and matching azp', async () => {
    const faults = [
      ({ header, payload }) => ({ header, payload: { ...payload, aud: [payload.aud, 'untrusted'], azp: payload.aud } }),
      ({ header, payload }) => ({ header, payload: { ...payload, azp: 'different-client' } }),
      ({ header, payload }) => ({ header, payload: { ...payload, azp: ['client'] } }),
    ];
    for (const mutate of faults) {
      const { api, issuer } = await createHarness();
      issuer.mutateNextIdToken(mutate);
      const result = await completeLogin(api, issuer);
      expect(result.callback.status).toBe(400);
      expect(api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(0);
    }
  });

  test('malformed UTF-8 in discovery JSON is rejected', async () => {
    const issuer = await createFakeOidcIssuer({ clock: () => NOW, randomBytes: deterministicRandom });
    const fetchImpl = async (url, init) => {
      if (String(url).includes('.well-known')) {
        const bytes = Buffer.from(JSON.stringify({ ...issuer.metadata, pad: 'GOODPAD' }));
        bytes[bytes.indexOf(Buffer.from('GOODPAD'))] = 0xff;
        return new Response(bytes, { headers: { 'content-type': 'application/json' } });
      }
      return issuer.fetch(url, init);
    };
    const { api, logs } = await createHarness({ issuer, fetch: fetchImpl });
    expect((await beginLogin(api)).response.status).toBe(502);
    expect(logs.entries.some((entry) => entry.details?.reason === 'invalid_json')).toBe(true);
  });

  test('malformed UTF-8 in a signed ID-token subject is rejected', async () => {
    const { api, issuer } = await createHarness();
    issuer.mutateNextIdToken(async ({ header, payload, signRaw }) => {
      const bytes = Buffer.from(JSON.stringify({ ...payload, sub: 'user?' }));
      bytes[bytes.indexOf('?'.charCodeAt(0))] = 0xff;
      return { idToken: await signRaw(header, bytes) };
    });
    const result = await completeLogin(api, issuer);
    expect(result.callback.status).toBe(400);
    expect(api.database.query('SELECT count(*) count FROM users').get().count).toBe(0);
    expect(api.database.query('SELECT count(*) count FROM external_identities').get().count).toBe(0);
  });

  test('unsupported and malformed crit headers are rejected', async () => {
    for (const crit of [['unsupported'], 'unsupported', [1], []]) {
      const { api, issuer } = await createHarness();
      issuer.mutateNextIdToken(({ header, payload }) => ({ header: { ...header, crit }, payload }));
      const result = await completeLogin(api, issuer);
      expect(result.callback.status).toBe(400);
      expect(api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(0);
    }
  });

  test('JWKS key_ops and use constraints are honored', async () => {
    const restrictions = [
      (jwk) => ({ ...jwk, key_ops: ['encrypt'] }),
      (jwk) => ({ ...jwk, key_ops: ['sign'] }),
      (jwk) => ({ ...jwk, use: 'sig', key_ops: ['verify', 'encrypt'] }),
      (jwk) => ({ ...jwk, key_ops: ['verify', 'verify'] }),
    ];
    for (const mutate of restrictions) {
      const { api, issuer } = await createHarness();
      issuer.mutatePublicJwk(mutate);
      const result = await completeLogin(api, issuer);
      expect(result.callback.status).toBe(400);
      expect(api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(0);
    }
  });

  test('ID token alg must match the advertised discovery intersection', async () => {
    const es256 = await generateEs256KeyPair('es-key');
    const rs256Advertised = await createHarness();
    rs256Advertised.issuer.setMetadata({
      ...rs256Advertised.issuer.metadata,
      id_token_signing_alg_values_supported: ['RS256'],
    });
    rs256Advertised.issuer.addPublicJwk(es256.publicJwk);
    rs256Advertised.issuer.mutateNextIdToken(async ({ header, payload }) => ({
      idToken: await signJwt(es256.privateKey, { ...header, alg: 'ES256', kid: es256.publicJwk.kid }, payload),
    }));
    const esToken = await completeLogin(rs256Advertised.api, rs256Advertised.issuer);
    expect(esToken.callback.status).toBe(400);
    expect(rs256Advertised.api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(0);

    const es256Advertised = await createHarness();
    es256Advertised.issuer.setMetadata({
      ...es256Advertised.issuer.metadata,
      id_token_signing_alg_values_supported: ['ES256'],
    });
    es256Advertised.issuer.addPublicJwk(es256.publicJwk);
    const rsToken = await completeLogin(es256Advertised.api, es256Advertised.issuer);
    expect(rsToken.callback.status).toBe(400);
    expect(es256Advertised.api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(0);
  });

  test('malformed present kid is rejected rather than treated as absent', async () => {
    for (const kid of [42, null, '']) {
      const { api, issuer } = await createHarness();
      issuer.mutateNextIdToken(({ header, payload }) => ({ header: { ...header, kid }, payload }));
      const result = await completeLogin(api, issuer);
      expect(result.callback.status).toBe(400);
      expect(api.database.query('SELECT count(*) count FROM sessions').get().count).toBe(0);
    }
  });
});
