import { afterEach, describe, expect, test } from 'bun:test';

import {
  AUTH_STATUS,
  FakeAuthClient,
  createAnonymousAuthClient,
  createAuthState,
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
  };

  loadSession() {
    const operation = deferred();
    this.operations.loadSession.push(operation);
    return operation.promise;
  }

  refreshSession() {
    const operation = deferred();
    this.operations.refreshSession.push(operation);
    return operation.promise;
  }

  signIn() {
    const operation = deferred();
    this.operations.signIn.push(operation);
    return operation.promise;
  }
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
      'Auth providers require a non-empty id',
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

  test('subscription events invalidate stale operation successes and errors', async () => {
    const client = new ControlledAuthClient();
    const auth = createAuthState(client);
    const notifications = [];
    auth.subscribe((state) => notifications.push(state));

    const initialization = auth.initialize();
    client.setSession({ ...session, user: { ...session.user, id: 'new' } });
    const authenticated = auth.getState();
    client.operations.loadSession[0].resolve(null);

    expect(await initialization).toBe(authenticated);
    expect(auth.getState()).toBe(authenticated);

    const refresh = auth.refreshSession();
    client.setSession(session);
    const refreshedBySubscription = auth.getState();
    client.operations.refreshSession[0].reject(new Error('stale refresh failure'));

    expect(await refresh).toBe(refreshedBySubscription);
    expect(auth.getState()).toBe(refreshedBySubscription);
    expect(notifications.at(-1)).toBe(refreshedBySubscription);

    const signIn = auth.signIn();
    client.setSession({ ...session, user: { ...session.user, id: 'subscription-wins' } });
    const signedInBySubscription = auth.getState();
    client.operations.signIn[0].resolve(session);

    expect(await signIn).toBe(signedInBySubscription);
    expect(auth.getState()).toBe(signedInBySubscription);
    auth.dispose();
  });

  test('only the newest concurrent operation may publish a terminal result', async () => {
    const client = new ControlledAuthClient();
    const auth = createAuthState(client);

    const initialization = auth.initialize();
    const signIn = auth.signIn();
    const newestSession = { ...session, user: { ...session.user, id: 'newest' } };
    client.operations.signIn[0].resolve(newestSession);
    const newestState = await signIn;
    client.operations.loadSession[0].reject(new Error('older failure'));

    expect(await initialization).toBe(newestState);
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
    const stateAtDisposal = auth.getState();

    auth.dispose();
    client.operations.loadSession[0].resolve(session);
    client.operations.refreshSession[0].reject(new Error('disposed refresh failure'));
    client.setSession(session);

    expect(await initialization).toBe(stateAtDisposal);
    expect(await refresh).toBe(stateAtDisposal);
    expect(auth.getState()).toBe(stateAtDisposal);
    expect(notifications).toBe(3);
    expect(() => auth.subscribe(() => {})).toThrow('Auth state has been disposed');
    await expect(auth.refreshSession()).rejects.toThrow('Auth state has been disposed');
    await expect(auth.signIn({ session })).rejects.toThrow('Auth state has been disposed');
    await expect(auth.signOut()).rejects.toThrow('Auth state has been disposed');
    await expect(auth.initialize()).rejects.toThrow('Auth state has been disposed');
    await expect(auth.discoverProviders()).rejects.toThrow('Auth state has been disposed');
  });
});
