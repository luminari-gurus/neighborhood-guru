function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function secureAbsoluteUrl(value, production) {
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && !production && isLoopback(url.hostname)) return url;
    return null;
  } catch {
    return null;
  }
}

export function canonicalizeIssuer(value, production) {
  const url = secureAbsoluteUrl(value, production);
  if (!url || url.search || url.hash) return null;
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  return pathname === '/' ? url.origin : `${url.origin}${pathname}`;
}

export function discoveryUrlFor(issuer) {
  return `${issuer}/.well-known/openid-configuration`;
}

export function validateAppPath(value) {
  return typeof value === 'string'
    && value.length <= 2048
    && value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('\\')
    && !/[\r\n]/.test(value)
    ? value
    : null;
}

export function resolveRedirectUri(redirectPath, redirectOrigin, requestUrl, production) {
  const path = validateAppPath(redirectPath);
  if (!path) return null;
  const base = redirectOrigin
    ? secureAbsoluteUrl(redirectOrigin, production)
    : requestUrl instanceof URL
      ? secureAbsoluteUrl(requestUrl.origin, production)
      : null;
  if (!base || base.search || base.hash) return null;
  const redirect = new URL(path, base);
  return secureAbsoluteUrl(redirect.href, production) ? redirect.href : null;
}

export function logOidc(logger, level, event, details = {}) {
  const write = logger?.[level];
  if (typeof write !== 'function') return;
  write.call(logger, `[auth:oidc] ${event}`, details);
}
