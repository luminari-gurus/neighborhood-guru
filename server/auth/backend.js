import { Database } from 'bun:sqlite';
import { timingSafeEqual } from 'node:crypto';
import { AUTH_MODES, AUTH_ROUTES, COOKIE_ATTRIBUTES, CSRF_TOKEN_BYTES, HASH_ALGORITHM, LOGIN_STATE_COOKIE_NAME, LOGIN_STATE_DURATION_MS, MAX_COOKIE_VALUE_LENGTH, SESSION_COOKIE_NAME, SESSION_DURATION_MS, SESSION_TOKEN_BYTES } from './constants.js';
import { applyAuthMigrations } from './database.js';
import { createProviderRegistry } from './provider-registry.js';

const encoder = new TextEncoder();
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const encode = (bytes) => Buffer.from(bytes).toString('base64url');
const token = (randomBytes, length) => encode(randomBytes(length));
const hash = async (value) => encode(new Uint8Array(await crypto.subtle.digest(HASH_ALGORITHM, encoder.encode(value))));
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { ...JSON_HEADERS, ...headers } });
const fail = (status, code) => json({ error: { code } }, status);
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=${COOKIE_ATTRIBUTES.path}; HttpOnly; Secure; SameSite=${COOKIE_ATTRIBUTES.sameSite}; Max-Age=${maxAge}`;
const cookies = (request) => Object.fromEntries((request.headers.get('cookie') || '').split(';').map((part) => part.trim().split('=')).filter(([key, value]) => key && value));
export const validateReturnPath = (value) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\r\n]/.test(value) ? value : null;
const safelyEqual = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const makeId = (randomBytes) => token(randomBytes, 18);
function secureRandom(length) { return crypto.getRandomValues(new Uint8Array(length)); }

export function createAuthBackend(options = {}) {
  const { config, clock = () => Date.now(), randomBytes = secureRandom } = options;
  if (!config) throw new TypeError('Authentication configuration is required');
  if (config.mode === AUTH_MODES.DISABLED) return { fetch: () => fail(404, 'auth_disabled'), close() {} };
  const database = options.database || new Database(config.databasePath, { create: true });
  applyAuthMigrations(database);
  const registry = options.providerRegistry || createProviderRegistry(options.providers || []);

  async function readSession(request) {
    const raw = cookies(request)[SESSION_COOKIE_NAME];
    if (!raw || raw.length > MAX_COOKIE_VALUE_LENGTH || !/^[A-Za-z0-9_-]{40,128}$/.test(raw)) return null;
    const row = database.query(`SELECT sessions.id session_id, sessions.expires_at, sessions.revoked_at, sessions.csrf_hash,
      users.id user_id, users.display_name, users.email, users.avatar_url FROM sessions
      JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`).get(await hash(raw));
    return !row || row.revoked_at !== null || row.expires_at <= clock() ? null : { row, raw };
  }
  async function issueSession(userId) {
    const raw = token(randomBytes, SESSION_TOKEN_BYTES);
    const csrf = token(randomBytes, CSRF_TOKEN_BYTES);
    const now = clock();
    database.run('INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)', [makeId(randomBytes), userId, await hash(raw), await hash(csrf), now + SESSION_DURATION_MS, now]);
    return { raw, csrf, expiresAt: now + SESSION_DURATION_MS };
  }
  async function handleCallback(request, provider) {
    const url = new URL(request.url);
    const form = request.method === 'POST' ? await request.clone().formData() : null;
    const state = url.searchParams.get('state') || form?.get('state');
    const stored = cookies(request)[LOGIN_STATE_COOKIE_NAME];
    if (!state || !stored || state.length > MAX_COOKIE_VALUE_LENGTH || !safelyEqual(state, stored)) return fail(400, 'invalid_callback_state');
    let result;
    try { result = await provider.exchangeCallback({ request, url }); } catch { return fail(400, 'provider_callback_failed'); }
    if (!result?.identity?.issuer || !result?.identity?.subject || !result?.user) return fail(400, 'invalid_provider_response');
    if (!validateReturnPath(result.returnPath || '/')) return fail(400, 'invalid_return_path');
    const now = clock();
    let userId = database.query('SELECT user_id FROM external_identities WHERE issuer = ? AND subject = ?').get(result.identity.issuer, result.identity.subject)?.user_id;
    if (!userId) {
      userId = makeId(randomBytes);
      database.transaction(() => {
        database.run('INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [userId, result.user.displayName ?? null, result.user.email ?? null, result.user.avatarUrl ?? null, now, now]);
        database.run('INSERT INTO external_identities (id, user_id, issuer, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [makeId(randomBytes), userId, result.identity.issuer, result.identity.subject, now, now]);
      })();
    }
    const previous = await readSession(request);
    if (previous) database.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now, previous.row.session_id]);
    const session = await issueSession(userId);
    return new Response(null, { status: 302, headers: { location: result.returnPath || '/', 'set-cookie': `${setCookie(SESSION_COOKIE_NAME, session.raw, SESSION_DURATION_MS / 1000)}, ${setCookie(LOGIN_STATE_COOKIE_NAME, '', 0)}`, 'cache-control': 'no-store' } });
  }
  async function fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === AUTH_ROUTES.PROVIDERS && request.method === 'GET') return json(registry.list());
      if (url.pathname === AUTH_ROUTES.SESSION && request.method === 'GET') {
        const session = await readSession(request);
        if (!session) return config.mode === AUTH_MODES.REQUIRED ? fail(401, 'authentication_required') : json(null);
        const { row } = session;
        return json({ user: { id: row.user_id, displayName: row.display_name, email: row.email, avatarUrl: row.avatar_url }, expiresAt: new Date(row.expires_at).toISOString(), csrfToken: await issueCsrf(row.session_id, database, randomBytes) });
      }
      if (url.pathname.startsWith(AUTH_ROUTES.LOGIN_PREFIX) && request.method === 'GET') {
        const provider = registry.get(decodeURIComponent(url.pathname.slice(AUTH_ROUTES.LOGIN_PREFIX.length)));
        if (!provider) return fail(404, 'provider_not_found');
        const returnPath = validateReturnPath(url.searchParams.get('returnPath') || '/');
        if (!returnPath) return fail(400, 'invalid_return_path');
        const state = token(randomBytes, SESSION_TOKEN_BYTES);
        let location;
        try { location = await provider.createAuthorizationUrl({ state, returnPath }); } catch { return fail(502, 'provider_login_failed'); }
        return new Response(null, { status: 302, headers: { location, 'set-cookie': setCookie(LOGIN_STATE_COOKIE_NAME, state, LOGIN_STATE_DURATION_MS / 1000), 'cache-control': 'no-store' } });
      }
      if (url.pathname.startsWith(AUTH_ROUTES.CALLBACK_PREFIX) && (request.method === 'GET' || request.method === 'POST')) {
        const provider = registry.get(decodeURIComponent(url.pathname.slice(AUTH_ROUTES.CALLBACK_PREFIX.length)));
        return provider ? handleCallback(request, provider) : fail(404, 'provider_not_found');
      }
      if (url.pathname === AUTH_ROUTES.LOGOUT && request.method === 'POST') {
        const session = await readSession(request);
        if (!session) return fail(401, 'invalid_session');
        const csrf = request.headers.get('x-csrf-token') || '';
        if (!csrf || !safelyEqual(await hash(csrf), session.row.csrf_hash)) return fail(403, 'csrf_rejected');
        database.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [clock(), session.row.session_id]);
        return json({ ok: true }, 200, { 'set-cookie': setCookie(SESSION_COOKIE_NAME, '', 0) });
      }
      return fail(404, 'not_found');
    } catch { return fail(500, 'auth_internal_error'); }
  }
  return { fetch, database, issueSession, close: () => { if (!options.database) database.close(); } };
}

async function issueCsrf(sessionId, database, randomBytes) {
  const csrf = token(randomBytes, CSRF_TOKEN_BYTES);
  database.run('UPDATE sessions SET csrf_hash = ? WHERE id = ?', [await hash(csrf), sessionId]);
  return csrf;
}
