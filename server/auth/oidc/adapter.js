import { createOidcClient } from './client.js';
import {
  OIDC_DEFAULT_DISPLAY_NAME,
  OIDC_DEFAULT_PROVIDER_ID,
  OIDC_NONCE_BYTES,
  OIDC_PKCE_BYTES,
} from './constants.js';
import { logOidc, resolveRedirectUri, validateAppPath } from './urls.js';

const encoder = new TextEncoder();

function secureRandom(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function token(randomBytes, length) {
  return Buffer.from(randomBytes(length)).toString('base64url');
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Buffer.from(digest).toString('base64url');
}

function profileString(value) {
  return typeof value === 'string' && value ? value : null;
}

async function callbackParams(request, url) {
  const params = new URLSearchParams(url.search);
  if (request.method === 'POST') {
    const body = await request.text();
    const form = new URLSearchParams(body);
    for (const [key, value] of form) params.set(key, value);
  }
  return params;
}

export function createOidcProvider(options = {}) {
  const {
    issuer,
    clientId,
    clientSecret = null,
    scopes = 'openid profile email',
    redirectPath,
    redirectOrigin = null,
    id = options.id || options.providerId || OIDC_DEFAULT_PROVIDER_ID,
    displayName = OIDC_DEFAULT_DISPLAY_NAME,
    production = false,
    fetch: fetchImpl,
    clock = () => Date.now(),
    randomBytes = secureRandom,
    logger = console,
    client = null,
  } = options;

  if (typeof issuer !== 'string' || !issuer) throw new TypeError('OIDC provider requires issuer');
  if (typeof clientId !== 'string' || !clientId) throw new TypeError('OIDC provider requires clientId');
  const callbackPath = validateAppPath(redirectPath) || `/api/auth/callback/${id}`;
  const oidc = client || createOidcClient({
    issuer,
    clientId,
    clientSecret,
    production,
    fetch: fetchImpl,
    clock,
    logger,
  });

  return Object.freeze({
    id,
    displayName,
    async createAuthorizationUrl({ state, url }) {
      const redirectUri = resolveRedirectUri(callbackPath, redirectOrigin, url, production);
      if (!redirectUri) throw new Error('OIDC redirect URI is invalid');
      const metadata = await oidc.discover();
      const nonce = token(randomBytes, OIDC_NONCE_BYTES);
      const codeVerifier = token(randomBytes, OIDC_PKCE_BYTES);
      const codeChallenge = await sha256Base64Url(codeVerifier);
      const location = new URL(metadata.authorization_endpoint);
      location.searchParams.set('client_id', clientId);
      location.searchParams.set('response_type', 'code');
      location.searchParams.set('redirect_uri', redirectUri);
      location.searchParams.set('scope', scopes);
      location.searchParams.set('state', state);
      location.searchParams.set('nonce', nonce);
      location.searchParams.set('code_challenge', codeChallenge);
      location.searchParams.set('code_challenge_method', 'S256');
      return {
        location: location.href,
        context: { nonce, codeVerifier, redirectUri },
      };
    },
    async exchangeCallback({ request, url, context }) {
      if (!context || typeof context !== 'object') throw new Error('OIDC login context is missing');
      const { nonce, codeVerifier, redirectUri } = context;
      if (typeof nonce !== 'string' || typeof codeVerifier !== 'string' || typeof redirectUri !== 'string') {
        throw new Error('OIDC login context is invalid');
      }
      const params = await callbackParams(request, url);
      const oauthError = params.get('error');
      if (oauthError) {
        const reason = oauthError === 'access_denied' ? 'cancelled' : 'provider_error';
        logOidc(logger, 'error', 'callback_rejected', { issuer, reason, error: oauthError });
        throw new Error(reason);
      }
      const idToken = await oidc.exchangeAuthorizationCode({
        code: params.get('code'),
        redirectUri,
        codeVerifier,
      });
      const claims = await oidc.verify(idToken, { nonce });
      return {
        identity: { issuer: claims.iss, subject: claims.sub },
        user: {
          displayName: profileString(claims.name) || profileString(claims.preferred_username),
          email: profileString(claims.email),
          avatarUrl: profileString(claims.picture),
        },
      };
    },
  });
}
