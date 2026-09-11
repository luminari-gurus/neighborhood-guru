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
  authenticatedWorkingCopyKey,
  isDemoPlace,
  isUserAuthoredWorkingCopy,
  legacyMigrationClaimKey,
  orphanedWorkingCopyKey,
  workingCopyKey,
  ORPHAN_ENVELOPE_VERSION,
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

function wrapLocalStorage(inner, hooks = {}) {
  return {
    getItem(key) {
      if (hooks.getItem) return hooks.getItem(key, inner);
      return inner.getItem(key);
    },
    setItem(key, value) {
      if (hooks.setItem) return hooks.setItem(key, value, inner);
      inner.setItem(key, value);
    },
    removeItem(key) {
      if (hooks.removeItem) return hooks.removeItem(key, inner);
      inner.removeItem(key);
    },
    clear() {
      inner.clear();
    },
    key: (index) => inner.key(index),
    get length() {
      return inner.length;
    },
  };
}

function storageError(name = 'QuotaExceededError') {
  const err = new Error(name);
  err.name = name;
  return err;
}

function parseOrphanStored(stored) {
  const parsed = JSON.parse(stored);
  if (parsed && parsed.v === ORPHAN_ENVELOPE_VERSION && typeof parsed.raw === 'string') {
    return { envelope: parsed, payload: JSON.parse(parsed.raw) };
  }
  return { envelope: null, payload: parsed };
}

function orphanPayload(suffix) {
  const stored = localStorage.getItem(orphanedWorkingCopyKey(suffix));
  if (stored == null) return null;
  return parseOrphanStored(stored).payload;
}

