import {
  OIDC_CACHE_MAX_ENTRIES,
  OIDC_DISCOVERY_TTL_MS,
  OIDC_FETCH_TIMEOUT_MS,
  OIDC_JWKS_TTL_MS,
  OIDC_MAX_AUTHORIZATION_CODE_LENGTH,
  OIDC_MAX_KEYS,
  OIDC_MAX_RESPONSE_BYTES,
  OIDC_SUPPORTED_ALGS,
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

function fail(reason, extra) {
  const error = new Error(reason);
  error.reason = reason;
  Object.assign(error, extra);
  return error;
}

export function formEncode(value) {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function basicAuthorization(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`).toString('base64')}`;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

function requireStringArray(value, detail) {
  if (!isNonEmptyStringArray(value)) throw fail('invalid_metadata', { detail });
  return value;
}

function selectTokenAuthMethod(advertised, clientSecret) {
  let methods;
  if (advertised === undefined) {
    methods = ['client_secret_basic'];
  } else {
    methods = requireStringArray(advertised, 'token_endpoint_auth_methods_supported');
  }
  if (clientSecret) {
    if (methods.includes('client_secret_basic')) return 'client_secret_basic';
    if (methods.includes('client_secret_post')) return 'client_secret_post';
    throw fail('unsupported_token_auth', { detail: 'confidential' });
  }
  if (methods.includes('none')) return 'none';
  throw fail('unsupported_token_auth', { detail: 'public' });
}

async function cancelBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {}
}

function parseJsonBytes(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw fail('invalid_json');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw fail('invalid_json');
  }
}

async function readBoundedJson(response, maxBytes) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      await cancelBody(response);
      throw fail('invalid_content_length');
    }
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      await cancelBody(response);
      throw fail('response_too_large');
    }
  }
  if (!response.body?.getReader) {
    await cancelBody(response);
    throw fail('invalid_json');
  }
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!(chunk.value instanceof Uint8Array)) {
      await reader.cancel();
      throw fail('invalid_json');
    }
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw fail('response_too_large');
    }
    chunks.push(chunk.value);
  }
  return parseJsonBytes(Buffer.concat(chunks));
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
    if (!target || target.hash) throw fail('insecure_endpoint', { urlType: init.urlType });
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
    if (!response.ok) {
      await cancelBody(response);
      throw fail('http_error', { urlType: init.urlType, status: response.status });
    }
    return readBoundedJson(response, OIDC_MAX_RESPONSE_BYTES);
  }

  function validateMetadata(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw fail('invalid_metadata', { detail: 'document' });
    if (document.issuer !== issuer) throw fail('issuer_mismatch', { detail: 'metadata_issuer' });
    const authorization = secureAbsoluteUrl(document.authorization_endpoint, production);
    const token = secureAbsoluteUrl(document.token_endpoint, production);
    const jwks = secureAbsoluteUrl(document.jwks_uri, production);
    if (!authorization || !token || !jwks) throw fail('insecure_endpoint', { detail: 'metadata_endpoints' });
    if (authorization.hash || token.hash || jwks.hash) throw fail('invalid_metadata', { detail: 'endpoint_fragment' });
    const responseTypes = requireStringArray(document.response_types_supported, 'response_types_supported');
    if (!responseTypes.includes('code')) throw fail('invalid_metadata', { detail: 'response_types_supported' });
    requireStringArray(document.subject_types_supported, 'subject_types_supported');
    const algs = requireStringArray(document.id_token_signing_alg_values_supported, 'id_token_signing_alg_values_supported');
    const idTokenAlgs = Object.freeze(OIDC_SUPPORTED_ALGS.filter((alg) => algs.includes(alg)));
    if (idTokenAlgs.length === 0) throw fail('unsupported_algorithm');
    const methods = document.code_challenge_methods_supported;
    if (methods !== undefined && (!isNonEmptyStringArray(methods) || !methods.includes('S256'))) throw fail('missing_s256');
    const tokenAuthMethod = selectTokenAuthMethod(document.token_endpoint_auth_methods_supported, clientSecret);
    return Object.freeze({
      issuer,
      authorization_endpoint: authorization.href,
      token_endpoint: token.href,
      jwks_uri: jwks.href,
      tokenAuthMethod,
      idTokenAlgs,
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

  function jwksCacheKey(jwksUri) {
    return `jwks:${jwksUri}`;
  }

  async function getJwksForMetadata(metadata, { force = false } = {}) {
    const cacheKey = jwksCacheKey(metadata.jwks_uri);
    try {
      if (!force) {
        const cached = cache.get(cacheKey);
        if (cached) return cached;
      }
      const document = await requestJson(metadata.jwks_uri, { method: 'GET', urlType: 'jwks' });
      const jwks = validateJwks(document);
      cache.set(cacheKey, jwks, OIDC_JWKS_TTL_MS);
      return jwks;
    } catch (error) {
      cache.invalidate(cacheKey);
      logOidc(logger, 'error', 'jwks_failed', {
        issuer,
        reason: error.reason || 'network_error',
        status: error.status,
        detail: error.detail,
      });
      throw error;
    }
  }

  async function getJwks({ force = false } = {}) {
    const metadata = await discover();
    return getJwksForMetadata(metadata, { force });
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
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (metadata.tokenAuthMethod === 'client_secret_basic') {
      headers.authorization = basicAuthorization(clientId, clientSecret);
    } else if (metadata.tokenAuthMethod === 'client_secret_post') {
      body.set('client_secret', clientSecret);
    }
    let document;
    try {
      document = await requestJson(metadata.token_endpoint, {
        method: 'POST',
        urlType: 'token',
        headers,
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
    let metadata = await discover();
    let jwks = await getJwksForMetadata(metadata);
    let verifyOptions = { jwks, issuer, audience: clientId, nonce, clock, allowedAlgs: metadata.idTokenAlgs };
    let result = await verifyIdToken(idToken, verifyOptions);
    if (result.reason === 'unknown_kid') {
      logOidc(logger, 'warn', 'jwks_key_rotation', { issuer, reason: 'unknown_kid', action: 'refresh' });
      metadata = await discover();
      cache.invalidate(jwksCacheKey(metadata.jwks_uri));
      try {
        jwks = await getJwksForMetadata(metadata, { force: true });
      } catch (error) {
        logOidc(logger, 'error', 'jwks_key_rotation_failed', { issuer, reason: error.reason || 'network_error' });
        throw error;
      }
      verifyOptions = { ...verifyOptions, jwks, allowedAlgs: metadata.idTokenAlgs };
      result = await verifyIdToken(idToken, verifyOptions);
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
