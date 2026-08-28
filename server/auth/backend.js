import { Database } from 'bun:sqlite';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AUTH_MODES, AUTH_ROUTES, COOKIE_ATTRIBUTES, HMAC_ALGORITHM,
  LOGIN_STATE_COOKIE_NAME, LOGIN_STATE_DURATION_MS, MAX_COOKIE_VALUE_LENGTH,
  MAX_ISSUER_LENGTH, MAX_PROFILE_FIELD_LENGTH, MAX_SUBJECT_LENGTH,
  SESSION_COOKIE_NAME, SESSION_DURATION_MS, SESSION_TOKEN_BYTES,
} from './constants.js';
import { applyAuthMigrations } from './database.js';
import { createProviderRegistry } from './provider-registry.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;
const encode = (bytes) => Buffer.from(bytes).toString('base64url');
const token = (randomBytes, length) => encode(randomBytes(length));
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { ...JSON_HEADERS, ...headers } });
const fail = (status, code) => json({ error: { code } }, status);
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=${COOKIE_ATTRIBUTES.path}; HttpOnly; Secure; SameSite=${COOKIE_ATTRIBUTES.sameSite}; Max-Age=${maxAge}`;
const makeId = (randomBytes) => token(randomBytes, 18);
function secureRandom(length) { return crypto.getRandomValues(new Uint8Array(length)); }

export const validateReturnPath = (value) => typeof value === 'string' && value.length <= 2048 && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\r\n]/.test(value) ? value : null;
const safelyEqual = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

function readSecurityCookie(request, name) {
  const matches = [];
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    if (part.slice(0, index).trim() === name) matches.push(part.slice(index + 1).trim());
  }
  return matches.length === 0 ? undefined : matches.length === 1 ? matches[0] : null;
}

function decodeProviderId(pathname, prefix) {
  try { return decodeURIComponent(pathname.slice(prefix.length)); } catch { return undefined; }
}

function normalizeProviderResult(result) {
  const issuerValue = result?.identity?.issuer;
  const subject = result?.identity?.subject;
  if (typeof issuerValue !== 'string' || !issuerValue || issuerValue.length > MAX_ISSUER_LENGTH || typeof subject !== 'string' || !subject || subject.length > MAX_SUBJECT_LENGTH) return null;
  let issuer;
  try {
    const url = new URL(issuerValue);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    issuer = url.href;
  } catch { return null; }
  if (!result.user || typeof result.user !== 'object' || Array.isArray(result.user)) return null;
  const normalize = (value) => value == null ? null : typeof value === 'string' && value.length <= MAX_PROFILE_FIELD_LENGTH ? value : undefined;
  const displayName = normalize(result.user.displayName);
  const email = normalize(result.user.email);
  const avatarUrl = normalize(result.user.avatarUrl);
  if (displayName === undefined || email === undefined || avatarUrl === undefined) return null;
  return { issuer, subject, user: { displayName, email, avatarUrl } };
}

export function createAuthBackend(options = {}) {
  const { config, clock = () => Date.now(), randomBytes = secureRandom } = options;
  if (!config) throw new TypeError('Authentication configuration is required');
  if (config.mode === AUTH_MODES.DISABLED) return { fetch: () => fail(404, 'auth_disabled'), close() {} };
  if (typeof config.secret !== 'string' || config.secret.length < 32) throw new Error('Enabled authentication requires a 32+ character AUTH_SECRET');
  const keyedHash = (purpose, value) => createHmac(HMAC_ALGORITHM, config.secret).update(`neighborhood-guru:${purpose}\0`).update(value).digest('base64url');
  const database = options.database || new Database(config.databasePath, { create: true, strict: true });
  applyAuthMigrations(database);
  const registry = options.providerRegistry || createProviderRegistry(options.providers || []);

  function readSession(request) {
    const raw = readSecurityCookie(request, SESSION_COOKIE_NAME);
    if (typeof raw !== 'string' || raw.length > MAX_COOKIE_VALUE_LENGTH || !TOKEN_PATTERN.test(raw)) return null;
    const row = database.query(`SELECT sessions.id session_id, sessions.expires_at, sessions.revoked_at, sessions.csrf_hash,
      users.id user_id, users.display_name, users.email, users.avatar_url FROM sessions
      JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`).get(keyedHash('session', raw));
    return !row || row.revoked_at !== null || row.expires_at <= clock() ? null : { row, raw };
  }

  function newSession(userId, now) {
    const raw = token(randomBytes, SESSION_TOKEN_BYTES);
    const csrf = keyedHash('csrf-token', raw);
    return { id: makeId(randomBytes), userId, raw, csrf, tokenHash: keyedHash('session', raw), csrfHash: keyedHash('csrf', csrf), expiresAt: now + SESSION_DURATION_MS, now };
  }

  function issueSession(userId) {
    const session = newSession(userId, clock());
    database.run("INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)", [session.id, userId, session.tokenHash, session.csrfHash, session.expiresAt, session.now]);
    return { raw: session.raw, csrf: session.csrf, expiresAt: session.expiresAt };
  }

  async function handleCallback(request, provider, providerId) {
    const url = new URL(request.url);
    let form = null;
    try { form = request.method === 'POST' ? await request.clone().formData() : null; } catch { return fail(400, 'invalid_callback_state'); }
    const stateValue = request.method === 'POST' ? form?.get('state') : url.searchParams.get('state');
    const state = typeof stateValue === 'string' ? stateValue : '';
    if (!TOKEN_PATTERN.test(state) || state.length > MAX_COOKIE_VALUE_LENGTH) return fail(400, 'invalid_callback_state');
    if (request.method === 'GET') {
      const cookieState = readSecurityCookie(request, LOGIN_STATE_COOKIE_NAME);
      if (cookieState === null || (typeof cookieState === 'string' && !safelyEqual(state, cookieState))) return fail(400, 'invalid_callback_state');
    }
    const stateHash = keyedHash('login-state', state);
    const pending = database.query('SELECT provider_id, return_path, adapter_context, expires_at, consumed_at FROM login_transactions WHERE state_hash = ?').get(stateHash);
    if (!pending || pending.provider_id !== providerId || pending.consumed_at !== null || pending.expires_at <= clock()) return fail(400, 'invalid_callback_state');
    let result;
    try { result = await provider.exchangeCallback({ request, url, context: pending.adapter_context }); } catch { return fail(400, 'provider_callback_failed'); }
    const normalized = normalizeProviderResult(result);
    if (!normalized) return fail(400, 'invalid_provider_response');
    const previous = readSession(request);
    const now = clock();
    const replacement = newSession(null, now);
    try {
      database.transaction(() => {
        const consumed = database.run('UPDATE login_transactions SET consumed_at = ? WHERE state_hash = ? AND provider_id = ? AND consumed_at IS NULL AND expires_at > ?', [now, stateHash, providerId, now]);
        if (consumed.changes !== 1) throw new Error('LOGIN_TRANSACTION_CONSUMED');
        let identity = database.query('SELECT user_id FROM external_identities WHERE issuer = ? AND subject = ?').get(normalized.issuer, normalized.subject);
        let userId = identity?.user_id;
        if (!userId) {
          userId = makeId(randomBytes);
          database.run('INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [userId, normalized.user.displayName, normalized.user.email, normalized.user.avatarUrl, now, now]);
          database.run('INSERT INTO external_identities (id, user_id, issuer, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [makeId(randomBytes), userId, normalized.issuer, normalized.subject, now, now]);
        } else {
          database.run('UPDATE users SET display_name = ?, email = ?, avatar_url = ?, updated_at = ? WHERE id = ?', [normalized.user.displayName, normalized.user.email, normalized.user.avatarUrl, now, userId]);
        }
        if (previous) database.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now, previous.row.session_id]);
        replacement.userId = userId;
        database.run('INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)', [replacement.id, userId, replacement.tokenHash, replacement.csrfHash, replacement.expiresAt, now]);
        options.beforeCallbackCommit?.({ database, userId, replacement });
      }).immediate();
    } catch (error) {
      if (error?.message === 'LOGIN_TRANSACTION_CONSUMED') return fail(400, 'invalid_callback_state');
      return fail(500, 'auth_internal_error');
    }
    const headers = new Headers({ location: pending.return_path, 'cache-control': 'no-store' });
    headers.append('set-cookie', setCookie(SESSION_COOKIE_NAME, replacement.raw, SESSION_DURATION_MS / 1000));
    headers.append('set-cookie', setCookie(LOGIN_STATE_COOKIE_NAME, '', 0));
    return new Response(null, { status: 302, headers });
  }

  async function fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === AUTH_ROUTES.PROVIDERS && request.method === 'GET') return json(registry.list());
      if (url.pathname === AUTH_ROUTES.SESSION && request.method === 'GET') {
        const session = readSession(request);
        if (!session) return config.mode === AUTH_MODES.REQUIRED ? fail(401, 'authentication_required') : json(null);
        const { row } = session;
        return json({ user: { id: row.user_id, displayName: row.display_name, email: row.email, avatarUrl: row.avatar_url }, expiresAt: new Date(row.expires_at).toISOString(), csrfToken: keyedHash('csrf-token', session.raw) });
      }
      if (url.pathname.startsWith(AUTH_ROUTES.LOGIN_PREFIX) && request.method === 'GET') {
        const providerId = decodeProviderId(url.pathname, AUTH_ROUTES.LOGIN_PREFIX);
        if (providerId === undefined) return fail(400, 'malformed_provider_id');
        const provider = registry.get(providerId);
        if (!provider) return fail(404, 'provider_not_found');
        const returnPath = validateReturnPath(url.searchParams.get('returnPath') || '/');
        if (!returnPath) return fail(400, 'invalid_return_path');
        const state = token(randomBytes, SESSION_TOKEN_BYTES);
        const now = clock();
        let authorization;
        try { authorization = await provider.createAuthorizationUrl({ state, returnPath }); } catch { return fail(502, 'provider_login_failed'); }
        const location = typeof authorization === 'string' ? authorization : authorization?.location;
        const context = typeof authorization === 'object' && authorization?.context != null ? JSON.stringify(authorization.context) : null;
        if (typeof location !== 'string') return fail(502, 'provider_login_failed');
        database.run('INSERT INTO login_transactions (id, state_hash, provider_id, return_path, adapter_context, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)', [makeId(randomBytes), keyedHash('login-state', state), providerId, returnPath, context, now, now + LOGIN_STATE_DURATION_MS]);
        const headers = new Headers({ location, 'cache-control': 'no-store' });
        headers.append('set-cookie', setCookie(LOGIN_STATE_COOKIE_NAME, state, LOGIN_STATE_DURATION_MS / 1000));
        return new Response(null, { status: 302, headers });
      }
      if (url.pathname.startsWith(AUTH_ROUTES.CALLBACK_PREFIX) && (request.method === 'GET' || request.method === 'POST')) {
        const providerId = decodeProviderId(url.pathname, AUTH_ROUTES.CALLBACK_PREFIX);
        if (providerId === undefined) return fail(400, 'malformed_provider_id');
        const provider = registry.get(providerId);
        return provider ? handleCallback(request, provider, providerId) : fail(404, 'provider_not_found');
      }
      if (url.pathname === AUTH_ROUTES.LOGOUT && request.method === 'POST') {
        const session = readSession(request);
        if (!session) return fail(401, 'invalid_session');
        const csrf = request.headers.get('x-csrf-token') || '';
        if (!csrf || !safelyEqual(keyedHash('csrf', csrf), session.row.csrf_hash)) return fail(403, 'csrf_rejected');
        database.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [clock(), session.row.session_id]);
        const headers = new Headers(JSON_HEADERS); headers.append('set-cookie', setCookie(SESSION_COOKIE_NAME, '', 0));
        return json({ ok: true }, 200, Object.fromEntries(headers));
      }
      return fail(404, 'not_found');
    } catch { return fail(500, 'auth_internal_error'); }
  }
  return { fetch, database, readSession, issueSession, close: () => { if (!options.database) database.close(); } };
}
