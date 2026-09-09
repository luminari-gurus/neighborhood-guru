import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  AUTH_STATUS,
  FakeAuthClient,
  createAuthState,
  createHttpAuthClient,
} from '../src/js/auth/index.js';
import {
  bindNeighborhoodWorkingCopy,
  ownerIdFromAuthState,
} from '../src/js/neighborhood-working-copy.js';
import {
  ANONYMOUS_OWNER_ID,
  DEVICE_STORAGE_KEYS,
  LEGACY_WORKING_COPY_KEYS,
  StorageService,
  WORKING_COPY_KEYS,
  isDemoPlace,
  isUserAuthoredWorkingCopy,
  workingCopyKey,
} from '../src/js/storage.js';

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

const SESSION_A = {
  user: { id: 'user-ada', displayName: 'Ada', email: 'ada@example.test', avatarUrl: null },
  expiresAt: '2030-01-01T00:00:00.000Z',
};

const SESSION_B = {
  user: { id: 'user-bob', displayName: 'Bob', email: 'bob@example.test', avatarUrl: null },
  expiresAt: '2030-01-01T00:00:00.000Z',
};

function createMemoryLocalStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear() {
      for (const key of Object.keys(store)) delete store[key];
    },
    key: (index) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
}

function userPlace(overrides = {}) {
  return {
    id: 'place_user_cafe',
    name: 'User Cafe',
    category: 'favorite',
    people: ['Ada'],
    contacts: [{ type: 'phone_mobile', label: 'Cell', value: '(555) 000-1111' }],
    events: [],
    address: '1 Main St',
    notes: 'Mine',
    color: '#3b82f6',
    lat: 37.77,
    lng: -122.41,
    createdAt: 1,
    ...overrides,
  };
}

function throwingNeighborhoodStore() {
  const calls = [];
  const fail = (method) => async () => {
    calls.push(method);
    throw new Error(`NeighborhoodStore.${method} must not run on login`);
  };
  return {
    calls,
    getSnapshot: fail('getSnapshot'),
    putSnapshot: fail('putSnapshot'),
    deleteSnapshot: fail('deleteSnapshot'),
  };
}

