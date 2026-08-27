import { afterEach, describe, expect, test } from 'bun:test';

import {
  AUTH_STATUS,
  FakeAuthClient,
  createAnonymousAuthClient,
  createAuthState,
  normalizeProviders,
  normalizeSession,
} from '../../src/js/auth/index.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ControlledAuthClient extends FakeAuthClient {
  operations = {
    loadSession: [],
    refreshSession: [],
    signIn: [],
    signOut: [],
  };

  calls = [];

  loadSession() {
    this.calls.push('loadSession');
    const operation = deferred();
    this.operations.loadSession.push(operation);
    return operation.promise;
  }

  refreshSession() {
    this.calls.push('refreshSession');
    const operation = deferred();
    this.operations.refreshSession.push(operation);
    return operation.promise;
  }

  signIn() {
    this.calls.push('signIn');
    const operation = deferred();
    this.operations.signIn.push(operation);
    return operation.promise;
  }

  signOut() {
    this.calls.push('signOut');
    const operation = deferred();
    this.operations.signOut.push(operation);
    return operation.promise;
  }
}

class ThrowingUnsubscribeAuthClient extends ControlledAuthClient {
  subscribers = new Set();
  unsubscribeCalls = 0;
  removeBeforeThrow = false;

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => {
      this.unsubscribeCalls += 1;
      if (this.removeBeforeThrow) this.subscribers.delete(listener);
      if (this.unsubscribeCalls === 1) throw new Error('unsubscribe failed');
      this.subscribers.delete(listener);
    };
  }

  emit(session) {
    this.subscribers.forEach((listener) => listener(session));
  }
}

async function initializeControlledAuth(auth, client) {
  const initialization = auth.initialize();
  await Promise.resolve();
  client.operations.loadSession[0].resolve(null);
  await initialization;
}

describe('anonymous authentication', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('initializes and discovers no providers without network requests', async () => {
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount += 1;
      throw new Error('Anonymous authentication must not use the network');
    };

    const auth = createAuthState(createAnonymousAuthClient());
    const providers = await auth.discoverProviders();
    const state = await auth.initialize();

    expect(state).toEqual({
      status: AUTH_STATUS.ANONYMOUS,
      user: null,
      session: null,
      error: null,
    });
    expect(providers).toEqual([]);
    expect(Object.isFrozen(providers)).toBe(true);
    expect(requestCount).toBe(0);

    auth.dispose();
  });
});