function writeOwnerOrphan(suffix, value, namespaceId) {
  const key = orphanedWorkingCopyKey(suffix);
  localStorage.setItem(key, JSON.stringify({
    v: ORPHAN_ENVELOPE_VERSION,
    namespaceId,
    suffix,
    raw: JSON.stringify(value),
    recoveredFrom: 'legacy-conflict',
    quarantinedAt: 1,
  }));
  return key;
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
    globalThis.__NG_MIGRATION_INTERLEAVE__ = undefined;
    globalThis.fetch = originalFetch;
    globalThis.localStorage = createMemoryLocalStorage();
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

  test('does not overwrite an existing namespaced working copy and quarantines divergent leftover keys', () => {
    StorageService.setOwner(ANONYMOUS_OWNER_ID);
    StorageService.setHomeAddress({ name: 'Already migrated', lat: 1, lng: 1 });
    localStorage.setItem(
      LEGACY_WORKING_COPY_KEYS.home_address,
      JSON.stringify({ name: 'Stale leftover', lat: 9, lng: 9 }),
    );

    StorageService.setOwner(ANONYMOUS_OWNER_ID);

    expect(StorageService.getHomeAddress().name).toBe('Already migrated');
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();
    expect(orphanPayload(WORKING_COPY_KEYS.HOME_ADDRESS).name).toBe('Stale leftover');
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

  test('authenticated keys use a user tag so user.id anonymous cannot collide', () => {
    StorageService.setOwner('anonymous');
    StorageService.setHomeAddress({ name: 'Named user anonymous', lat: 1, lng: 1 });
    expect(StorageService.getNamespaceId()).toBe('user:anonymous');
    expect(StorageService.workingCopyKey(WORKING_COPY_KEYS.HOME_ADDRESS)).toBe(
      authenticatedWorkingCopyKey('anonymous', WORKING_COPY_KEYS.HOME_ADDRESS),
    );

    StorageService.setOwner(null);
    expect(StorageService.getNamespaceId()).toBe(ANONYMOUS_OWNER_ID);
    expect(StorageService.getHomeAddress()).toBeNull();
    expect(StorageService.workingCopyKey(WORKING_COPY_KEYS.HOME_ADDRESS)).toBe(
      workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.HOME_ADDRESS),
    );
  });

  test('opaque user ids are encoded without trimming so distinct ids stay distinct', () => {
    StorageService.setOwner(' ada ');
    StorageService.setHomeAddress({ name: 'Padded', lat: 1, lng: 1 });
    StorageService.setOwner('ada');
    expect(StorageService.getHomeAddress()).toBeNull();
    StorageService.setOwner(' ada ');
    expect(StorageService.getHomeAddress().name).toBe('Padded');
    expect(StorageService.workingCopyKey(WORKING_COPY_KEYS.HOME_ADDRESS)).toContain(encodeURIComponent(' ada '));
  });

  test('malformed home JSON yields an empty home instead of throwing', () => {
    StorageService.setOwner(SESSION_A.user.id);
    localStorage.setItem(
      StorageService.workingCopyKey(WORKING_COPY_KEYS.HOME_ADDRESS),
      '{not-json',
    );
    expect(StorageService.getHomeAddress()).toBeNull();
  });

  test('malformed places JSON yields an empty list instead of seeding over it', () => {
    StorageService.setOwner(SESSION_A.user.id);
    localStorage.setItem(
      StorageService.workingCopyKey(WORKING_COPY_KEYS.SAVED_PLACES),
      '{not-json',
    );
    expect(StorageService.getSavedPlaces()).toEqual([]);
    expect(localStorage.getItem(StorageService.workingCopyKey(WORKING_COPY_KEYS.SAVED_PLACES))).toBe('{not-json');
  });

  test('identical leftover legacy keys are removed after migration', () => {
    const home = { name: 'Same', lat: 1, lng: 2 };
    StorageService.setOwner(null);
    StorageService.setHomeAddress(home);
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.home_address, JSON.stringify(home));
    StorageService.setOwner(null);
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();
    expect(StorageService.getHomeAddress()).toEqual(home);
  });

  test('demo destination plus divergent legacy leftover is preserved not deleted', () => {
    StorageService.setOwner(null);
    const seeded = StorageService.getSavedPlaces();
    expect(seeded.every(isDemoPlace)).toBe(true);
    const leftover = [userPlace({ name: 'Older tab cafe' })];
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.saved_places, JSON.stringify(leftover));
    StorageService.setOwner(null);
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.saved_places)).toBeNull();
    expect(orphanPayload(WORKING_COPY_KEYS.SAVED_PLACES)).toEqual(leftover);
    expect(StorageService.getSavedPlaces().every(isDemoPlace)).toBe(true);
  });

  test('partial migration copies missing keys and keeps divergent keys', () => {
    const destHome = { name: 'Already migrated home', lat: 1, lng: 1 };
    const leftoverHome = { name: 'Older tab home', lat: 9, lng: 9 };
    const leftoverPlaces = [userPlace({ name: 'Older tab cafe' })];
    StorageService.setOwner(null);
    StorageService.setHomeAddress(destHome);
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.home_address, JSON.stringify(leftoverHome));
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.saved_places, JSON.stringify(leftoverPlaces));

    StorageService.setOwner(null);

    expect(StorageService.getHomeAddress()).toEqual(destHome);
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();
    expect(orphanPayload(WORKING_COPY_KEYS.HOME_ADDRESS)).toEqual(leftoverHome);
    expect(StorageService.getSavedPlaces()).toEqual(leftoverPlaces);
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.saved_places)).toBeNull();
  });

  test('malformed destination JSON does not delete a valid leftover legacy key', () => {
    StorageService.setOwner(null);
    localStorage.setItem(
      workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.HOME_ADDRESS),
      '{not-json',
    );
    const leftover = { name: 'Older tab home', lat: 2, lng: 2 };
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.home_address, JSON.stringify(leftover));

    StorageService.setOwner(null);

    expect(localStorage.getItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.HOME_ADDRESS))).toBe('{not-json');
    expect(StorageService.getHomeAddress()).toBeNull();
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();
    expect(orphanPayload(WORKING_COPY_KEYS.HOME_ADDRESS)).toEqual(leftover);
  });

  test('empty destination values are treated as present and divergent leftover is kept', () => {
    StorageService.setOwner(null);
    localStorage.setItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.HOME_ADDRESS), '');
    localStorage.setItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.SAVED_PLACES), '[]');
    const leftoverHome = { name: 'Older tab home', lat: 3, lng: 3 };
    const leftoverPlaces = [userPlace({ name: 'Older tab leftover' })];
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.home_address, JSON.stringify(leftoverHome));
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.saved_places, JSON.stringify(leftoverPlaces));

    StorageService.setOwner(null);

    expect(localStorage.getItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.HOME_ADDRESS))).toBe('');
    expect(localStorage.getItem(workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.SAVED_PLACES))).toBe('[]');
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.saved_places)).toBeNull();
    expect(orphanPayload(WORKING_COPY_KEYS.HOME_ADDRESS)).toEqual(leftoverHome);
    expect(orphanPayload(WORKING_COPY_KEYS.SAVED_PLACES)).toEqual(leftoverPlaces);
  });

  test('older-tab write after dest exists is preserved on a later migrate pass', () => {
    StorageService.setOwner(null);
    StorageService.setHomeAddress({ name: 'Current dest', lat: 1, lng: 1 });
    StorageService.setOwner(null);
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();

    localStorage.setItem(
      LEGACY_WORKING_COPY_KEYS.home_address,
      JSON.stringify({ name: 'Newer leftover from older tab', lat: 8, lng: 8 }),
    );
    StorageService.setHomeAddress({ name: 'Current dest', lat: 1, lng: 1 });

    expect(StorageService.getHomeAddress().name).toBe('Current dest');
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeNull();
    expect(orphanPayload(WORKING_COPY_KEYS.HOME_ADDRESS).name).toBe('Newer leftover from older tab');
  });

  test('editing a demo seed converts it into user-authored data', () => {
    const seeded = StorageService.getSavedPlaces();
    const demo = seeded.find((place) => place.id === 'demo-1');
    const remainingDemo = StorageService.savePlace({
      ...demo,
      notes: 'my private alarm code',
    });
    const edited = remainingDemo.find((place) => place.notes === 'my private alarm code');
    expect(edited).toBeTruthy();
    expect(isDemoPlace(edited)).toBe(false);
    expect(edited.id).not.toBe('demo-1');
    expect(edited.source).toBeUndefined();
    expect(remainingDemo.some((place) => place.id === 'demo-2' && isDemoPlace(place))).toBe(true);
    expect(isUserAuthoredWorkingCopy({ savedPlaces: remainingDemo })).toBe(true);
  });

  test('divergent leftover retained after an anonymous pass is not adopted by empty Bob', () => {
    StorageService.setOwner(null);
    StorageService.savePlace(userPlace({ id: undefined, name: 'Anonymous dest cafe' }));
    localStorage.setItem(
      LEGACY_WORKING_COPY_KEYS.saved_places,
      JSON.stringify([userPlace({ name: 'Alice-leftover' })]),
    );

    StorageService.setOwner(null);
    const retainedAfterAnonymousPass = localStorage.getItem(LEGACY_WORKING_COPY_KEYS.saved_places) == null
      && orphanPayload(WORKING_COPY_KEYS.SAVED_PLACES)
        ?.some((place) => place.name === 'Alice-leftover');
    expect(retainedAfterAnonymousPass).toBe(true);
    expect(StorageService.getSavedPlaces().some((place) => place.name === 'Alice-leftover')).toBe(false);

    StorageService.setOwner(SESSION_B.user.id);
    const bobPlaces = StorageService.getSavedPlaces().map((place) => place.name);
    expect(bobPlaces).not.toContain('Alice-leftover');
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.saved_places)).toBeNull();
    expect(orphanPayload(WORKING_COPY_KEYS.SAVED_PLACES))
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Alice-leftover' })]));
  });

  test('edited demo in a legacy key is promoted to user-authored on migrate/load', () => {
    const editedDemo = {
      id: 'demo-1',
      source: 'demo',
      name: 'Sunshine Daycare',
      category: 'favorite',
      people: ['Maya'],
      contacts: [{ type: 'phone_mobile', label: 'Director', value: '(555) 222-3333' }],
      events: [],
      address: '12 Childcare Ln',
      notes: 'alarm code 4512',
      color: '#f59e0b',
      lat: 37.77,
      lng: -122.41,
      createdAt: 1,
    };
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.saved_places, JSON.stringify([
      editedDemo,
      {
        id: 'demo-2',
        source: 'demo',
        name: 'The Millers (Neighbors)',
        category: 'neighbor',
        people: ['Bob Miller', 'Karen Miller'],
        contacts: [
          { type: 'phone_mobile', label: 'Bob Cell', value: '(555) 987-6543' },
          { type: 'phone_home', label: 'House Landline', value: '(555) 987-1122' },
          { type: 'email_personal', label: 'Karen Email', value: 'millers742@gmail.com' },
        ],
        events: [
          { title: 'Trash & Recycling Pickup', day: 'tuesday', time: '7:00 AM' },
        ],
        address: '742 Evergreen Terrace',
        notes: 'Friendly neighbors. Have spare house key & key to water shutoff.',
        color: '#10b981',
        lat: 37.7765,
        lng: -122.4170,
        createdAt: Date.now() - 86400000 * 2,
      },
    ]));

    const loaded = StorageService.getSavedPlaces();
    const converted = loaded.find((place) => place.notes === 'alarm code 4512');
    expect(converted).toBeTruthy();
    expect(converted.id).not.toBe('demo-1');
    expect(converted.source).toBeUndefined();
    expect(isDemoPlace(converted)).toBe(false);
    expect(loaded.some((place) => place.id === 'demo-2' && isDemoPlace(place))).toBe(true);
    expect(isUserAuthoredWorkingCopy({ savedPlaces: loaded })).toBe(true);
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.saved_places)).toBeNull();
  });

  test('concurrent older-tab write during copy is quarantined not deleted', () => {
    const destKey = workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.HOME_ADDRESS);
    const legacyKey = LEGACY_WORKING_COPY_KEYS.home_address;
    const oldVal = JSON.stringify({ name: 'old', lat: 1, lng: 1 });
    const newVal = JSON.stringify({ name: 'new', lat: 2, lng: 2 });
    const inner = createMemoryLocalStorage({ [legacyKey]: oldVal });
    globalThis.localStorage = {
      getItem: (key) => inner.getItem(key),
      setItem(key, value) {
        inner.setItem(key, value);
        if (key === destKey && value === oldVal) {
          inner.setItem(legacyKey, newVal);
        }
      },
      removeItem: (key) => inner.removeItem(key),
      clear: () => inner.clear(),
      key: (index) => inner.key(index),
      get length() {
        return inner.length;
      },
    };

    StorageService.setOwner(null);

    expect(localStorage.getItem(destKey)).toBe(oldVal);
    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(orphanPayload(WORKING_COPY_KEYS.HOME_ADDRESS).name).toBe('new');
  });

  test('failed legacy-key cleanup does not let the next account adopt the data', () => {
    const home = { name: 'Private legacy home', lat: 1, lng: 1 };
    const legacyKey = LEGACY_WORKING_COPY_KEYS.home_address;
    const inner = createMemoryLocalStorage({
      [legacyKey]: JSON.stringify(home),
    });
    let removeFailures = 1;
    globalThis.localStorage = wrapLocalStorage(inner, {
      removeItem(key, store) {
        if (key === legacyKey && removeFailures > 0) {
          removeFailures -= 1;
          throw storageError();
        }
        store.removeItem(key);
      },
    });

    StorageService.setOwner(SESSION_A.user.id);
    const aliceRaw = localStorage.getItem(
      authenticatedWorkingCopyKey(SESSION_A.user.id, WORKING_COPY_KEYS.HOME_ADDRESS),
    );
    const afterAlice = {
      aliceDest: aliceRaw ? JSON.parse(aliceRaw).name : null,
      legacyStillPresent: localStorage.getItem(legacyKey) != null,
    };
    expect(afterAlice).toEqual({
      aliceDest: 'Private legacy home',
      legacyStillPresent: true,
    });

    StorageService.setOwner(SESSION_B.user.id);
    const bobSaw = StorageService.getHomeAddress()?.name ?? null;
    expect(bobSaw).not.toBe('Private legacy home');
    expect(bobSaw).toBeNull();

    StorageService.setOwner(SESSION_A.user.id);
    expect(StorageService.getHomeAddress()?.name).toBe('Private legacy home');
  });

  test('injected setItem dest failure still claims leftover so Bob cannot adopt', () => {
    const home = { name: 'Private legacy home', lat: 1, lng: 1 };
    const legacyKey = LEGACY_WORKING_COPY_KEYS.home_address;
    const destKey = authenticatedWorkingCopyKey(SESSION_A.user.id, WORKING_COPY_KEYS.HOME_ADDRESS);
    const inner = createMemoryLocalStorage({
      [legacyKey]: JSON.stringify(home),
    });
    let failDestWrite = true;
    globalThis.localStorage = wrapLocalStorage(inner, {
      setItem(key, value, store) {
        if (failDestWrite && key === destKey) {
          failDestWrite = false;
          throw storageError();
        }
        store.setItem(key, value);
      },
    });

    StorageService.setOwner(SESSION_A.user.id);
    expect(localStorage.getItem(destKey)).toBeNull();
    expect(localStorage.getItem(legacyKey)).toBeString();
    expect(JSON.parse(localStorage.getItem(legacyMigrationClaimKey(WORKING_COPY_KEYS.HOME_ADDRESS))).namespaceId)
      .toBe(`user:${SESSION_A.user.id}`);

    StorageService.setOwner(SESSION_B.user.id);
    expect(StorageService.getHomeAddress()?.name).not.toBe('Private legacy home');
    expect(StorageService.getHomeAddress()).toBeNull();
  });

  test('injected getItem dest failure still claims leftover so Bob cannot adopt', () => {
    const home = { name: 'Private legacy home', lat: 1, lng: 1 };
    const legacyKey = LEGACY_WORKING_COPY_KEYS.home_address;
    const destKey = authenticatedWorkingCopyKey(SESSION_A.user.id, WORKING_COPY_KEYS.HOME_ADDRESS);
    const inner = createMemoryLocalStorage({
      [legacyKey]: JSON.stringify(home),
    });
    let failDestRead = true;
    globalThis.localStorage = wrapLocalStorage(inner, {
      getItem(key, store) {
        if (failDestRead && key === destKey) {
          failDestRead = false;
          throw storageError('SecurityError');
        }
        return store.getItem(key);
      },
    });

    StorageService.setOwner(SESSION_A.user.id);
    expect(JSON.parse(localStorage.getItem(legacyMigrationClaimKey(WORKING_COPY_KEYS.HOME_ADDRESS))).namespaceId)
      .toBe(`user:${SESSION_A.user.id}`);

    StorageService.setOwner(SESSION_B.user.id);
    expect(StorageService.getHomeAddress()?.name).not.toBe('Private legacy home');
    expect(StorageService.getHomeAddress()).toBeNull();
  });

  test('injected removeItem failure is independent of getItem/setItem and blocks the next owner', () => {
    const places = [userPlace({ name: 'Private leftover cafe' })];
    const legacyKey = LEGACY_WORKING_COPY_KEYS.saved_places;
    const inner = createMemoryLocalStorage({
      [legacyKey]: JSON.stringify(places),
    });
    let failRemove = true;
    globalThis.localStorage = wrapLocalStorage(inner, {
      removeItem(key, store) {
        if (failRemove && key === legacyKey) {
          failRemove = false;
          throw storageError();
        }
        store.removeItem(key);
      },
    });

    StorageService.setOwner(SESSION_A.user.id);
    const alicePlacesRaw = localStorage.getItem(
      authenticatedWorkingCopyKey(SESSION_A.user.id, WORKING_COPY_KEYS.SAVED_PLACES),
    );
    expect(JSON.parse(alicePlacesRaw).some((place) => place.name === 'Private leftover cafe')).toBe(true);
    expect(localStorage.getItem(legacyKey)).toBeString();

    StorageService.setOwner(SESSION_B.user.id);
    expect(StorageService.getSavedPlaces().some((place) => place.name === 'Private leftover cafe')).toBe(false);
  });

  test('newer write after source re-read and before remove is quarantined not deleted', () => {
    const destKey = workingCopyKey(ANONYMOUS_OWNER_ID, WORKING_COPY_KEYS.HOME_ADDRESS);
    const legacyKey = LEGACY_WORKING_COPY_KEYS.home_address;
    const oldVal = JSON.stringify({ name: 'old', lat: 1, lng: 1 });
    const midVal = JSON.stringify({ name: 'mid', lat: 2, lng: 2 });
    const latestVal = JSON.stringify({ name: 'latest', lat: 3, lng: 3 });
    const inner = createMemoryLocalStorage({
      [destKey]: oldVal,
      [legacyKey]: midVal,
    });
    globalThis.localStorage = wrapLocalStorage(inner, {
      setItem(key, value, store) {
        store.setItem(key, value);
        if (key.startsWith('neighborhood_guru:orphaned:')) {
          let raw = value;
          try {
            const parsed = JSON.parse(value);
            if (parsed && parsed.v === ORPHAN_ENVELOPE_VERSION && typeof parsed.raw === 'string') {
              raw = parsed.raw;
            }
          } catch {
            // Keep the stored string when the orphan write is not JSON.
          }
          if (raw === midVal || value === midVal) {
            store.setItem(legacyKey, latestVal);
          }
        }
      },
    });

    StorageService.setOwner(null);

    const orphanKeys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith('neighborhood_guru:orphaned:')) orphanKeys.push(key);
    }
    const orphanValues = orphanKeys.map((key) => parseOrphanStored(localStorage.getItem(key)).payload.name);
    expect({
      dest: JSON.parse(localStorage.getItem(destKey)).name,
      orphan: orphanValues.includes('mid') ? 'mid' : orphanValues[0],
      legacy: localStorage.getItem(legacyKey),
      latestLost: !orphanValues.includes('latest') && localStorage.getItem(legacyKey) == null,
    }).toEqual({
      dest: 'old',
      orphan: 'mid',
      legacy: null,
      latestLost: false,
    });
    expect(orphanValues).toEqual(expect.arrayContaining(['mid', 'latest']));
  });

  test('orphaned leftovers are included in export and recoverable via preview/restore', () => {
    StorageService.setOwner(null);
    StorageService.setHomeAddress({ name: 'current', lat: 1, lng: 1 });
    writeOwnerOrphan(
      WORKING_COPY_KEYS.HOME_ADDRESS,
      { name: 'recover me', lat: 9, lng: 9 },
      ANONYMOUS_OWNER_ID,
    );

    const exported = JSON.parse(StorageService.exportDataJSON());
    expect(exported.homeAddress.name).toBe('current');
    expect(exported.orphanedWorkingCopies.length).toBeGreaterThan(0);
    expect(exported.orphanedWorkingCopies.some((orphan) => (
      orphan.status === 'orphaned'
      && orphan.homeAddress?.name === 'recover me'
      && typeof orphan.raw === 'string'
    ))).toBe(true);

    const preview = StorageService.previewOrphanedWorkingCopies();
    const recover = preview.find((orphan) => orphan.preview.homeName === 'recover me');
    expect(recover).toBeTruthy();
    expect(recover.preview.homeName).toBe('recover me');

    const mergeConflict = StorageService.restoreOrphanedWorkingCopy(recover.key, { mode: 'merge' });
    expect(mergeConflict.ok).toBe(false);
    expect(mergeConflict.reason).toBe('conflict');
    expect(StorageService.getHomeAddress().name).toBe('current');

    const replaced = StorageService.restoreOrphanedWorkingCopy(recover.key, { mode: 'replace' });
    expect(replaced.ok).toBe(true);
    expect(StorageService.getHomeAddress().name).toBe('recover me');
  });

  test('orphaned places can be merged into the current namespace after preview', () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.savePlace(userPlace({ id: undefined, name: 'Ada current cafe' }));
    writeOwnerOrphan(
      WORKING_COPY_KEYS.SAVED_PLACES,
      [userPlace({ id: 'place_orphan', name: 'recover me cafe' })],
      `user:${SESSION_A.user.id}`,
    );

    const preview = StorageService.previewOrphanedWorkingCopy(
      orphanedWorkingCopyKey(WORKING_COPY_KEYS.SAVED_PLACES),
    );
    expect(preview.preview.placeNames).toContain('recover me cafe');

    const merged = StorageService.restoreOrphanedWorkingCopy(preview.key, { mode: 'merge' });
    expect(merged.ok).toBe(true);
    const names = StorageService.getSavedPlaces().map((place) => place.name);
    expect(names).toEqual(expect.arrayContaining(['Ada current cafe', 'recover me cafe']));
  });

  test('two namespaces cannot both adopt the same leftover when claims race', () => {
    const home = { name: 'shared legacy private home', lat: 1, lng: 1 };
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.home_address, JSON.stringify(home));
    let bobRan = false;
    globalThis.__NG_MIGRATION_INTERLEAVE__ = (phase, detail) => {
      if (phase === 'after-absent-claim-read'
        && detail.namespaceId === `user:${SESSION_A.user.id}`
        && !bobRan) {
        bobRan = true;
        StorageService.migrateLegacyForOwner(SESSION_B.user.id);
      }
    };

    StorageService.setOwner(SESSION_A.user.id);
    const alice = StorageService.getHomeAddress()?.name ?? null;
    StorageService.setOwner(SESSION_B.user.id);
    const bob = StorageService.getHomeAddress()?.name ?? null;
    const claim = JSON.parse(localStorage.getItem(legacyMigrationClaimKey(WORKING_COPY_KEYS.HOME_ADDRESS)) || 'null');

    expect(alice === 'shared legacy private home' && bob === 'shared legacy private home').toBe(false);
    expect(alice === 'shared legacy private home' || bob === 'shared legacy private home').toBe(true);
    expect(claim?.namespaceId === `user:${SESSION_A.user.id}` || claim?.namespaceId === `user:${SESSION_B.user.id}`).toBe(true);
  });

  test('malformed migration claims fail closed and are not adopted', () => {
    const home = { name: 'Alice private', lat: 1, lng: 1 };
    localStorage.setItem(LEGACY_WORKING_COPY_KEYS.home_address, JSON.stringify(home));
    localStorage.setItem(legacyMigrationClaimKey(WORKING_COPY_KEYS.HOME_ADDRESS), '{not-json');

    StorageService.setOwner(SESSION_B.user.id);
    expect(StorageService.getHomeAddress()?.name).not.toBe('Alice private');
    expect(StorageService.getHomeAddress()).toBeNull();
    expect(localStorage.getItem(LEGACY_WORKING_COPY_KEYS.home_address)).toBeString();
    expect(localStorage.getItem(legacyMigrationClaimKey(WORKING_COPY_KEYS.HOME_ADDRESS))).toBe('{not-json');
  });

  test('Bob cannot preview or restore Alice orphaned leftovers', () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress({ name: 'Ada current', lat: 1, lng: 1 });
    writeOwnerOrphan(
      WORKING_COPY_KEYS.HOME_ADDRESS,
      { name: 'Alice orphan', lat: 9, lng: 9 },
      `user:${SESSION_A.user.id}`,
    );

    StorageService.setOwner(SESSION_B.user.id);
    const bobCanPreview = StorageService.previewOrphanedWorkingCopy(
      orphanedWorkingCopyKey(WORKING_COPY_KEYS.HOME_ADDRESS),
    );
    const restore = StorageService.restoreOrphanedWorkingCopy(
      orphanedWorkingCopyKey(WORKING_COPY_KEYS.HOME_ADDRESS),
      { mode: 'replace' },
    );
    expect(bobCanPreview).toBeNull();
    expect(restore.ok).toBe(false);
    expect(restore.reason).toBe('wrong-owner');
    expect(StorageService.getHomeAddress()).toBeNull();
    expect(StorageService.listOrphanedWorkingCopies()).toEqual([]);
  });

  test('restoring malformed orphaned places does not erase current data', () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.savePlace(userPlace({ id: undefined, name: 'Keep' }));
    const key = orphanedWorkingCopyKey(WORKING_COPY_KEYS.SAVED_PLACES);
    localStorage.setItem(key, JSON.stringify({
      v: ORPHAN_ENVELOPE_VERSION,
      namespaceId: `user:${SESSION_A.user.id}`,
      suffix: WORKING_COPY_KEYS.SAVED_PLACES,
      raw: '{not-json',
      recoveredFrom: 'legacy-conflict',
      quarantinedAt: 1,
    }));

    const result = StorageService.restoreOrphanedWorkingCopy(key, { mode: 'replace' });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'invalid' }));
    expect(StorageService.getSavedPlaces().some((place) => place.name === 'Keep')).toBe(true);
  });

  test('orphan export includes the exact raw payload for a lossless round trip', () => {
    StorageService.setOwner(SESSION_A.user.id);
    const raw = '{not-json leftover';
    const key = orphanedWorkingCopyKey(WORKING_COPY_KEYS.HOME_ADDRESS);
    localStorage.setItem(key, JSON.stringify({
      v: ORPHAN_ENVELOPE_VERSION,
      namespaceId: `user:${SESSION_A.user.id}`,
      suffix: WORKING_COPY_KEYS.HOME_ADDRESS,
      raw,
      recoveredFrom: 'legacy-conflict',
      quarantinedAt: 1,
    }));

    const exported = JSON.parse(StorageService.exportDataJSON());
    const orphan = exported.orphanedWorkingCopies.find((item) => item.key === key);
    expect(orphan.raw).toBe(raw);

    localStorage.removeItem(key);
    expect(StorageService.importDataJSON(JSON.stringify(exported))).toBe(true);
    const stored = JSON.parse(localStorage.getItem(key));
    expect(stored.raw).toBe(raw);
  });

  test('unscoped historical orphans are device-level and do not bind to Bob', () => {
    StorageService.setOwner(SESSION_B.user.id);
    localStorage.setItem(
      orphanedWorkingCopyKey(WORKING_COPY_KEYS.HOME_ADDRESS),
      JSON.stringify({ name: 'ambiguous leftover', lat: 4, lng: 4 }),
    );
    expect(StorageService.listOrphanedWorkingCopies()).toEqual([]);
    const device = StorageService.listDeviceOrphanedWorkingCopies();
    expect(device.some((orphan) => orphan.preview.homeName === 'ambiguous leftover')).toBe(true);
    const restore = StorageService.restoreOrphanedWorkingCopy(
      orphanedWorkingCopyKey(WORKING_COPY_KEYS.HOME_ADDRESS),
    );
    expect(restore.ok).toBe(false);
    expect(restore.reason).toBe('device-level');
    expect(StorageService.getHomeAddress()).toBeNull();
    const exported = StorageService.exportDeviceOrphanedWorkingCopy(
      orphanedWorkingCopyKey(WORKING_COPY_KEYS.HOME_ADDRESS),
    );
    expect(exported.ok).toBe(true);
    expect(exported.raw).toContain('ambiguous leftover');
  });
});

