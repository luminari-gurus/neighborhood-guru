import { afterEach, describe, expect, test } from 'bun:test';

import {
  AUTH_STATUS,
  FakeAuthClient,
  createAnonymousAuthClient,
  createAuthState,
} from '../../src/js/auth/index.js';

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
});