describe('authentication state transitions', () => {
  const session = {
    user: { id: 'user-1', displayName: 'Ada Neighbor', email: 'ada@example.test', avatarUrl: null },
    expiresAt: '2030-01-01T00:00:00.000Z',
  };

  test('publishes normalized authenticating and authenticated states', async () => {
    const client = new FakeAuthClient();
    const auth = createAuthState(client);
    const statuses = [];
    auth.subscribe((state) => statuses.push(state.status));
    await auth.initialize();
    const state = await auth.signIn({ session });
    expect(statuses).toContain(AUTH_STATUS.AUTHENTICATING);
    expect(state.status).toBe(AUTH_STATUS.AUTHENTICATED);
    expect(state.user).toEqual(session.user);
    auth.dispose();
  });

  test('supports multiple provider discovery through the auth facade', async () => {
    const sourceProviders = [
      { id: 'apple', displayName: 'Apple', ignored: 'provider-specific' },
      { id: 'google', displayName: 'Google' },
    ];
    const client = new FakeAuthClient({ providers: sourceProviders, session });
    const auth = createAuthState(client);
    sourceProviders[0].displayName = 'Changed outside the fake';
    const providers = await auth.discoverProviders();
    expect(providers).toEqual([
      { id: 'apple', displayName: 'Apple' },
      { id: 'google', displayName: 'Google' },
    ]);
    expect(Object.isFrozen(providers)).toBe(true);
    expect(providers.every(Object.isFrozen)).toBe(true);
    expect(() => providers.push({ id: 'other', displayName: 'Other' })).toThrow();
    expect(() => { providers[0].displayName = 'Changed'; }).toThrow();
    expect((await auth.initialize()).status).toBe(AUTH_STATUS.AUTHENTICATED);
    client.setSession(null);
    expect(auth.getState().status).toBe(AUTH_STATUS.ANONYMOUS);
    client.setSession(session);
    expect((await auth.refreshSession()).status).toBe(AUTH_STATUS.AUTHENTICATED);
    expect((await auth.signOut()).status).toBe(AUTH_STATUS.ANONYMOUS);
    auth.dispose();
  });

  test('rejects invalid provider data and reports discovery errors through the facade', async () => {
    const invalidClient = new FakeAuthClient();
    invalidClient.discoverProviders = async () => [{ displayName: 'Missing id' }];
    const invalidAuth = createAuthState(invalidClient);
    await expect(invalidAuth.discoverProviders()).rejects.toThrow(
      'Auth providers require a non-empty string id',
    );
    invalidAuth.dispose();

    const client = new FakeAuthClient();
    const auth = createAuthState(client);
    client.failNext('discoverProviders', new Error('provider discovery unavailable'));
    await expect(auth.discoverProviders()).rejects.toThrow('provider discovery unavailable');
    auth.dispose();
  });

  test('reports errors and permits recovery', async () => {
    const client = new FakeAuthClient();
    const auth = createAuthState(client);
    client.failNext('loadSession', new Error('session unavailable'));
    const failed = await auth.initialize();
    expect(failed.status).toBe(AUTH_STATUS.ERROR);
    expect(failed.error.message).toBe('session unavailable');
    expect((await auth.refreshSession()).status).toBe(AUTH_STATUS.ANONYMOUS);
    auth.dispose();
  });

  test('unsubscribes state and client listeners', async () => {
    const client = new FakeAuthClient();
    const auth = createAuthState(client);
    let notifications = 0;
    const unsubscribe = auth.subscribe(() => notifications += 1);
    unsubscribe();
    await auth.initialize();
    expect(notifications).toBe(1);
    auth.dispose();
    client.setSession(session);
    expect(auth.getState().status).toBe(AUTH_STATUS.ANONYMOUS);
  });

  test('subscription events supersede stale passive operation successes and errors', async () => {
    const client = new ControlledAuthClient();
    const auth = createAuthState(client);
    const notifications = [];
    auth.subscribe((state) => notifications.push(state));

    const initialization = auth.initialize();
    await Promise.resolve();
    client.setSession({ ...session, user: { ...session.user, id: 'new' } });
    const authenticated = auth.getState();
    client.operations.loadSession[0].resolve(null);

    expect(await initialization).toBe(authenticated);
    expect(auth.getState()).toBe(authenticated);

    const refresh = auth.refreshSession();
    await Promise.resolve();
    client.setSession(session);
    const refreshedBySubscription = auth.getState();
    client.operations.refreshSession[0].reject(new Error('stale refresh failure'));

    expect(await refresh).toBe(refreshedBySubscription);
    expect(auth.getState()).toBe(refreshedBySubscription);
    expect(notifications.at(-1)).toBe(refreshedBySubscription);

    auth.dispose();
  });

  test('executes concurrent facade operations in invocation order', async () => {
    const client = new ControlledAuthClient();
    const auth = createAuthState(client);

    const initialization = auth.initialize();
    const signIn = auth.signIn();
    await Promise.resolve();
    expect(client.calls).toEqual(['loadSession']);
    client.operations.loadSession[0].reject(new Error('older failure'));
    expect((await initialization).status).toBe(AUTH_STATUS.ERROR);
    await Promise.resolve();

    const newestSession = { ...session, user: { ...session.user, id: 'newest' } };
    expect(client.calls).toEqual(['loadSession', 'signIn']);
    client.operations.signIn[0].resolve(newestSession);
    const newestState = await signIn;

    expect(auth.getState()).toBe(newestState);
    expect(auth.getState().user.id).toBe('newest');
    auth.dispose();
  });

  test('dispose invalidates operations and makes later facade use inert', async () => {
    const client = new ControlledAuthClient();
    const auth = createAuthState(client);
    let notifications = 0;
    auth.subscribe(() => notifications += 1);
    const initialization = auth.initialize();
    const refresh = auth.refreshSession();
    await Promise.resolve();
    const stateAtDisposal = auth.getState();

    auth.dispose();
    client.operations.loadSession[0].resolve(session);
    expect(client.operations.refreshSession).toHaveLength(0);
    client.setSession(session);

    expect(await initialization).toBe(stateAtDisposal);
    expect(await refresh).toBe(stateAtDisposal);
    expect(auth.getState()).toBe(stateAtDisposal);
    expect(notifications).toBe(2);
    expect(() => auth.subscribe(() => {})).toThrow('Auth state has been disposed');
    await expect(auth.refreshSession()).rejects.toThrow('Auth state has been disposed');
    await expect(auth.signIn({ session })).rejects.toThrow('Auth state has been disposed');
    await expect(auth.signOut()).rejects.toThrow('Auth state has been disposed');
    await expect(auth.initialize()).rejects.toThrow('Auth state has been disposed');
    await expect(auth.discoverProviders()).rejects.toThrow('Auth state has been disposed');
  });
});