describe('working-copy bind and login I/O', () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryLocalStorage();
    StorageService.setOwner(null);
  });

  afterEach(() => {
    globalThis.__NG_MIGRATION_INTERLEAVE__ = undefined;
    globalThis.fetch = originalFetch;
    globalThis.localStorage = createMemoryLocalStorage();
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

  test('production order initializes auth before binding the working copy', async () => {
    const client = new FakeAuthClient({ session: SESSION_A });
    const auth = createAuthState(client);
    await auth.initialize();
    expect(auth.getState().status).toBe(AUTH_STATUS.AUTHENTICATED);

    bindNeighborhoodWorkingCopy(auth, StorageService);
    expect(StorageService.getOwnerId()).toBe(SESSION_A.user.id);
    expect(StorageService.getNamespaceId()).toBe(`user:${SESSION_A.user.id}`);

    auth.dispose();
  });

  test('unsubscribing the working-copy bind ignores later session changes', async () => {
    const client = new FakeAuthClient({ session: SESSION_A });
    const auth = createAuthState(client);
    const unsubscribe = bindNeighborhoodWorkingCopy(auth, StorageService);
    await auth.initialize();
    expect(StorageService.getOwnerId()).toBe(SESSION_A.user.id);

    unsubscribe();
    await auth.signOut();
    expect(StorageService.getOwnerId()).toBe(SESSION_A.user.id);

    auth.dispose();
  });

  test('storage exceptions after identity flip still notify owner change', async () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress({ name: 'A private home', lat: 1, lng: 1 });

    const client = new FakeAuthClient({ session: SESSION_A });
    const auth = createAuthState(client);
    const owners = [];
    bindNeighborhoodWorkingCopy(auth, StorageService, {
      onOwnerChange: (ownerId) => owners.push(ownerId),
    });
    await auth.initialize();
    expect(StorageService.getOwnerId()).toBe(SESSION_A.user.id);

    const inner = globalThis.localStorage;
    globalThis.localStorage = {
      getItem() {
        const err = new Error('blocked');
        err.name = 'SecurityError';
        throw err;
      },
      setItem() {
        const err = new Error('blocked');
        err.name = 'SecurityError';
        throw err;
      },
      removeItem() {
        const err = new Error('blocked');
        err.name = 'SecurityError';
        throw err;
      },
      clear: () => inner.clear(),
      key: (index) => inner.key(index),
      get length() {
        return inner.length;
      },
    };

    await auth.signIn({ session: SESSION_B });

    expect(auth.getState().user.id).toBe(SESSION_B.user.id);
    expect(StorageService.getOwnerId()).toBe(SESSION_B.user.id);
    expect(StorageService.getNamespaceId()).toBe(`user:${SESSION_B.user.id}`);
    expect(owners).toContain(SESSION_B.user.id);

    auth.dispose();
  });
});