function isNeighborhoodNetworkUrl(url) {
  return String(url).includes('/api/neighborhood');
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('namespaced browser storage', () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryLocalStorage();
    StorageService.setOwner(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    StorageService.setOwner(null);
    globalThis.localStorage = originalLocalStorage;
  });

  test('writes home, places, consent, dirty, and etag into the anonymous namespace', () => {
    const home = { name: '10 Oak St', lat: 1, lng: 2 };
    StorageService.setHomeAddress(home);
    StorageService.savePlace(userPlace({ id: undefined }));
    StorageService.setSyncConsent(true);
    StorageService.setDirty(true);
    StorageService.setLastEtag('etag-1');

    expect(StorageService.getOwnerId()).toBe(ANONYMOUS_OWNER_ID);
    expect(localStorage.getItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.HOME_ADDRESS))).toBeString();
    expect(localStorage.getItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.SAVED_PLACES))).toBeString();
    expect(localStorage.getItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.SYNC_CONSENT))).toBe('true');
    expect(localStorage.getItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.DIRTY))).toBe('1');
    expect(localStorage.getItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.LAST_ETAG))).toBe('etag-1');
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.saved_places)).toBeNull();
  });

  test('authenticated sessions use user.id namespaced keys', () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress({ name: "Ada's house", lat: 3, lng: 4 });
    StorageService.savePlace(userPlace({ id: undefined, name: "Ada's cafe" }));
    StorageService.setSyncConsent(false);
    StorageService.setDirty(true);
    StorageService.setLastEtag('ng-ada');

    expect(StorageService.getHomeAddress().name).toBe("Ada's house");
    expect(localStorage.getItem(workingCopyKey(SESSION_A.user.id, WORKING_COPY_KEYS.HOME_ADDRESS))).toBeString();
    expect(localStorage.getItem(workingCopyKey(SESSION_A.user.id, WORKING_COPY_KEYS.SAVED_PLACES))).toBeString();
    expect(localStorage.getItem(workingCopyKey(SESSION_A.user.id, WORKING_COPY_KEYS.DIRTY))).toBe('1');
    expect(localStorage.getItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.HOME_ADDRESS))).toBeNull();
  });

  test('migrates unprefixed keys into the anonymous namespace without data loss', () => {
    const home = { name: 'Legacy Home', lat: 37.7, lng: -122.4 };
    const places = [userPlace()];
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.home_address, JSON.stringify(home));
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.saved_places, JSON.stringify(places));

    StorageService.setOwner(null);

    expect(StorageService.getHomeAddress()).toEqual(home);
    expect(StorageService.getSavedPlaces()).toEqual(places);
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.saved_places)).toBeNull();
    expect(localStorage.getItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.HOME_ADDRESS))).toBeString();
  });

  test('migrates unprefixed keys into the restored sole-user namespace', () => {
    const home = { name: 'Logged-in Home', lat: 10, lng: 20 };
    const places = [userPlace({ name: 'Logged-in Cafe' })];
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.home_address, JSON.stringify(home));
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.saved_places, JSON.stringify(places));

    StorageService.setOwner(SESSION_A.user.id);

    expect(StorageService.getHomeAddress()).toEqual(home);
    expect(StorageService.getSavedPlaces().map((place) => place.name)).toContain('Logged-in Cafe');
    expect(localStorage.getItem(workingCopyKey(SESSION_A.user.id, WORKING_COPY_KEYS.HOME_ADDRESS))).toBeString();
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();
    expect(localStorage.getItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.HOME_ADDRESS))).toBeNull();
  });

  test('does not overwrite an existing namespaced working copy during migration', () => {
    StorageService.setOwner(ANONYMOUS_OWNER_ID);
    StorageService.setHomeAddress({ name: 'Already migrated', lat: 1, lng: 1 });
    localStorage.setItem(
      LEGACY_WORKING_COPY_KEYS.home_address,
      JSON.stringify({ name: 'Stale leftover', lat: 9, lng: 9 }),
    );

    StorageService.setOwner(ANONYMOUS_OWNER_ID);

    expect(StorageService.getHomeAddress().name).toBe('Already migrated');
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();
  });

  test('reading working-copy keys before setOwner migrates legacy data instead of seeding over it', () => {
    const home = { name: 'Legacy Home', lat: 37.7, lng: -122.4 };
    const places = [userPlace({ name: 'Legacy Cafe' })];
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.home_address, JSON.stringify(home));
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.saved_places, JSON.stringify(places));

    const loadedPlaces = StorageService.getSavedPlaces();
    const loadedHome = StorageService.getHomeAddress();

    expect(loadedHome).toEqual(home);
    expect(loadedPlaces).toEqual(places);
    expect(loadedPlaces.some((place) => place.name === 'Legacy Cafe')).toBe(true);
    expect(loadedPlaces.every(isDemoPlace)).toBe(false);
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.saved_places)).toBeNull();

    StorageService.setOwner(null);
    expect(StorageService.getHomeAddress()).toEqual(home);
    expect(StorageService.getSavedPlaces().map((place) => place.name)).toContain('Legacy Cafe');
  });

  test('does not namespace device-level map style, tokens, or JamBase show cache', () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setMapboxToken('pk.test-token');
    StorageService.setJambaseToken('jb-test-token');
    StorageService.setPreferredStyle('satellite');
    localStorage.setItem('guru_jb_shows_venue-1', JSON.stringify({ shows: [] }));

    expect(localStorage.getItem(DEVICE_STORAGE_KEYS.MAPBOX_TOKEN)).toBe('pk.test-token');
    expect(localStorage.getItem(DEVICE_STORAGE_KEYS.JAMBASE_TOKEN)).toBe('jb-test-token');
    expect(localStorage.getItem(DEVICE_STORAGE_KEYS.MAP_STYLE)).toBe('satellite');
    expect(localStorage.getItem('guru_jb_shows_venue-1')).toBeString();
    expect(localStorage.getItem(workingCopyKey(SESSION_A.user.id, 'mapbox_token'))).toBeNull();
    expect(localStorage.getItem(workingCopyKey(SESSION_A.user.id, 'map_style'))).toBeNull();

    StorageService.setOwner(null);
    expect(StorageService.getMapboxToken()).toBe('pk.test-token');
    expect(StorageService.getPreferredStyle()).toBe('satellite');
  });

  test('sign-out switches to anonymous and does not copy authenticated places', () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress({ name: "Ada's house", lat: 1, lng: 2 });
    StorageService.savePlace(userPlace({ id: undefined, name: "Ada's secret notes" }));

    StorageService.setOwner(null);

    expect(StorageService.getOwnerId()).toBe(ANONYMOUS_OWNER_ID);
    expect(StorageService.getHomeAddress()).toBeNull();
    expect(StorageService.getSavedPlaces().some((place) => place.name === "Ada's secret notes")).toBe(false);
    expect(StorageService.getSavedPlaces().every(isDemoPlace)).toBe(true);
    expect(isUserAuthoredWorkingCopy({
      homeAddress: StorageService.getHomeAddress(),
      savedPlaces: StorageService.getSavedPlaces(),
    })).toBe(false);

    StorageService.setOwner(SESSION_A.user.id);
    expect(StorageService.getHomeAddress().name).toBe("Ada's house");
    expect(StorageService.getSavedPlaces().some((place) => place.name === "Ada's secret notes")).toBe(true);
  });

  test('switching accounts does not expose another namespace', () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress({ name: 'Ada home', lat: 1, lng: 1 });
    StorageService.savePlace(userPlace({ id: undefined, name: 'Ada place' }));

    StorageService.setOwner(SESSION_B.user.id);
    expect(StorageService.getHomeAddress()).toBeNull();
    expect(StorageService.getSavedPlaces().some((place) => place.name === 'Ada place')).toBe(false);
    StorageService.setHomeAddress({ name: 'Bob home', lat: 2, lng: 2 });
    StorageService.savePlace(userPlace({ id: undefined, name: 'Bob place' }));

    StorageService.setOwner(SESSION_A.user.id);
    expect(StorageService.getHomeAddress().name).toBe('Ada home');
    expect(StorageService.getSavedPlaces().map((place) => place.name)).toContain('Ada place');
    expect(StorageService.getSavedPlaces().map((place) => place.name)).not.toContain('Bob place');
  });

  test('import writes only the current namespace', () => {
    StorageService.setOwner(SESSION_A.user.id);
    const backup = {
      version: 1,
      exportedAt: '2026-09-09T00:00:00.000Z',
      homeAddress: { name: 'Imported', lat: 5, lng: 6 },
      savedPlaces: [userPlace({ name: 'Imported place' })],
    };

    expect(StorageService.importDataJSON(JSON.stringify(backup))).toBe(true);
    expect(StorageService.getHomeAddress().name).toBe('Imported');

    StorageService.setOwner(SESSION_B.user.id);
    expect(StorageService.getHomeAddress()).toBeNull();
    expect(StorageService.getSavedPlaces().some((place) => place.name === 'Imported place')).toBe(false);
  });

  test('demo-1, demo-2, and source: demo are not user-authored', () => {
    const seeded = StorageService.getSavedPlaces();
    expect(seeded.every(isDemoPlace)).toBe(true);
    expect(isUserAuthoredWorkingCopy({ savedPlaces: seeded })).toBe(false);
    expect(isDemoPlace({ id: 'demo-1', people: [], contacts: [] })).toBe(true);
    expect(isDemoPlace({ id: 'place_1', source: 'demo' })).toBe(true);
    expect(isDemoPlace(userPlace())).toBe(false);
    expect(isUserAuthoredWorkingCopy({
      savedPlaces: seeded,
      homeAddress: { name: 'Real home', lat: 1, lng: 1 },
    })).toBe(true);
    expect(isUserAuthoredWorkingCopy({ savedPlaces: [userPlace()] })).toBe(true);
  });

  test('sign-in does not copy anonymous user-authored places into the account namespace', () => {
    StorageService.setOwner(null);
    StorageService.setHomeAddress({ name: 'Anonymous home', lat: 1, lng: 1 });
    StorageService.savePlace(userPlace({ id: undefined, name: 'Anonymous cafe' }));

    StorageService.setOwner(SESSION_A.user.id);
    expect(StorageService.getHomeAddress()).toBeNull();
    expect(StorageService.getSavedPlaces().some((place) => place.name === 'Anonymous cafe')).toBe(false);

    StorageService.setOwner(null);
    expect(StorageService.getHomeAddress().name).toBe('Anonymous home');
  });
});

