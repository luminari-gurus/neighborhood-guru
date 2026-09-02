import {
  OIDC_CACHE_MAX_ENTRIES,
  OIDC_DISCOVERY_TTL_MS,
  OIDC_FETCH_TIMEOUT_MS,
  OIDC_JWKS_TTL_MS,
  OIDC_MAX_AUTHORIZATION_CODE_LENGTH,
  OIDC_MAX_KEYS,
  OIDC_MAX_RESPONSE_BYTES,
} from './constants.js';
import { verifyIdToken } from './jwt.js';
import { discoveryUrlFor, logOidc, secureAbsoluteUrl } from './urls.js';

function createBoundedCache({ clock, maxEntries = OIDC_CACHE_MAX_ENTRIES }) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= clock()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      if (entries.size >= maxEntries && !entries.has(key)) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(key, { value, expiresAt: clock() + ttlMs });
    },
    invalidate(key) {
      entries.delete(key);
    },
  };
}

async function readBoundedJson(response, maxBytes) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw Object.assign(new Error('invalid_json'), { reason: 'invalid_content_length' });
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > maxBytes) throw Object.assign(new Error('response_too_large'), { reason: 'response_too_large' });
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw Object.assign(new Error('response_too_large'), { reason: 'response_too_large' });
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { reason: 'invalid_json' });
  }
}

function fail(reason, extra) {
  const error = new Error(reason);
  error.reason = reason;
  Object.assign(error, extra);
  return error;
}

export function createOidcClient(options) {
  const {
    issuer,
    clientId,
    clientSecret = null,
    production,
    fetch: fetchImpl = globalThis.fetch,
    clock = () => Date.now(),
    logger = console,
    timeoutMs = OIDC_FETCH_TIMEOUT_MS,
  } = options;
  const cache = createBoundedCache({ clock });

  async function requestJson(url, init = {}) {
    const target = secureAbsoluteUrl(url, production);
    if (!target || target.search || target.hash) throw fail('insecure_endpoint', { urlType: init.urlType });
    let response;
    try {
      response = await fetchImpl(target.href, {
        method: init.method || 'GET',
        body: init.body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', ...(init.headers || {}) },
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network_error';
      throw fail(reason, { urlType: init.urlType });
    }
    if (!response.ok) throw fail('http_error', { urlType: init.urlType, status: response.status });
    return readBoundedJson(response, OIDC_MAX_RESPONSE_BYTES);
  }

  function validateMetadata(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw fail('invalid_metadata', { detail: 'document' });
    if (document.issuer !== issuer) throw fail('issuer_mismatch', { detail: 'metadata_issuer' });
    const authorization = secureAbsoluteUrl(document.authorization_endpoint, production);
    const token = secureAbsoluteUrl(document.token_endpoint, production);
    const jwks = secureAbsoluteUrl(document.jwks_uri, production);
    if (!authorization || !token || !jwks) throw fail('insecure_endpoint', { detail: 'metadata_endpoints' });
    if (authorization.search || token.search || jwks.search || authorization.hash || token.hash || jwks.hash) {
      throw fail('invalid_metadata', { detail: 'endpoint_query' });
    }
    const methods = document.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes('S256')) throw fail('missing_s256');
    const algs = document.id_token_signing_alg_values_supported;
    if (Array.isArray(algs) && !algs.includes('RS256') && !algs.includes('ES256')) throw fail('unsupported_algorithm');
    return Object.freeze({
      issuer,
      authorization_endpoint: authorization.href,
      token_endpoint: token.href,
      jwks_uri: jwks.href,
    });
  }

  function validateJwks(document) {
    if (!document || typeof document !== 'object' || !Array.isArray(document.keys) || document.keys.length === 0 || document.keys.length > OIDC_MAX_KEYS) {
      throw fail('invalid_metadata', { detail: 'jwks' });
    }
    return Object.freeze({ keys: Object.freeze(document.keys.map((key) => (key && typeof key === 'object' ? { ...key } : {}))) });
  }

  async function discover({ force = false } = {}) {
    if (!force) {
      const cached = cache.get('discovery');
      if (cached) return cached;
    }
    try {
      const document = await requestJson(discoveryUrlFor(issuer), { method: 'GET', urlType: 'discovery' });
      const metadata = validateMetadata(document);
      cache.set('discovery', metadata, OIDC_DISCOVERY_TTL_MS);
      return metadata;
    } catch (error) {
      cache.invalidate('discovery');
      logOidc(logger, 'error', 'discovery_failed', {
        issuer,
        reason: error.reason || 'network_error',
        status: error.status,
        detail: error.detail,
      });
      throw error;
    }
  }

  async function getJwks({ force = false } = {}) {
    if (!force) {
      const cached = cache.get('jwks');
      if (cached) return cached;
    }
    try {
      const metadata = await discover();
      const document = await requestJson(metadata.jwks_uri, { method: 'GET', urlType: 'jwks' });
      const jwks = validateJwks(document);
      cache.set('jwks', jwks, OIDC_JWKS_TTL_MS);
      return jwks;
    } catch (error) {
      cache.invalidate('jwks');
      logOidc(logger, 'error', 'jwks_failed', {
        issuer,
        reason: error.reason || 'network_error',
        status: error.status,
        detail: error.detail,
      });
      throw error;
    }
  }

  async function exchangeAuthorizationCode({ code, redirectUri, codeVerifier }) {
    if (typeof code !== 'string' || !code || code.length > OIDC_MAX_AUTHORIZATION_CODE_LENGTH) {
      throw fail('missing_code');
    }
    const metadata = await discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    if (clientSecret) body.set('client_secret', clientSecret);
    let document;
    try {
      document = await requestJson(metadata.token_endpoint, {
        method: 'POST',
        urlType: 'token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (error) {
      logOidc(logger, 'error', 'token_exchange_failed', { issuer, reason: error.reason || 'network_error', status: error.status });
      throw error;
    }
    if (!document || typeof document.id_token !== 'string') {
      logOidc(logger, 'error', 'token_exchange_failed', { issuer, reason: 'missing_id_token' });
      throw fail('missing_id_token');
    }
    return document.id_token;
  }

  async function verify(idToken, { nonce }) {
    let jwks = await getJwks();
    let result = await verifyIdToken(idToken, { jwks, issuer, audience: clientId, nonce, clock });
    if (result.reason === 'unknown_kid') {
      logOidc(logger, 'warn', 'jwks_key_rotation', { issuer, reason: 'unknown_kid', action: 'refresh' });
      cache.invalidate('jwks');
      try {
        jwks = await getJwks({ force: true });
      } catch (error) {
        logOidc(logger, 'error', 'jwks_key_rotation_failed', { issuer, reason: error.reason || 'network_error' });
        throw error;
      }
      result = await verifyIdToken(idToken, { jwks, issuer, audience: clientId, nonce, clock });
      if (result.reason === 'unknown_kid') {
        logOidc(logger, 'error', 'jwks_key_rotation_failed', { issuer, reason: 'unknown_kid' });
        throw fail('unknown_kid');
      }
      if (result.ok) logOidc(logger, 'info', 'jwks_key_rotation', { issuer, reason: 'refreshed' });
    }
    if (!result.ok) {
      logOidc(logger, 'error', 'id_token_invalid', { issuer, reason: result.reason });
      throw fail(result.reason);
    }
    return result.payload;
  }

  return { discover, getJwks, exchangeAuthorizationCode, verify };
}
