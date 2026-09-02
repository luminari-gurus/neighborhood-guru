import { AUTH_ROUTES } from '../constants.js';
import {
  OIDC_DEFAULT_DISPLAY_NAME,
  OIDC_DEFAULT_PROVIDER_ID,
  OIDC_DEFAULT_SCOPES,
} from './constants.js';
import { canonicalizeIssuer, secureAbsoluteUrl, validateAppPath } from './urls.js';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function readString(environment, name) {
  const value = environment[name];
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeScopes(value) {
  const parts = (value || OIDC_DEFAULT_SCOPES).split(/\s+/).filter(Boolean);
  if (!parts.includes('openid')) parts.unshift('openid');
  const unique = [...new Set(parts)];
  if (unique.length === 0 || unique.some((scope) => scope.length > 128 || !/^[\w.:/-]+$/.test(scope))) {
    throw new Error('OIDC_SCOPES must be a space-separated list of OpenID Connect scopes');
  }
  return unique.join(' ');
}

export function loadOidcConfig(environment = process.env, { production = false } = {}) {
  const issuerValue = readString(environment, 'OIDC_ISSUER');
  if (!issuerValue) return null;

  const issuer = canonicalizeIssuer(issuerValue, production);
  if (!issuer) throw new Error('OIDC_ISSUER must be an https URL without query, hash, or credentials');

  const clientId = readString(environment, 'OIDC_CLIENT_ID');
  if (!clientId || clientId.length > 256) throw new Error('OIDC_CLIENT_ID is required when OIDC_ISSUER is set');

  const clientSecret = readString(environment, 'OIDC_CLIENT_SECRET');
  if (clientSecret.length > 4096) throw new Error('OIDC_CLIENT_SECRET is too long');

  const providerId = readString(environment, 'OIDC_PROVIDER_ID') || OIDC_DEFAULT_PROVIDER_ID;
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new Error('OIDC_PROVIDER_ID is invalid');

  const displayName = readString(environment, 'OIDC_DISPLAY_NAME') || OIDC_DEFAULT_DISPLAY_NAME;
  if (displayName.length > 128) throw new Error('OIDC_DISPLAY_NAME is too long');

  const redirectPath = readString(environment, 'OIDC_REDIRECT_PATH') || `/api/auth/callback/${providerId}`;
  if (!validateAppPath(redirectPath) || redirectPath !== `${AUTH_ROUTES.CALLBACK_PREFIX}${providerId}`) {
    throw new Error('OIDC_REDIRECT_PATH must match /api/auth/callback/<provider id>');
  }

  const redirectOriginValue = readString(environment, 'OIDC_REDIRECT_ORIGIN');
  let redirectOrigin = null;
  if (redirectOriginValue) {
    const origin = secureAbsoluteUrl(redirectOriginValue, production);
    if (!origin || origin.search || origin.hash || origin.pathname !== '/') {
      throw new Error('OIDC_REDIRECT_ORIGIN must be an origin URL such as https://app.example');
    }
    redirectOrigin = origin.origin;
  }

  return Object.freeze({
    issuer,
    clientId,
    clientSecret: clientSecret || null,
    scopes: normalizeScopes(readString(environment, 'OIDC_SCOPES')),
    redirectPath,
    redirectOrigin,
    providerId,
    displayName,
    production,
  });
}
