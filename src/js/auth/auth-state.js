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
  let activeOperation = null;
  let operationQueue = Promise.resolve();

  // State publication is reliable and listener delivery is best-effort. A broken
  // consumer must never block other consumers or poison an auth operation.
  const notify = (listener) => {
    try {
      listener(state);
    } catch {
      // Listener failures belong to the consumer and are intentionally isolated.
    }
  };

  const publish = (nextState) => {
    state = Object.freeze(nextState);
    listeners.forEach(notify);
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

  // Session-changing facade calls execute in invocation order. A subscription
  // event invalidates only the operation executing at that moment; it cannot
  // invalidate a later queued intent. This makes a later sign-out deterministic
  // even when an earlier sign-in emits a delayed provider event.
  const enqueueSessionOperation = async (operation, { authenticating = true, signedOut = false } = {}) => {
    assertActive();

    const execute = async () => {
      if (!active) return state;
      const operationContext = { invalidated: false };
      activeOperation = operationContext;
      if (authenticating) {
        publish({ status: AUTH_STATUS.AUTHENTICATING, user: null, session: null, error: null });
      }

      try {
        const session = await operation();
        if (!active || operationContext.invalidated) return state;
        return applySession(signedOut ? null : session);
      } catch (error) {
        if (!active || operationContext.invalidated) return state;
        return fail(error);
      } finally {
        if (activeOperation === operationContext) activeOperation = null;
      }
    };

    const result = operationQueue.then(execute, execute);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
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
          if (activeOperation) activeOperation.invalidated = true;
          try {
            applySession(session);
          } catch (error) {
            fail(error);
          }
        });
      }
      return enqueueSessionOperation(() => client.loadSession());
    },
    refreshSession() {
      return enqueueSessionOperation(() => client.refreshSession());
    },
    signIn(options) {
      return enqueueSessionOperation(() => client.signIn(options));
    },
    signOut() {
      return enqueueSessionOperation(() => client.signOut(), {
        authenticating: false,
        signedOut: true,
      });
    },
    subscribe(listener) {
      assertActive();
      if (typeof listener !== 'function') throw new TypeError('Auth state listener must be a function');
      listeners.add(listener);
      notify(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (!active) return;
      active = false;
      if (activeOperation) activeOperation.invalidated = true;
      if (unsubscribeClient) unsubscribeClient();
      unsubscribeClient = null;
      listeners.clear();
    },
  });
}
