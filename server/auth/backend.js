import { Database } from 'bun:sqlite';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AUTH_MODES, AUTH_ROUTES, COOKIE_ATTRIBUTES, HMAC_ALGORITHM,
  LOGIN_STATE_COOKIE_NAME, LOGIN_STATE_DURATION_MS, MAX_ADAPTER_CONTEXT_BYTES,
  MAX_CALLBACK_BODY_BYTES, MAX_COOKIE_VALUE_LENGTH, MAX_ISSUER_LENGTH,
  MAX_PROFILE_FIELD_LENGTH, MAX_PROVIDER_ID_LENGTH, MAX_SUBJECT_LENGTH,
  SESSION_COOKIE_NAME, SESSION_DURATION_MS, SESSION_TOKEN_BYTES,
} from './constants.js';
import { applyAuthMigrations } from './database.js';
import { createProviderRegistry } from './provider-registry.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;
const FORM_URLENCODED = /^application\/x-www-form-urlencoded(?:\s*;.*)?$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (bytes) => Buffer.from(bytes).toString('base64url');
const token = (randomBytes, length) => encode(randomBytes(length));
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { ...JSON_HEADERS, ...headers } });
const fail = (status, code) => json({ error: { code } }, status);
const setCookie = (name, value, maxAge, sameSite = COOKIE_ATTRIBUTES.sameSite) => `${name}=${value}; Path=${COOKIE_ATTRIBUTES.path}; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}`;
const makeId = (randomBytes) => token(randomBytes, 18);
function secureRandom(length) { return crypto.getRandomValues(new Uint8Array(length)); }
const utf8Length = (value) => encoder.encode(value).byteLength;
const safelyEqual = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const unsafeContextKeys = new Set(['__proto__', 'constructor', 'prototype']);

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

function isLoopback(hostname) { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'; }
function secureAbsoluteUrl(value, production) {
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) return null;
  try { const url = new URL(value); if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production && isLoopback(url.hostname)))) return null; return url; } catch { return null; }
}

function validateReturnPath(value) { return typeof value === 'string' && value.length <= 2048 && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\r\n]/.test(value) ? value : null; }
function isValidProviderId(providerId) { return typeof providerId === 'string' && providerId.length <= MAX_PROVIDER_ID_LENGTH && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(providerId); }

function validateAdapterContext(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return true;
  if (typeof value === 'number' || typeof value === 'undefined' || typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'function') {
    throw new TypeError('Unsupported adapter context');
  }
  if (seen.has(value)) throw new TypeError('Circular adapter context');
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('Unsupported adapter context');
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('Unsupported adapter context');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') || lengthDescriptor.get || lengthDescriptor.set || lengthDescriptor.enumerable || typeof lengthDescriptor.value !== 'number' || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 0xffffffff) throw new TypeError('Invalid adapter context');
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.get || descriptor.set || !descriptor.enumerable) throw new TypeError('Invalid adapter context');
      validateAdapterContext(descriptor.value, seen);
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'length') {
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.get || descriptor.set || descriptor.enumerable || !Number.isSafeInteger(descriptor.value) || descriptor.value !== value.length) {
          throw new TypeError('Invalid adapter context');
        }
        continue;
      }
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) throw new TypeError('Invalid adapter context');
      const entry = descriptors[key];
      if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'value') || entry.get || entry.set) throw new TypeError('Invalid adapter context');
    }
    return true;
  }

  if (typeof value !== 'object') throw new TypeError('Unsupported adapter context');
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Unsupported adapter context');
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('Unsupported adapter context');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.get || descriptor.set || unsafeContextKeys.has(key)) {
      throw new TypeError('Unsupported adapter context');
    }
    validateAdapterContext(descriptor.value, seen);
  }
  return true;
}

function serializeContext(value) {
  validateAdapterContext(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || utf8Length(serialized) > MAX_ADAPTER_CONTEXT_BYTES) throw new TypeError('Invalid adapter context');
  return serialized;
}

function parseAdapterContext(value) {
  if (typeof value === 'string' && utf8Length(value) > MAX_ADAPTER_CONTEXT_BYTES) throw new TypeError('Invalid adapter context');
  const parsed = JSON.parse(value);
  validateAdapterContext(parsed);
  return parsed;
}