describe('working-copy bind and login I/O', () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryLocalStorage();
    StorageService.setOwner(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    StorageService.setOwner(null);
    globalThis.localStorage = originalLocalStorage;
  });

  test('ownerIdFromAuthState ignores AUTHENTICATING so another namespace is not flashed', () => {
    expect(ownerIdFromAuthState({
      status: AUTH_STATUS.AUTHENTICATING,
      user: null,
      session: null,
      error: null,
    })).toBeUndefined();
    expect(ownerIdFromAuthState({
      status: AUTH_STATUS.AUTHENTICATED,
      user: SESSION_A.user,
      session: SESSION_A,
      error: null,
    })).toBe(SESSION_A.user.id);
    expect(ownerIdFromAuthState({
      status: AUTH_STATUS.ANONYMOUS,
      user: null,
      session: null,
      error: null,
    })).toBeNull();
    expect(ownerIdFromAuthState({
      status: AUTH_STATUS.ERROR,
      user: null,
      session: null,
      error: new Error('refresh failed'),
    })).toBeUndefined();
  });

  test('session restore performs zero neighborhood network I/O', async () => {
    const urls = [];
    const neighborhoodStore = throwingNeighborhoodStore();
    globalThis.fetch = async (input, init) => {
      const url = String(input?.url ?? input);
      urls.push(url);
      if (isNeighborhoodNetworkUrl(url)) {
        throw new Error(`neighborhood network I/O is forbidden on login: ${url}`);
      }
      if (url.includes('/api/auth/session')) {
        return jsonResponse({
          user: SESSION_A.user,
          expiresAt: SESSION_A.expiresAt,
          csrfToken: 'csrf-token',
        });
      }
      throw new Error(`unexpected fetch ${url} ${init?.method || 'GET'}`);
    };

    const client = createHttpAuthClient({
      fetch: globalThis.fetch,
      location: { pathname: '/', search: '', hash: '' },
    });
    const auth = createAuthState(client);
    bindNeighborhoodWorkingCopy(auth, StorageService, { neighborhoodStore });
    const state = await auth.initialize();

    expect(state.status).toBe(AUTH_STATUS.AUTHENTICATED);
    expect(StorageService.getOwnerId()).toBe(SESSION_A.user.id);
    expect(neighborhoodStore.calls).toEqual([]);
    expect(urls.filter(isNeighborhoodNetworkUrl)).toEqual([]);
    expect(urls.some((url) => url.includes('/api/auth/session'))).toBe(true);

    auth.dispose();
  });

  test('http sign-in then session restore perform zero neighborhood network I/O', async () => {
    const urls = [];
    const assigns = [];
    const neighborhoodStore = throwingNeighborhoodStore();
    let sessionBody = null;

    const fetchImpl = async (input, init) => {
      const url = String(input?.url ?? input);
      urls.push(url);
      if (isNeighborhoodNetworkUrl(url)) {
        throw new Error(`neighborhood network I/O is forbidden on login: ${url}`);
      }
      if (url.includes('/api/auth/session')) {
        return jsonResponse(sessionBody);
      }
      throw new Error(`unexpected fetch ${url} ${init?.method || 'GET'}`);
    };
    globalThis.fetch = fetchImpl;

    const client = createHttpAuthClient({
      fetch: fetchImpl,
      location: {
        pathname: '/',
        search: '',
        hash: '',
        assign(href) {
          assigns.push(String(href));
        },
      },
    });
    const auth = createAuthState(client);
    bindNeighborhoodWorkingCopy(auth, StorageService, { neighborhoodStore });

    await auth.initialize();
    expect(auth.getState().status).toBe(AUTH_STATUS.ANONYMOUS);

    await auth.signIn({ providerId: 'oidc' });
    expect(assigns.some((href) => href.includes('/api/auth/login/oidc'))).toBe(true);

    sessionBody = {
      user: SESSION_A.user,
      expiresAt: SESSION_A.expiresAt,
      csrfToken: 'csrf-token',
    };
    await auth.refreshSession();

    expect(auth.getState().status).toBe(AUTH_STATUS.AUTHENTICATED);
    expect(StorageService.getOwnerId()).toBe(SESSION_A.user.id);
    expect(neighborhoodStore.calls).toEqual([]);
    expect(urls.filter(isNeighborhoodNetworkUrl)).toEqual([]);
    expect(urls.some((url) => url.includes('/api/auth/session'))).toBe(true);
    expect(urls.some((url) => url.includes('/api/neighborhood'))).toBe(false);

    auth.dispose();
  });

  test('sign-in does not flash anonymous data or copy places, and calls no NeighborhoodStore', async () => {
    const urls = [];
    const neighborhoodStore = throwingNeighborhoodStore();
    globalThis.fetch = async (input) => {
      const url = String(input?.url ?? input);
      urls.push(url);
      if (isNeighborhoodNetworkUrl(url)) {
        throw new Error(`neighborhood network I/O is forbidden on login: ${url}`);
      }
      throw new Error('sign-in must not fetch neighborhood data');
    };

    StorageService.setOwner(null);
    StorageService.savePlace(userPlace({ id: undefined, name: 'Stay anonymous' }));

    const client = new FakeAuthClient();
    const auth = createAuthState(client);
    const owners = [];
    bindNeighborhoodWorkingCopy(auth, StorageService, {
      neighborhoodStore,
      onOwnerChange: (ownerId) => owners.push(ownerId),
    });

    await auth.initialize();
    const authenticatingOwners = [];
    const unsubscribe = auth.subscribe((state) => {
      if (state.status === AUTH_STATUS.AUTHENTICATING) {
        authenticatingOwners.push(StorageService.getOwnerId());
      }
    });

    await auth.signIn({ session: SESSION_A });
    unsubscribe();

    expect(StorageService.getOwnerId()).toBe(SESSION_A.user.id);
    expect(authenticatingOwners.every((owner) => owner === ANONYMOUS_OWNER_ID)).toBe(true);
    expect(StorageService.getSavedPlaces().some((place) => place.name === 'Stay anonymous')).toBe(false);
    expect(neighborhoodStore.calls).toEqual([]);
    expect(urls.filter(isNeighborhoodNetworkUrl)).toEqual([]);
    expect(owners).toContain(SESSION_A.user.id);

    auth.dispose();
  });

  test('sign-out rebinds anonymous without copying the account working copy', async () => {
    const neighborhoodStore = throwingNeighborhoodStore();
    const client = new FakeAuthClient({ session: SESSION_A });
    const auth = createAuthState(client);
    bindNeighborhoodWorkingCopy(auth, StorageService, { neighborhoodStore });
    await auth.initialize();

    StorageService.setHomeAddress({ name: 'Account home', lat: 8, lng: 8 });
    StorageService.savePlace(userPlace({ id: undefined, name: 'Account-only' }));

    await auth.signOut();

    expect(StorageService.getOwnerId()).toBe(ANONYMOUS_OWNER_ID);
    expect(StorageService.getSavedPlaces().some((place) => place.name === 'Account-only')).toBe(false);
    expect(neighborhoodStore.calls).toEqual([]);

    auth.dispose();
  });

  test('auth errors do not expose the anonymous namespace', async () => {
    const client = new FakeAuthClient({ session: SESSION_A });
    const auth = createAuthState(client);
    bindNeighborhoodWorkingCopy(auth, StorageService);
    await auth.initialize();
    StorageService.setHomeAddress({ name: 'Keep me', lat: 1, lng: 1 });

    client.failNext('refreshSession');
    await auth.refreshSession();

    expect(auth.getState().status).toBe(AUTH_STATUS.ERROR);
    expect(StorageService.getOwnerId()).toBe(SESSION_A.user.id);
    expect(StorageService.getHomeAddress().name).toBe('Keep me');

    auth.dispose();
  });
});
