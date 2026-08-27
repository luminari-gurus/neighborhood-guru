import {
  ANONYMOUS_AUTH_STATE,
  AUTH_STATUS,
  assertAuthClient,
  normalizeProviders,
  normalizeSession,
} from './auth-client.js';

const SUBSCRIPTION_SUPERSESSION = Object.freeze({
  ALLOW: 'allow',
  BLOCK: 'block',
});

const PASSIVE_SESSION_OPERATION = Object.freeze({
  subscriptionSupersession: SUBSCRIPTION_SUPERSESSION.ALLOW,
});

const SIGN_IN_OPERATION = Object.freeze({
  subscriptionSupersession: SUBSCRIPTION_SUPERSESSION.BLOCK,
});

const SIGN_OUT_OPERATION = Object.freeze({
  subscriptionSupersession: SUBSCRIPTION_SUPERSESSION.BLOCK,
  publishAuthenticating: false,
  applySignedOut: true,
});

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

  // Facade calls execute in invocation order. Passive operations yield to newer
  // subscription state, while explicit user intents remain authoritative until
  // their provider call settles.
  const enqueueSessionOperation = async (
    operation,
    {
      subscriptionSupersession,
      publishAuthenticating = true,
      applySignedOut = false,
    },
  ) => {
    assertActive();

    const execute = async () => {
      if (!active) return state;
      const operationContext = { invalidated: false, subscriptionSupersession };
      activeOperation = operationContext;
      if (publishAuthenticating) {
        publish({ status: AUTH_STATUS.AUTHENTICATING, user: null, session: null, error: null });
      }

      try {
        const session = await operation();
        if (!active || operationContext.invalidated) return state;
        return applySession(applySignedOut ? null : session);
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
          if (activeOperation?.subscriptionSupersession === SUBSCRIPTION_SUPERSESSION.BLOCK) return;
          if (activeOperation) activeOperation.invalidated = true;
          try {
            applySession(session);
          } catch (error) {
            fail(error);
          }
        });
      }
      return enqueueSessionOperation(() => client.loadSession(), PASSIVE_SESSION_OPERATION);
    },
    refreshSession() {
      return enqueueSessionOperation(() => client.refreshSession(), PASSIVE_SESSION_OPERATION);
    },
    signIn(options) {
      return enqueueSessionOperation(() => client.signIn(options), SIGN_IN_OPERATION);
    },
    signOut() {
      return enqueueSessionOperation(() => client.signOut(), SIGN_OUT_OPERATION);
    },
    subscribe(listener) {
      assertActive();
      if (typeof listener !== 'function') throw new TypeError('Auth state listener must be a function');
      listeners.add(listener);
      notify(listener);
      return () => listeners.delete(listener);
    },
    // Disposal is immediately effective. Provider unsubscribe errors are
    // rethrown, and the handle is retained solely so a later dispose can retry.
    dispose() {
      if (active) {
        active = false;
        if (activeOperation) activeOperation.invalidated = true;
        listeners.clear();
      }
      if (!unsubscribeClient) return;
      unsubscribeClient();
      unsubscribeClient = null;
    },
  });
}