function normalizeProviderResult(result, production) {
  const issuerValue = result?.identity?.issuer;
  const subject = result?.identity?.subject;
  if (typeof issuerValue !== 'string' || !issuerValue || issuerValue.length > MAX_ISSUER_LENGTH || typeof subject !== 'string' || !subject.trim() || subject.length > MAX_SUBJECT_LENGTH) return null;
  let issuer;
  try {
    const url = new URL(issuerValue);
    if (!secureAbsoluteUrl(issuerValue, production) || url.search || url.hash) return null;
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

async function readFormBody(request) {
  const contentType = request.headers.get('content-type');
  if (!contentType || !FORM_URLENCODED.test(contentType)) return { error: { status: 400, code: 'invalid_callback_state' } };

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return { error: { status: 400, code: 'invalid_callback_state' } };
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > MAX_CALLBACK_BODY_BYTES) return { error: { status: 413, code: 'callback_body_too_large' } };
  }

  if (!request.body?.getReader) return { error: { status: 400, code: 'invalid_callback_state' } };
  let size = 0;
  let body = '';
  const reader = request.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!(chunk.value instanceof Uint8Array)) { await reader.cancel(); return { error: { status: 400, code: 'invalid_callback_state' } }; }
    size += chunk.value.byteLength;
    if (size > MAX_CALLBACK_BODY_BYTES) { await reader.cancel(); return { error: { status: 413, code: 'callback_body_too_large' } }; }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  return { body };
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

  function readSessionRow(raw, now = clock()) {
    if (typeof raw !== 'string' || raw.length > MAX_COOKIE_VALUE_LENGTH || !TOKEN_PATTERN.test(raw)) return null;
    const row = database.query(`SELECT sessions.id session_id, sessions.expires_at, sessions.revoked_at, sessions.csrf_hash,
      users.id user_id, users.display_name, users.email, users.avatar_url FROM sessions
      JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`).get(keyedHash('session', raw));
    return !row || row.revoked_at !== null || row.expires_at <= now ? null : row;
  }

  function readSession(request) {
    const raw = readSecurityCookie(request, SESSION_COOKIE_NAME);
    const row = readSessionRow(raw);
    return !row ? null : { row, raw };
  }

  function readSessionCapture(request) {
    const raw = readSecurityCookie(request, SESSION_COOKIE_NAME);
    if (raw === undefined) return { hasCookie: false, raw: null, row: null };
    return { hasCookie: true, raw, row: readSessionRow(raw) };
  }

  function newSession(userId, now) {
    const raw = token(randomBytes, SESSION_TOKEN_BYTES);
    const csrf = keyedHash('csrf-token', raw);
    return { id: makeId(randomBytes), userId, raw, csrf, tokenHash: keyedHash('session', raw), csrfHash: keyedHash('csrf', csrf), expiresAt: now + SESSION_DURATION_MS, now };
  }

  function issueSession(userId) {
    const session = newSession(userId, clock());
    database.run('INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)', [session.id, userId, session.tokenHash, session.csrfHash, session.expiresAt, session.now]);
    return { raw: session.raw, csrf: session.csrf, expiresAt: session.expiresAt };
  }

  async function handleCallback(request, provider, providerId) {
    const url = new URL(request.url);
    let stateFromBody = null;
    if (request.method === 'POST') {
      const parsed = await readFormBody(request);
      if (parsed.error) return fail(parsed.error.status, parsed.error.code);
      const form = new URLSearchParams(parsed.body);
      stateFromBody = form.get('state') || null;
      request = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: parsed.body,
        redirect: request.redirect,
      });
    }

    const stateValue = request.method === 'POST' ? stateFromBody : url.searchParams.get('state');
    const state = typeof stateValue === 'string' ? stateValue : '';
    if (!TOKEN_PATTERN.test(state) || state.length > MAX_COOKIE_VALUE_LENGTH) return fail(400, 'invalid_callback_state');

    const cookieState = readSecurityCookie(request, LOGIN_STATE_COOKIE_NAME);
    if (typeof cookieState !== 'string' || !safelyEqual(state, cookieState)) return fail(400, 'invalid_callback_state');

    const stateHash = keyedHash('login-state', state);
    const pending = database.query('SELECT provider_id, return_path, adapter_context, expires_at, consumed_at FROM login_transactions WHERE state_hash = ?').get(stateHash);
    if (!pending || pending.provider_id !== providerId || pending.consumed_at !== null || pending.expires_at <= clock()) return fail(400, 'invalid_callback_state');

    const previous = readSessionCapture(request);
    if (previous.hasCookie && previous.row === null) return fail(400, 'invalid_callback_state');

    const claimedAt = clock();
    try {
      const claimed = database.transaction(() => database.run('UPDATE login_transactions SET consumed_at = ? WHERE state_hash = ? AND provider_id = ? AND consumed_at IS NULL AND expires_at > ?', [claimedAt, stateHash, providerId, claimedAt])).immediate();
      if (claimed.changes !== 1) return fail(400, 'invalid_callback_state');
    } catch { return fail(500, 'auth_internal_error'); }

    let context; try { context = pending.adapter_context === null ? null : parseAdapterContext(pending.adapter_context); } catch { return fail(400, 'invalid_callback_state'); }
    let result;
    try { result = await provider.exchangeCallback({ request, url, context }); } catch { return fail(400, 'provider_callback_failed'); }
    const normalized = normalizeProviderResult(result, config.production);
    if (!normalized) return fail(400, 'invalid_provider_response');

    const now = clock();
    const replacement = newSession(null, now);
    try {
      database.transaction(() => {
        let identity = database.query('SELECT user_id FROM external_identities WHERE issuer = ? AND subject = ?').get(normalized.issuer, normalized.subject);
        let userId = identity?.user_id;
        if (!userId) {
          userId = makeId(randomBytes);
          database.run('INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [userId, normalized.user.displayName, normalized.user.email, normalized.user.avatarUrl, now, now]);
          database.run('INSERT INTO external_identities (id, user_id, issuer, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [makeId(randomBytes), userId, normalized.issuer, normalized.subject, now, now]);
        } else {
          database.run('UPDATE users SET display_name = ?, email = ?, avatar_url = ?, updated_at = ? WHERE id = ?', [normalized.user.displayName, normalized.user.email, normalized.user.avatarUrl, now, userId]);
        }
        if (previous.row) {
          const revoked = database.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now, previous.row.session_id]);
          if (revoked.changes !== 1) throw new Error('SESSION_ROTATION_LOST');
        }

        replacement.userId = userId;
        database.run('INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)', [replacement.id, userId, replacement.tokenHash, replacement.csrfHash, replacement.expiresAt, now]);
        options.beforeCallbackCommit?.({ database, userId, replacement });
      }).immediate();
    } catch (error) {
      if (error?.message === 'SESSION_ROTATION_LOST') return fail(400, 'invalid_callback_state');
      return fail(500, 'auth_internal_error');
    }

    const headers = new Headers({ location: pending.return_path, 'cache-control': 'no-store' });
    headers.append('set-cookie', setCookie(SESSION_COOKIE_NAME, replacement.raw, SESSION_DURATION_MS / 1000));
    headers.append('set-cookie', setCookie(LOGIN_STATE_COOKIE_NAME, '', 0, 'None'));
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
        if (!isValidProviderId(providerId)) return fail(400, 'malformed_provider_id');
        const provider = registry.get(providerId);
        if (!provider) return fail(404, 'provider_not_found');
        const returnPath = validateReturnPath(url.searchParams.get('returnPath') || '/');
        if (!returnPath) return fail(400, 'invalid_return_path');
        const staleSession = (() => {
          const captured = readSessionCapture(request);
          return captured.hasCookie && captured.row === null;
        })();
        const now = clock();
        const state = token(randomBytes, SESSION_TOKEN_BYTES);
        let authorization;
        try {
          authorization = await provider.createAuthorizationUrl({ state, returnPath });
        } catch {
          return fail(502, 'provider_login_failed');
        }
        const location = typeof authorization === 'string' ? authorization : authorization?.location;
        if (!secureAbsoluteUrl(location, config.production)) return fail(502, 'provider_login_failed');
        let context = null;
        if (typeof authorization === 'object' && authorization?.context !== undefined) {
          try { context = serializeContext(authorization.context); } catch { return fail(502, 'provider_login_failed'); }
        }
        database.run('INSERT INTO login_transactions (id, state_hash, provider_id, return_path, adapter_context, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)', [makeId(randomBytes), keyedHash('login-state', state), providerId, returnPath, context, now, now + LOGIN_STATE_DURATION_MS]);
        const headers = new Headers({ location, 'cache-control': 'no-store' });
        if (staleSession) headers.append('set-cookie', setCookie(SESSION_COOKIE_NAME, '', 0));
        headers.append('set-cookie', setCookie(LOGIN_STATE_COOKIE_NAME, state, LOGIN_STATE_DURATION_MS / 1000, 'None'));
        return new Response(null, { status: 302, headers });
      }
      if (url.pathname.startsWith(AUTH_ROUTES.CALLBACK_PREFIX) && (request.method === 'GET' || request.method === 'POST')) {
        const providerId = decodeProviderId(url.pathname, AUTH_ROUTES.CALLBACK_PREFIX);
        if (providerId === undefined) return fail(400, 'malformed_provider_id');
        const provider = registry.get(providerId);
        return provider ? handleCallback(request, provider, providerId) : fail(404, 'provider_not_found');
      }
      if (url.pathname === AUTH_ROUTES.LOGOUT && request.method === 'POST') {
        const sessionCapture = readSessionCapture(request);
        if (!sessionCapture.row) {
          return json({ error: { code: 'invalid_session' } }, 401, { ...JSON_HEADERS, 'set-cookie': setCookie(SESSION_COOKIE_NAME, '', 0) });
        }
        const session = { row: sessionCapture.row, raw: sessionCapture.raw };
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
