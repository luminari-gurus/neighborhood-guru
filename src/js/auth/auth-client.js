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

export function normalizeProviders(providers) {
  if (!Array.isArray(providers)) {
    throw new TypeError('Auth providers must be an array');
  }

  return Object.freeze(providers.map((provider) => {
    if (!provider || typeof provider.id !== 'string' || provider.id.trim().length === 0) {
      throw new TypeError('Auth providers require a non-empty id');
    }

    return Object.freeze({
      id: provider.id,
      displayName: provider.displayName ?? null,
    });
  }));
}

export function normalizeSession(session) {
  if (session == null) return null;
  if (!session.user || typeof session.user.id !== 'string' || session.user.id.length === 0) {
    throw new TypeError('Auth sessions require a normalized user with a non-empty id');
  }

  return Object.freeze({
    user: Object.freeze({
      id: session.user.id,
      displayName: session.user.displayName ?? null,
      email: session.user.email ?? null,
      avatarUrl: session.user.avatarUrl ?? null,
    }),
    expiresAt: session.expiresAt ?? null,
  });
}
