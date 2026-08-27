import {
  ANONYMOUS_AUTH_STATE,
  AUTH_STATUS,
  assertAuthClient,
  normalizeProviders,
  normalizeSession,
} from './auth-client.js';

export function createAuthState(authClient) {
  const client = assertAuthClient(authClient);
  const listeners = new Set();
  let state = ANONYMOUS_AUTH_STATE;
  let unsubscribeClient = null;
  let active = true;
  let version = 0;

  const publish = (nextState) => {
    state = Object.freeze(nextState);
    listeners.forEach((listener) => listener(state));
    return state;
  };

  const applySession = (session) => {
    const normalized = normalizeSession(session);
    return publish(normalized ? {
      status: AUTH_STATUS.AUTHENTICATED,
      user: normalized.user,
      session: normalized,
      error: null,
    } : ANONYMOUS_AUTH_STATE);
  };

  const fail = (error) => publish({
    status: AUTH_STATUS.ERROR,
    user: null,
    session: null,
    error: error instanceof Error ? error : new Error(String(error)),
  });

  const assertActive = () => {
    if (!active) throw new Error('Auth state has been disposed');
  };

  const runSessionOperation = async (operation) => {
    assertActive();
    const operationVersion = ++version;
    publish({ status: AUTH_STATUS.AUTHENTICATING, user: null, session: null, error: null });
    try {
      const session = await operation();
      if (!active || operationVersion !== version) return state;
      return applySession(session);
    } catch (error) {
      if (!active || operationVersion !== version) return state;
      return fail(error);
    }
  };

  return Object.freeze({
    getState() {
      return state;
    },
    async discoverProviders() {
      assertActive();
      return normalizeProviders(await client.discoverProviders());
    },
    async initialize() {
      assertActive();
      if (!unsubscribeClient) {
        unsubscribeClient = client.subscribe((session) => {
          if (!active) return;
          version += 1;
          try {
            applySession(session);
          } catch (error) {
            fail(error);
          }
        });
      }
      return runSessionOperation(() => client.loadSession());
    },
    refreshSession() {
      return runSessionOperation(() => client.refreshSession());
    },
    signIn(options) {
      return runSessionOperation(() => client.signIn(options));
    },
    async signOut() {
      assertActive();
      const operationVersion = ++version;
      try {
        await client.signOut();
        if (!active || operationVersion !== version) return state;
        return applySession(null);
      } catch (error) {
        if (!active || operationVersion !== version) return state;
        return fail(error);
      }
    },
    subscribe(listener) {
      assertActive();
      if (typeof listener !== 'function') throw new TypeError('Auth state listener must be a function');
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (!active) return;
      active = false;
      version += 1;
      if (unsubscribeClient) unsubscribeClient();
      unsubscribeClient = null;
      listeners.clear();
    },
  });
}
