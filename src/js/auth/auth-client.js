export const AUTH_STATUS = Object.freeze({
  ANONYMOUS: 'anonymous',
  AUTHENTICATING: 'authenticating',
  AUTHENTICATED: 'authenticated',
  ERROR: 'error',
});

export const ANONYMOUS_AUTH_STATE = Object.freeze({
  status: AUTH_STATUS.ANONYMOUS,
  user: null,
  session: null,
  error: null,
});

/**
 * Provider-neutral AuthClient contract.
 *
 * Implementations expose these methods:
 * discoverProviders(), loadSession(), refreshSession(), signIn(options),
 * signOut(), and subscribe(listener). subscribe returns an unsubscribe function.
 * Provider results are frozen arrays of provider-neutral { id, displayName } records.
 * Session results are either null or normalized as { user, expiresAt } where
 * user is { id, displayName, email, avatarUrl } with no provider claims.
 * Required IDs are non-empty strings. Optional fields are strings or null;
 * empty optional strings are preserved.
 */
export function assertAuthClient(client) {
  const methods = [
    'discoverProviders',
    'loadSession',
    'refreshSession',
    'signIn',
    'signOut',
    'subscribe',
  ];

  if (!client || methods.some((method) => typeof client[method] !== 'function')) {
    throw new TypeError(`AuthClient must implement: ${methods.join(', ')}`);
  }

  return client;
}

function requireRecord(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(message);
  }
  return value;
}

function requireId(value, message) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(message);
  }
  return value;
}

function optionalString(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string or null`);
  }
  return value;
}

export function normalizeProviders(providers) {
  if (!Array.isArray(providers)) {
    throw new TypeError('Auth providers must be an array');
  }

  return Object.freeze(providers.map((value) => {
    const provider = requireRecord(value, 'Auth providers must contain records');
    return Object.freeze({
      id: requireId(provider.id, 'Auth providers require a non-empty string id'),
      displayName: optionalString(provider.displayName, 'Auth provider displayName'),
    });
  }));
}

export function normalizeSession(value) {
  if (value == null) return null;
  const session = requireRecord(value, 'Auth sessions must be records or null');
  const user = requireRecord(session.user, 'Auth sessions require a user record');

  return Object.freeze({
    user: Object.freeze({
      id: requireId(user.id, 'Auth sessions require a user with a non-empty string id'),
      displayName: optionalString(user.displayName, 'Auth user displayName'),
      email: optionalString(user.email, 'Auth user email'),
      avatarUrl: optionalString(user.avatarUrl, 'Auth user avatarUrl'),
    }),
    expiresAt: optionalString(session.expiresAt, 'Auth session expiresAt'),
  });
}