describe('provider-neutral auth normalization', () => {
  test('rejects non-scalar provider and session fields', () => {
    const invalidOptionalValues = [{ mutable: true }, [], () => 'value', 123, true];

    for (const value of invalidOptionalValues) {
      expect(() => normalizeProviders([{ id: 'provider', displayName: value }])).toThrow(
        'Auth provider displayName must be a string or null',
      );
      expect(() => normalizeSession({ user: { id: 'user', displayName: value } })).toThrow(
        'Auth user displayName must be a string or null',
      );
      expect(() => normalizeSession({ user: { id: 'user', email: value } })).toThrow(
        'Auth user email must be a string or null',
      );
      expect(() => normalizeSession({ user: { id: 'user', avatarUrl: value } })).toThrow(
        'Auth user avatarUrl must be a string or null',
      );
      expect(() => normalizeSession({ user: { id: 'user' }, expiresAt: value })).toThrow(
        'Auth session expiresAt must be a string or null',
      );
    }

    for (const id of ['', '   ', {}, [], null, undefined]) {
      expect(() => normalizeProviders([{ id }])).toThrow(
        'Auth providers require a non-empty string id',
      );
      expect(() => normalizeSession({ user: { id } })).toThrow(
        'Auth sessions require a user with a non-empty string id',
      );
    }
  });

  test('returns immutable scalar records and preserves optional empty strings', () => {
    const providers = normalizeProviders([{ id: ' provider ', displayName: '' }]);
    const session = normalizeSession({
      user: { id: ' user ', displayName: '', email: '', avatarUrl: '' },
      expiresAt: '',
    });

    expect(providers).toEqual([{ id: ' provider ', displayName: '' }]);
    expect(session).toEqual({
      user: { id: ' user ', displayName: '', email: '', avatarUrl: '' },
      expiresAt: '',
    });
    expect(Object.isFrozen(providers)).toBe(true);
    expect(Object.isFrozen(providers[0])).toBe(true);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.user)).toBe(true);
  });
});

