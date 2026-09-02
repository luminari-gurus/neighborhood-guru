import { timingSafeEqual } from 'node:crypto';
import { OIDC_CLOCK_SKEW_SECONDS, OIDC_MAX_ID_TOKEN_LENGTH, OIDC_SUPPORTED_ALGS } from './constants.js';

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
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
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
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry)) return value;
  return null;
}

function numericClaim(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

export function selectJwk(jwks, header) {
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const alg = header?.alg;
  if (!OIDC_SUPPORTED_ALGS.includes(alg)) return { key: null, unknownKid: false };
  const matching = keys.filter((key) => {
    if (key?.use && key.use !== 'sig') return false;
    if (key?.alg && key.alg !== alg) return false;
    if (alg === 'RS256') return key.kty === 'RSA';
    if (alg === 'ES256') return key.kty === 'EC' && key.crv === 'P-256';
    return false;
  });
  if (typeof header.kid === 'string' && header.kid) {
    const key = matching.find((entry) => entry.kid === header.kid) || null;
    return { key, unknownKid: !key };
  }
  return { key: matching.length === 1 ? matching[0] : null, unknownKid: matching.length === 0 };
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

export function validateIdTokenClaims(payload, { issuer, audience, nonce, clock, skewSeconds = OIDC_CLOCK_SKEW_SECONDS }) {
  const now = Math.floor(clock() / 1000);
  if (typeof payload.iss !== 'string' || payload.iss !== issuer) return 'invalid_issuer';
  const aud = audiences(payload.aud);
  if (!aud || !aud.includes(audience)) return 'invalid_audience';
  if (aud.length > 1 && payload.azp !== audience) return 'invalid_audience';
  const exp = numericClaim(payload.exp);
  if (exp === null || exp <= now - skewSeconds) return 'expired';
  const nbf = payload.nbf === undefined ? null : numericClaim(payload.nbf);
  if (payload.nbf !== undefined && (nbf === null || nbf > now + skewSeconds)) return 'not_yet_valid';
  const iat = payload.iat === undefined ? null : numericClaim(payload.iat);
  if (payload.iat !== undefined && (iat === null || iat > now + skewSeconds)) return 'invalid_issued_at';
  if (typeof payload.sub !== 'string' || !payload.sub.trim()) return 'missing_subject';
  if (typeof payload.nonce !== 'string' || !equal(payload.nonce, nonce)) return 'nonce_mismatch';
  return null;
}

export async function verifyIdToken(token, { jwks, issuer, audience, nonce, clock }) {
  const parsed = parseJwt(token);
  if (!parsed) return { ok: false, reason: 'malformed_id_token' };
  if (parsed.header.typ && parsed.header.typ !== 'JWT') return { ok: false, reason: 'invalid_typ' };
  if (!OIDC_SUPPORTED_ALGS.includes(parsed.header.alg) || parsed.header.alg === 'none') {
    return { ok: false, reason: 'unsupported_algorithm' };
  }
  const selected = selectJwk(jwks, parsed.header);
  if (!selected.key) return { ok: false, reason: selected.unknownKid ? 'unknown_kid' : 'invalid_signature' };
  const valid = await verifyJwtSignature(parsed, selected.key);
  if (!valid) return { ok: false, reason: 'invalid_signature' };
  const claimError = validateIdTokenClaims(parsed.payload, { issuer, audience, nonce, clock });
  if (claimError) return { ok: false, reason: claimError, payload: parsed.payload };
  return { ok: true, payload: parsed.payload };
}
