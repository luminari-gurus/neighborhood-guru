import {
  ANONYMOUS_AUTH_STATE,
  AUTH_STATUS,
  assertAuthClient,
  normalizeSession,
} from './auth-client.js';

export function createAuthState(authClient) {
  const client = assertAuthClient(authClient);
  const listeners = new Set();
  let state = ANONYMOUS_AUTH_STATE;
  let unsubscribeClient = null;

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

  const runSessionOperation = async (operation) => {
    publish({ status: AUTH_STATUS.AUTHENTICATING, user: null, session: null, error: null });
    try {
      return applySession(await operation());
    } catch (error) {
      return fail(error);
    }
  };

  return Object.freeze({
    getState() {
      return state;
    },
    async initialize() {
      if (!unsubscribeClient) {
        unsubscribeClient = client.subscribe((session) => {
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
      try {
        await client.signOut();
        return applySession(null);
      } catch (error) {
        return fail(error);
      }
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Auth state listener must be a function');
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (unsubscribeClient) unsubscribeClient();
      unsubscribeClient = null;
      listeners.clear();
    },
  });
}
