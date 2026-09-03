import { timingSafeEqual } from 'node:crypto';
import { OIDC_CLOCK_SKEW_SECONDS, OIDC_ID_TOKEN_TTL_SECONDS, OIDC_MAX_ID_TOKEN_LENGTH, OIDC_SUPPORTED_ALGS } from './constants.js';

const encoder = new TextEncoder();

function decodeBase64Url(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
}

function decodeJsonPart(part) {
  const bytes = decodeBase64Url(part);
  if (!bytes) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function equal(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function audiences(value) {
  if (typeof value === 'string' && value) return [value];
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' && value[0]) return value;
  return null;
}

function numericClaim(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const SIG_KEY_OPS = new Set(['sign', 'verify']);
const ENC_KEY_OPS = new Set(['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

function jwkAllowsVerify(jwk, alg) {
  if (!jwk || typeof jwk !== 'object') return false;
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  const hasUse = jwk.use !== undefined;
  const hasOps = jwk.key_ops !== undefined;
  if (hasUse && jwk.use !== 'sig' && jwk.use !== 'enc') return false;
  if (hasOps && (!isNonEmptyStringArray(jwk.key_ops) || new Set(jwk.key_ops).size !== jwk.key_ops.length)) return false;
  if (hasUse && hasOps) {
    const allowed = jwk.use === 'sig' ? SIG_KEY_OPS : jwk.use === 'enc' ? ENC_KEY_OPS : null;
    if (!allowed || jwk.key_ops.some((op) => !allowed.has(op))) return false;
  }
  if (hasUse && jwk.use !== 'sig') return false;
  if (hasOps && !jwk.key_ops.includes('verify')) return false;
  return true;
}

function publicJwk(jwk, alg) {
  if (!jwk || typeof jwk !== 'object') return null;
  if (alg === 'RS256') {
    if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return null;
    return { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true };
  }
  if (alg === 'ES256') {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
    return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, alg: 'ES256', ext: true };
  }
  return null;
}

function importAlgorithm(alg) {
  if (alg === 'RS256') return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  if (alg === 'ES256') return { name: 'ECDSA', namedCurve: 'P-256' };
  return null;
}

function verifyAlgorithm(alg) {
  if (alg === 'RS256') return { name: 'RSASSA-PKCS1-v1_5' };
  if (alg === 'ES256') return { name: 'ECDSA', hash: 'SHA-256' };
  return null;
}

export function parseJwt(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > OIDC_MAX_ID_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = decodeJsonPart(parts[0]);
  const payload = decodeJsonPart(parts[1]);
  const signature = decodeBase64Url(parts[2]);
  if (!header || !payload || !signature) return null;
  return { header, payload, signature, signingInput: encoder.encode(`${parts[0]}.${parts[1]}`) };
}

export function selectJwk(jwks, header, allowedAlgs = OIDC_SUPPORTED_ALGS) {
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const alg = header?.alg;
  if (!allowedAlgs.includes(alg)) return { key: null, unknownKid: false };
  const matching = keys.filter((key) => {
    if (alg === 'RS256') return key.kty === 'RSA';
    if (alg === 'ES256') return key.kty === 'EC' && key.crv === 'P-256';
    return false;
  });
  let selected = null;
  if (header.kid !== undefined) {
    if (typeof header.kid !== 'string' || header.kid.length === 0) {
      return { key: null, unknownKid: false, reason: 'malformed_kid' };
    }
    selected = matching.find((entry) => entry.kid === header.kid) || null;
    if (!selected) return { key: null, unknownKid: true };
  } else if (matching.length === 1) {
    selected = matching[0];
  } else {
    return { key: null, unknownKid: matching.length === 0 };
  }
  if (!jwkAllowsVerify(selected, alg)) return { key: null, unknownKid: false };
  return { key: selected, unknownKid: false };
}

export async function verifyJwtSignature(parsed, jwk) {
  const alg = parsed.header.alg;
  const keyData = publicJwk(jwk, alg);
  const algorithm = importAlgorithm(alg);
  const verify = verifyAlgorithm(alg);
  if (!keyData || !algorithm || !verify) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', keyData, algorithm, false, ['verify']);
    return await crypto.subtle.verify(verify, key, parsed.signature, parsed.signingInput);
  } catch {
    return false;
  }
}

export function validateIdTokenClaims(payload, { issuer, audience, nonce, clock, skewSeconds = OIDC_CLOCK_SKEW_SECONDS, maxAgeSeconds = OIDC_ID_TOKEN_TTL_SECONDS }) {
  const now = Math.floor(clock() / 1000);
  if (typeof payload.iss !== 'string' || payload.iss !== issuer) return 'invalid_issuer';
  const aud = audiences(payload.aud);
  if (!aud || !equal(aud[0], audience)) return 'invalid_audience';
  if (payload.azp !== undefined && (typeof payload.azp !== 'string' || !payload.azp || !equal(payload.azp, audience))) {
    return 'invalid_audience';
  }
  const exp = numericClaim(payload.exp);
  if (exp === null || exp <= now - skewSeconds) return 'expired';
  const nbf = payload.nbf === undefined ? null : numericClaim(payload.nbf);
  if (payload.nbf !== undefined && (nbf === null || nbf > now + skewSeconds)) return 'not_yet_valid';
  const iat = numericClaim(payload.iat);
  if (iat === null) return 'missing_issued_at';
  if (iat > now + skewSeconds) return 'invalid_issued_at';
  if (iat < now - maxAgeSeconds - skewSeconds) return 'stale_issued_at';
  if (typeof payload.sub !== 'string' || !payload.sub.trim()) return 'missing_subject';
  if (typeof payload.nonce !== 'string' || !equal(payload.nonce, nonce)) return 'nonce_mismatch';
  return null;
}

export async function verifyIdToken(token, { jwks, issuer, audience, nonce, clock, allowedAlgs = OIDC_SUPPORTED_ALGS }) {
  const parsed = parseJwt(token);
  if (!parsed) return { ok: false, reason: 'malformed_id_token' };
  if (parsed.header.typ && parsed.header.typ !== 'JWT') return { ok: false, reason: 'invalid_typ' };
  if (!allowedAlgs.includes(parsed.header.alg) || parsed.header.alg === 'none') {
    return { ok: false, reason: 'unsupported_algorithm' };
  }
  if (parsed.header.crit !== undefined) {
    if (!isNonEmptyStringArray(parsed.header.crit)) return { ok: false, reason: 'malformed_crit' };
    return { ok: false, reason: 'unsupported_crit' };
  }
  const selected = selectJwk(jwks, parsed.header, allowedAlgs);
  if (!selected.key) {
    if (selected.reason === 'malformed_kid') return { ok: false, reason: 'malformed_kid' };
    return { ok: false, reason: selected.unknownKid ? 'unknown_kid' : 'invalid_signature' };
  }
  const valid = await verifyJwtSignature(parsed, selected.key);
  if (!valid) return { ok: false, reason: 'invalid_signature' };
  const claimError = validateIdTokenClaims(parsed.payload, { issuer, audience, nonce, clock });
  if (claimError) return { ok: false, reason: claimError, payload: parsed.payload };
  return { ok: true, payload: parsed.payload };
}