describe('auth mutation ordering and listener isolation', () => {
  const session = {
    user: { id: 'user-1', displayName: 'Ada Neighbor', email: 'ada@example.test', avatarUrl: null },
    expiresAt: '2030-01-01T00:00:00.000Z',
  };

  test('sign-out success wins after provider execution begins and an older sign-in event arrives', async () => {
    const client = new ControlledAuthClient();
    const auth = createAuthState(client);
    await initializeControlledAuth(auth, client);
    const signIn = auth.signIn();
    await Promise.resolve();

    client.operations.signIn[0].resolve(session);
    await signIn;

    const signOut = auth.signOut();
    await Promise.resolve();
    expect(client.calls).toEqual(['loadSession', 'signIn', 'signOut']);
    client.setSession({ ...session, user: { ...session.user, id: 'delayed-sign-in' } });
    expect(auth.getState().user.id).toBe('user-1');

    client.operations.signOut[0].resolve(null);
    expect((await signOut).status).toBe(AUTH_STATUS.ANONYMOUS);
    expect(auth.getState().status).toBe(AUTH_STATUS.ANONYMOUS);
    auth.dispose();
  });

  test('reports later sign-out failure despite an older delayed sign-in event', async () => {
    const client = new ControlledAuthClient();
    const auth = createAuthState(client);
    await initializeControlledAuth(auth, client);
    const signIn = auth.signIn();
    await Promise.resolve();

    client.operations.signIn[0].resolve(session);
    await signIn;

    const signOut = auth.signOut();
    await Promise.resolve();
    expect(client.calls).toEqual(['loadSession', 'signIn', 'signOut']);
    client.setSession({ ...session, user: { ...session.user, id: 'delayed-sign-in' } });
    expect(auth.getState().user.id).toBe('user-1');
    client.operations.signOut[0].reject(new Error('sign-out failed'));

    const state = await signOut;
    expect(state.status).toBe(AUTH_STATUS.ERROR);
    expect(state.error.message).toBe('sign-out failed');
    expect(auth.getState()).toBe(state);
    auth.dispose();
  });

  for (const outcome of ['success', 'failure']) {
    test(`sign-in ${outcome} wins without publishing a stale provider event`, async () => {
      const client = new ControlledAuthClient();
      const auth = createAuthState(client);
      await initializeControlledAuth(auth, client);
      const statuses = [];
      auth.subscribe((state) => statuses.push(state.status));

      const signIn = auth.signIn();
      await Promise.resolve();
      client.setSession({ ...session, user: { ...session.user, id: 'stale' } });
      expect(auth.getState().status).toBe(AUTH_STATUS.AUTHENTICATING);

      if (outcome === 'success') client.operations.signIn[0].resolve(session);
      else client.operations.signIn[0].reject(new Error('sign-in failed'));

      const result = await signIn;
      expect(result.status).toBe(outcome === 'success' ? AUTH_STATUS.AUTHENTICATED : AUTH_STATUS.ERROR);
      expect(statuses.slice(0, -1)).not.toContain(AUTH_STATUS.AUTHENTICATED);
      if (outcome === 'success') expect(statuses.at(-1)).toBe(AUTH_STATUS.AUTHENTICATED);
      else expect(result.error.message).toBe('sign-in failed');
      auth.dispose();
    });
  }

  for (const removeBeforeThrow of [false, true]) {
    test(`dispose is inactive and retries when unsubscribe ${removeBeforeThrow ? 'removes then throws' : 'throws before removal'}`, async () => {
      const client = new ThrowingUnsubscribeAuthClient();
      client.removeBeforeThrow = removeBeforeThrow;
      const auth = createAuthState(client);
      await initializeControlledAuth(auth, client);
      let notifications = 0;
      auth.subscribe(() => notifications += 1);
      const active = auth.refreshSession();
      const queued = auth.signIn();
      await Promise.resolve();
      const stateAtDisposal = auth.getState();
      const notificationsAtDisposal = notifications;

      expect(() => auth.dispose()).toThrow('unsubscribe failed');
      expect(client.unsubscribeCalls).toBe(1);
      client.emit(session);
      client.operations.refreshSession[0].resolve(session);

      expect(await active).toBe(stateAtDisposal);
      expect(await queued).toBe(stateAtDisposal);
      expect(client.operations.signIn).toHaveLength(0);
      expect(auth.getState()).toBe(stateAtDisposal);
      expect(notifications).toBe(notificationsAtDisposal);
      expect(() => auth.subscribe(() => {})).toThrow('Auth state has been disposed');

      expect(() => auth.dispose()).not.toThrow();
      expect(client.unsubscribeCalls).toBe(2);
      expect(client.subscribers.size).toBe(0);
      auth.dispose();
      expect(client.unsubscribeCalls).toBe(2);
    });
  }

  test('isolates listeners that throw initially and during transitions', async () => {
    const client = new FakeAuthClient();
    const auth = createAuthState(client);
    const healthyStatuses = [];
    let throwingCalls = 0;

    expect(() => auth.subscribe(() => {
      throwingCalls += 1;
      throw new Error('listener failed');
    })).not.toThrow();
    auth.subscribe((state) => healthyStatuses.push(state.status));

    await expect(auth.initialize()).resolves.toMatchObject({ status: AUTH_STATUS.ANONYMOUS });
    await expect(auth.signIn({ session })).resolves.toMatchObject({ status: AUTH_STATUS.AUTHENTICATED });
    await expect(auth.signOut()).resolves.toMatchObject({ status: AUTH_STATUS.ANONYMOUS });

    expect(throwingCalls).toBe(6);
    expect(healthyStatuses).toEqual([
      AUTH_STATUS.ANONYMOUS,
      AUTH_STATUS.AUTHENTICATING,
      AUTH_STATUS.ANONYMOUS,
      AUTH_STATUS.AUTHENTICATING,
      AUTH_STATUS.AUTHENTICATED,
      AUTH_STATUS.ANONYMOUS,
    ]);
    expect(auth.getState().status).toBe(AUTH_STATUS.ANONYMOUS);
    auth.dispose();
  });
});
