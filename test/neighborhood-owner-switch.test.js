import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { FakeAuthClient, createAuthState } from '../src/js/auth/index.js';
import { JamBaseService } from '../src/js/jambase-service.js';
import { OverpassService } from '../src/js/overpass-service.js';
import { bindNeighborhoodWorkingCopy } from '../src/js/neighborhood-working-copy.js';
import { NeighborhoodGuruApp } from '../src/main.js';
import { UIController } from '../src/js/ui.js';
import {
  StorageService,
  WORKING_COPY_KEYS,
} from '../src/js/storage.js';

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
const originalSearchVenues = JamBaseService.searchVenues;
const originalFetchVenueDetails = JamBaseService.fetchVenueDetails;
const originalFetchNearbyPois = OverpassService.fetchNearbyPois;

const SESSION_A = {
  user: { id: 'user-ada', displayName: 'Ada', email: 'ada@example.test', avatarUrl: null },
  expiresAt: '2030-01-01T00:00:00.000Z',
};

const SESSION_B = {
  user: { id: 'user-bob', displayName: 'Bob', email: 'bob@example.test', avatarUrl: null },
  expiresAt: '2030-01-01T00:00:00.000Z',
};

const PLACE_A = {
  id: 'place_ada',
  name: "Ada's bakery",
  category: 'favorite',
  people: ['Ada'],
  contacts: [{ type: 'phone_mobile', label: 'Cell', value: '555' }],
  notes: 'spare house key',
  address: '102 Oak',
  color: '#3b82f6',
  lat: 37.77,
  lng: -122.41,
};

const HOME_A = { name: 'A private home', lat: 37.77, lng: -122.41 };

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

function installHoldableWebLocks() {
  let autoGrant = true;
  const waiters = [];
  const previous = globalThis.navigator;
  globalThis.navigator = {
    ...(previous || {}),
    locks: {
      request(name, options, callback) {
        if (typeof options === 'function') {
          callback = options;
          options = {};
        }
        return new Promise((resolve, reject) => {
          const run = () => {
            Promise.resolve()
              .then(() => callback())
              .then(resolve, reject);
          };
          if (autoGrant) run();
          else waiters.push(run);
        });
      },
    },
  };
  return {
    previous,
    hold() { autoGrant = false; },
    releaseAll() {
      autoGrant = true;
      const queued = waiters.splice(0, waiters.length);
      queued.forEach((run) => run());
    },
    pendingCount() { return waiters.length; },
  };
}

function createStubUi() {
  const values = {
    formLocationId: "Ada's place",
    formName: "Ada's bakery",
    formNotes: 'spare house key',
    formLat: '37.77',
    formLng: '-122.41',
    formCategory: 'favorite',
    formAddress: '102 Oak',
    formJambaseId: '',
    formCapacity: '',
  };
  const elements = {
    formLocationId: { get value() { return values.formLocationId; }, set value(v) { values.formLocationId = v; } },
    formName: { get value() { return values.formName; }, set value(v) { values.formName = v; } },
    formNotes: { get value() { return values.formNotes; }, set value(v) { values.formNotes = v; } },
    formLat: { get value() { return values.formLat; }, set value(v) { values.formLat = v; } },
    formLng: { get value() { return values.formLng; }, set value(v) { values.formLng = v; } },
    formCategory: { get value() { return values.formCategory; }, set value(v) { values.formCategory = v; } },
    formAddress: { get value() { return values.formAddress; }, set value(v) { values.formAddress = v; } },
    formCapacity: { get value() { return values.formCapacity; }, set value(v) { values.formCapacity = v; } },
    formJambaseId: { get value() { return values.formJambaseId; }, set value(v) { values.formJambaseId = v; } },
    jambasePickerSubtitle: { textContent: '' },
    jambaseStatusMsg: { textContent: '' },
    poiStatusSubtitle: { textContent: '' },
    addressSearchInput: { value: '' },
    locationForm: {
      reset() {
        values.formLocationId = '';
        values.formName = '';
        values.formNotes = '';
        values.formLat = '';
        values.formLng = '';
        values.formAddress = '';
        values.formJambaseId = '';
        values.formCapacity = '';
      },
      querySelector: () => null,
    },
    locationModal: { classList: { add() {}, remove() {}, contains: () => false } },
    homeStatusSubtitle: { textContent: 'Home: A private home', style: {} },
    currentHomeDisplay: { textContent: 'A private home' },
    clearHomeBtn: { classList: { add() {}, remove() {} } },
    placesCountBadge: { textContent: '1' },
    savedPlacesList: { innerHTML: '' },
    peopleListContainer: { innerHTML: '' },
    contactMethodsContainer: { innerHTML: '' },
    eventsListContainer: { innerHTML: '' },
  };
  return {
    elements,
    renderedHome: 'A private home',
    renderedPlaces: [],
    renderedPois: [],
    formOpen: true,
    pickerOpens: 0,
    jambaseOnSelect: null,
    toasts: [],
    weatherUpdates: [],
    resetOwnerScopedPresentation() {
      this.formOpen = false;
      this.jambaseOnSelect = null;
      elements.locationForm.reset();
    },
    openLocationModal() { this.formOpen = true; },
    closeLocationModal() { this.formOpen = false; },
    openPoiModal() {},
    closePoiModal() {},
    openJambasePickerModal() { this.pickerOpens += 1; },
    closeJambasePickerModal() {},
    renderJambaseSearchResults(matches, onSelect) {
      this.jambaseOnSelect = onSelect;
    },
    renderPoiResults(pois) { this.renderedPois = pois; },
    updateHomeHeaderStatus(home) {
      this.renderedHome = home?.name || 'Earth Globe View';
    },
    renderPlacesList(places) { this.renderedPlaces = places; },
    showToast(message) { this.toasts.push(message); },
    updateWeatherDisplay(weather) { this.weatherUpdates.push(weather); },
    getPeopleFieldsData: () => [],
    getContactFieldsData: () => [],
    getEventFieldsData: () => [],
  };
}

function createStubMapbox({ geocode } = {}) {
  return {
    map: null,
    homeMarker: null,
    currentTempCoords: { lat: 37.77, lng: -122.41 },
    lastFly: null,
    lastMarker: null,
    markerOrder: [],
    clearTempMarker() { this.currentTempCoords = null; },
    renderSavedMarkers() {},
    renderHomeMarker() {},
    showTempMarker(coords) {
      this.currentTempCoords = coords;
      this.lastMarker = coords;
      this.markerOrder.push(coords);
    },
    unbindMapListeners() { this.unbound = true; },
    teardownMap() {
      this.tornDown = true;
      this.unbound = true;
      this.removed = true;
    },
    flyToLocation(lat, lng) {
      this.lastFly = { lat, lng };
    },
    flyToHome() {},
    flyToGlobe() {},
    async geocodeAddress(query) {
      if (geocode) return geocode(query);
      return { name: 'Geocoded', lat: 1, lng: 1 };
    },
  };
}

async function createBoundApp({ ui, mapboxService, session = SESSION_A } = {}) {
  const client = new FakeAuthClient({ session });
  const auth = createAuthState(client);
  const app = new NeighborhoodGuruApp({
    storage: StorageService,
    ui,
    mapboxService: mapboxService || createStubMapbox(),
    auth,
  });
  await auth.initialize();
  app.unsubscribeWorkingCopy = bindNeighborhoodWorkingCopy(auth, StorageService, {
    onOwnerChange: () => {
      if (app.viewReady && !app.disposed) {
        app.clearOwnerScopedPresentation();
      }
    },
    onOwnerReady: () => {
      if (app.viewReady && !app.disposed) {
        app.syncNeighborhoodViewFromStorage();
      }
    },
  });
  app.viewReady = true;
  await app.unsubscribeWorkingCopy.ready;
  app.syncNeighborhoodViewFromStorage();
  return { app, auth, client };
}

describe('owner-switch presentation isolation', () => {
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    globalThis.localStorage = createMemoryLocalStorage();
    StorageService.setOwner(null);
    globalThis.fetch = async () => new Response(JSON.stringify({
      current_weather: { temperature: 70, windspeed: 1, weathercode: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = createMemoryLocalStorage();
    StorageService.setOwner(null);
    globalThis.localStorage = originalLocalStorage;
    globalThis.navigator = originalNavigator;
    JamBaseService.searchVenues = originalSearchVenues;
    JamBaseService.fetchVenueDetails = originalFetchVenueDetails;
    OverpassService.fetchNearbyPois = originalFetchNearbyPois;
  });

  test('switching accounts closes the editor and cannot save A into B', async () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress(HOME_A);
    StorageService.savePlace(PLACE_A);

    const ui = createStubUi();
    const { app, auth } = await createBoundApp({ ui, session: SESSION_A });
    app.openLocationEditor({
      id: PLACE_A.id,
      name: PLACE_A.name,
      notes: PLACE_A.notes,
      lat: PLACE_A.lat,
      lng: PLACE_A.lng,
    });
    expect(ui.formOpen).toBe(true);
    expect(ui.elements.formNotes.value).toBe('spare house key');
    expect(app.editorNamespaceId).toBe(`user:${SESSION_A.user.id}`);

    await auth.signIn({ session: SESSION_B });

    expect(StorageService.getOwnerId()).toBe(SESSION_B.user.id);
    expect(ui.formOpen).toBe(false);
    expect(ui.elements.formNotes.value).toBe('');
    expect(ui.elements.formName.value).toBe('');
    expect(ui.elements.formLocationId.value).toBe('');
    expect(ui.elements.formLat.value).toBe('');
    expect(app.editorNamespaceId).toBeNull();
    expect(app.homeAddress).toBeNull();
    expect(ui.renderedHome).toBe('Earth Globe View');
    expect(ui.renderedPlaces.some((place) => place.notes === 'spare house key')).toBe(false);

    ui.elements.formName.value = PLACE_A.name;
    ui.elements.formNotes.value = PLACE_A.notes;
    ui.elements.formLat.value = String(PLACE_A.lat);
    ui.elements.formLng.value = String(PLACE_A.lng);
    ui.formOpen = true;
    app.handleSaveLocation();

    expect(StorageService.getSavedPlaces().some((place) => place.notes === 'spare house key')).toBe(false);
    expect(ui.toasts.some((message) => /not saved/i.test(message))).toBe(true);

    app.dispose();
  });

  test('malformed destination home does not keep the previous owner rendered', async () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress(HOME_A);

    const ui = createStubUi();
    const { app } = await createBoundApp({ ui, session: SESSION_A });
    expect(ui.renderedHome).toBe('A private home');
    expect(app.homeAddress.name).toBe('A private home');

    StorageService.setOwner(SESSION_B.user.id);
    localStorage.setItem(
      StorageService.workingCopyKey(WORKING_COPY_KEYS.HOME_ADDRESS),
      '{not-json',
    );

    app.syncNeighborhoodViewFromStorage({ ownerChanged: true });

    expect(StorageService.getOwnerId()).toBe(SESSION_B.user.id);
    expect(app.homeAddress).toBeNull();
    expect(ui.renderedHome).toBe('Earth Globe View');

    app.dispose();
  });

  test('malformed destination places do not keep the previous owner rendered', async () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.savePlace(PLACE_A);

    const ui = createStubUi();
    const { app } = await createBoundApp({ ui, session: SESSION_A });
    expect(ui.renderedPlaces.some((place) => place.notes === 'spare house key')).toBe(true);

    StorageService.setOwner(SESSION_B.user.id);
    localStorage.setItem(
      StorageService.workingCopyKey(WORKING_COPY_KEYS.SAVED_PLACES),
      '{not-json',
    );

    app.syncNeighborhoodViewFromStorage({ ownerChanged: true });

    expect(app.savedPlaces).toEqual([]);
    expect(ui.renderedPlaces).toEqual([]);
    expect(StorageService.getSavedPlaces()).toEqual([]);

    app.dispose();
  });

  test('late geocode after an owner switch does not open the previous editor', async () => {
    let resolveGeocode;
    const geocodePromise = new Promise((resolve) => {
      resolveGeocode = resolve;
    });
    const mapboxService = createStubMapbox({
      geocode: () => geocodePromise,
    });
    const ui = createStubUi();
    StorageService.setOwner(SESSION_A.user.id);
    const { app } = await createBoundApp({ ui, mapboxService, session: SESSION_A });

    const clickPromise = app.onMapClicked({ lat: 37.77, lng: -122.41 });
    StorageService.setOwner(SESSION_B.user.id);
    app.syncNeighborhoodViewFromStorage({ ownerChanged: true });
    const generationAtSwitch = app.neighborhoodGeneration;
    resolveGeocode({ name: "Ada's leftover pin", lat: 37.77, lng: -122.41 });
    await clickPromise;

    expect(app.neighborhoodGeneration).toBe(generationAtSwitch);
    expect(ui.formOpen).toBe(false);
    expect(app.editorNamespaceId).toBeNull();

    app.dispose();
  });

  test('dispose unsubscribes working-copy updates', async () => {
    const ui = createStubUi();
    const { app, auth } = await createBoundApp({ ui, session: SESSION_A });
    StorageService.setHomeAddress({ name: 'Ada home', lat: 1, lng: 1 });
    const ownerAtDispose = StorageService.getOwnerId();

    app.unsubscribeWorkingCopy();
    app.unsubscribeWorkingCopy = null;
    await auth.signOut();
    expect(StorageService.getOwnerId()).toBe(ownerAtDispose);

    app.dispose();
  });

  test('late JamBase search after an owner switch does not open A picker or write into B', async () => {
    let resolveSearch;
    const searchPromise = new Promise((resolve) => {
      resolveSearch = resolve;
    });
    JamBaseService.searchVenues = async () => searchPromise;

    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress(HOME_A);
    const ui = createStubUi();
    const { app, auth } = await createBoundApp({ ui, session: SESSION_A });
    app.openLocationEditor({ name: 'Ada venue', lat: 1, lng: 1 });
    ui.elements.formName.value = 'Ada venue';

    const searchDone = app.handleJambaseSearch();
    await auth.signIn({ session: SESSION_B });
    app.openLocationEditor({ name: 'Bob venue', lat: 2, lng: 2 });
    ui.elements.formName.value = 'Bob venue';
    resolveSearch([{ id: 'ada-venue', name: 'Ada leftover venue', city: 'SF', state: 'CA' }]);
    await searchDone;

    expect(ui.pickerOpens).toBe(0);
    expect(ui.elements.formJambaseId.value).not.toBe('ada-venue');
    expect(app.editorNamespaceId).toBe(`user:${SESSION_B.user.id}`);
    expect(app.editorMatchesCurrentOwner()).toBe(true);

    app.dispose();
  });

  test('JamBase venue details after an owner switch do not apply to B editor', async () => {
    JamBaseService.searchVenues = async () => [{ id: 'ada-venue', name: 'Ada venue' }];
    let resolveDetails;
    JamBaseService.fetchVenueDetails = () => new Promise((resolve) => {
      resolveDetails = resolve;
    });

    StorageService.setOwner(SESSION_A.user.id);
    const ui = createStubUi();
    const { app, auth } = await createBoundApp({ ui, session: SESSION_A });
    app.openLocationEditor({ name: 'Ada venue', lat: 1, lng: 1 });
    ui.elements.formName.value = 'Ada venue';
    await app.handleJambaseSearch();
    expect(ui.pickerOpens).toBe(1);
    expect(typeof ui.jambaseOnSelect).toBe('function');

    const selectPromise = ui.jambaseOnSelect({ id: 'ada-venue', name: 'Ada venue' });
    await auth.signIn({ session: SESSION_B });
    app.openLocationEditor({ name: 'Bob venue', lat: 2, lng: 2 });
    resolveDetails({ capacity: 1200 });
    await selectPromise;

    expect(ui.elements.formJambaseId.value).not.toBe('ada-venue');
    expect(ui.elements.formCapacity.value).not.toBe(1200);
    expect(ui.elements.formCapacity.value).not.toBe('1200');

    app.dispose();
  });

  test('late POI results are not assigned or rendered for the next owner', async () => {
    let resolvePois;
    OverpassService.fetchNearbyPois = () => new Promise((resolve) => {
      resolvePois = resolve;
    });

    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress(HOME_A);
    const ui = createStubUi();
    const { app, auth } = await createBoundApp({ ui, session: SESSION_A });

    const discoverPromise = app.handleDiscoverPois();
    await auth.signIn({ session: SESSION_B });
    resolvePois([{ name: 'Ada cafe', typeLabel: 'Cafe', category: 'favorite', address: '', notes: '', color: '#3b82f6', lat: 1, lng: 1 }]);
    await discoverPromise;

    expect(app.currentDiscoveredPois).toEqual([]);
    app.applyPoiFilter();
    expect(ui.renderedPois).toEqual([]);

    app.dispose();
  });

  test('delayed migration lock cannot let Alice POI or weather commit for Bob', async () => {
    const locks = installHoldableWebLocks();
    try {
      StorageService.setOwner(SESSION_A.user.id);
      StorageService.setHomeAddress(HOME_A);
      const ui = createStubUi();
      const { app, auth } = await createBoundApp({ ui, session: SESSION_A });

      let resolvePois;
      OverpassService.fetchNearbyPois = () => new Promise((resolve) => {
        resolvePois = resolve;
      });
      let resolveWeather;
      globalThis.fetch = () => new Promise((resolve) => {
        resolveWeather = () => resolve(new Response(JSON.stringify({
          current_weather: { temperature: 99, windspeed: 1, weathercode: 0 },
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      });

      const poiDone = app.handleDiscoverPois();
      const weatherDone = app.fetchAndDisplayWeather();
      const generationBefore = app.neighborhoodGeneration;
      const poiGenBefore = app.poiSearchGeneration;

      locks.hold();
      const signedIn = auth.signIn({ session: SESSION_B });
      for (let i = 0; i < 30 && locks.pendingCount() === 0; i += 1) {
        await Promise.resolve();
      }
      expect(locks.pendingCount()).toBeGreaterThan(0);
      expect(StorageService.getOwnerId()).toBe(SESSION_B.user.id);
      expect(app.neighborhoodGeneration).toBeGreaterThan(generationBefore);
      expect(app.poiSearchGeneration).toBeGreaterThan(poiGenBefore);

      const weatherCountAfterClear = ui.weatherUpdates.length;
      resolvePois([{
        name: 'Ada cafe',
        typeLabel: 'Cafe',
        category: 'favorite',
        address: '',
        notes: '',
        color: '#3b82f6',
        lat: 1,
        lng: 1,
      }]);
      await poiDone;
      resolveWeather();
      await weatherDone;

      expect(app.currentDiscoveredPois).toEqual([]);
      app.applyPoiFilter();
      expect(ui.renderedPois).toEqual([]);
      expect(ui.weatherUpdates.slice(weatherCountAfterClear).some((weather) => weather?.temp === 99)).toBe(false);

      globalThis.fetch = async () => new Response(JSON.stringify({
        current_weather: { temperature: 70, windspeed: 1, weathercode: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      locks.releaseAll();
      await signedIn;
      await app.unsubscribeWorkingCopy.ready;
      app.dispose();
    } finally {
      globalThis.navigator = locks.previous;
    }
  });

  test('storage exceptions still clear the previous owner UI', async () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress(HOME_A);
    StorageService.savePlace(PLACE_A);

    const ui = createStubUi();
    const { app, auth } = await createBoundApp({ ui, session: SESSION_A });
    expect(ui.renderedHome).toBe('A private home');
    const ownerChanges = [];
    const previousOnChange = app.unsubscribeWorkingCopy;
    previousOnChange?.();
    app.unsubscribeWorkingCopy = bindNeighborhoodWorkingCopy(auth, StorageService, {
      onOwnerChange: (ownerId) => {
        ownerChanges.push(ownerId);
        if (app.viewReady && !app.disposed) {
          app.clearOwnerScopedPresentation();
        }
      },
      onOwnerReady: () => {
        if (app.viewReady && !app.disposed) {
          app.syncNeighborhoodViewFromStorage();
        }
      },
    });

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
    expect(ownerChanges).toContain(SESSION_B.user.id);
    expect(ui.renderedHome).toBe('Earth Globe View');
    expect(app.homeAddress).toBeNull();
    expect(ui.formOpen).toBe(false);

    app.dispose();
  });

  test('delete is refused when the editor namespace no longer matches', async () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.savePlace(PLACE_A);
    StorageService.setOwner(SESSION_B.user.id);
    StorageService.savePlace({ ...PLACE_A, id: 'place_bob', name: 'Bob place', notes: 'bob notes' });

    StorageService.setOwner(SESSION_A.user.id);
    const ui = createStubUi();
    const { app, auth } = await createBoundApp({ ui, session: SESSION_A });
    app.openLocationEditor(PLACE_A);
    ui.elements.formLocationId.value = PLACE_A.id;

    await auth.signIn({ session: SESSION_B });
    app.handleDeleteLocation();

    expect(ui.toasts.some((message) => /not deleted/i.test(message))).toBe(true);
    StorageService.setOwner(SESSION_A.user.id);
    expect(StorageService.getSavedPlaces().some((place) => place.notes === PLACE_A.notes)).toBe(true);
    StorageService.setOwner(SESSION_B.user.id);
    expect(StorageService.getSavedPlaces().some((place) => place.notes === 'bob notes')).toBe(true);

    app.dispose();
  });

  test('owner clear hides the previous weather immediately', async () => {
    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress(HOME_A);
    const ui = createStubUi();
    const { app, auth } = await createBoundApp({ ui, session: SESSION_A });

    await auth.signIn({ session: SESSION_B });
    expect(ui.weatherUpdates).toContain(null);

    app.dispose();
  });

  test('dispose clears the sun interval and JamBase fallback callback', async () => {
    const ui = createStubUi();
    const { app } = await createBoundApp({ ui, session: SESSION_A });
    app.sunAnimationTimer = setInterval(() => {}, 10000);
    JamBaseService.setApiFallbackCallback(() => {});
    expect(typeof JamBaseService._onApiFallback).toBe('function');

    app.dispose();
    expect(app.sunAnimationTimer).toBeNull();
    expect(JamBaseService._onApiFallback).toBeNull();
  });

  test('JamBase results from editor A do not populate editor B in the same account', async () => {
    let resolveSearch;
    const searchPromise = new Promise((resolve) => {
      resolveSearch = resolve;
    });
    JamBaseService.searchVenues = async () => searchPromise;

    StorageService.setOwner(SESSION_A.user.id);
    const ui = createStubUi();
    const { app } = await createBoundApp({ ui, session: SESSION_A });
    app.openLocationEditor({ name: 'Editor A', lat: 1, lng: 1 });
    ui.elements.formName.value = 'Editor A';
    const editorARevision = app.editorRevision;

    const searchDone = app.handleJambaseSearch();
    app.openLocationEditor({ name: 'Editor B', lat: 2, lng: 2 });
    ui.elements.formName.value = 'Editor B';
    ui.elements.formJambaseId.value = '';
    ui.elements.formCapacity.value = '';
    resolveSearch([{ id: 'venue-a', name: 'Venue A', city: 'SF', state: 'CA', capacity: 100 }]);
    await searchDone;

    expect({
      pickerOpens: ui.pickerOpens,
      currentEditor: ui.elements.formName.value,
      jambaseId: ui.elements.formJambaseId.value,
      capacity: ui.elements.formCapacity.value,
      editorGuardPassed: app.editorMatchesCurrentRequest(editorARevision),
    }).toEqual({
      pickerOpens: 0,
      currentEditor: 'Editor B',
      jambaseId: '',
      capacity: '',
      editorGuardPassed: false,
    });

    app.dispose();
  });

  test('JamBase selection from editor A does not mutate editor B after a same-account reopen', async () => {
    JamBaseService.searchVenues = async () => [{ id: 'venue-a', name: 'Venue A' }];
    let resolveDetails;
    JamBaseService.fetchVenueDetails = () => new Promise((resolve) => {
      resolveDetails = resolve;
    });

    StorageService.setOwner(SESSION_A.user.id);
    const ui = createStubUi();
    const { app } = await createBoundApp({ ui, session: SESSION_A });
    app.openLocationEditor({ name: 'Editor A', lat: 1, lng: 1 });
    ui.elements.formName.value = 'Editor A';
    await app.handleJambaseSearch();
    expect(ui.pickerOpens).toBe(1);
    expect(typeof ui.jambaseOnSelect).toBe('function');

    const selectPromise = ui.jambaseOnSelect({ id: 'venue-a', name: 'Venue A' });
    app.openLocationEditor({ name: 'Editor B', lat: 2, lng: 2 });
    ui.elements.formName.value = 'Editor B';
    ui.elements.formJambaseId.value = '';
    ui.elements.formCapacity.value = '';
    resolveDetails({ capacity: 100 });
    await selectPromise;

    expect(ui.elements.formName.value).toBe('Editor B');
    expect(ui.elements.formJambaseId.value).not.toBe('venue-a');
    expect(ui.elements.formCapacity.value).not.toBe('100');
    expect(ui.elements.formCapacity.value).not.toBe(100);

    app.dispose();
  });

  test('dispose rejects saves and unregisters bindEvents listeners', async () => {
    const ui = createStubUi();
    const handlers = [];
    const formValues = {
      reset: ui.elements.locationForm.reset,
      querySelector: () => null,
    };
    ui.elements.locationForm = {
      ...formValues,
      addEventListener(type, handler, options) {
        handlers.push({ type, handler, signal: options?.signal });
        options?.signal?.addEventListener('abort', () => {
          const index = handlers.findIndex((entry) => entry.handler === handler);
          if (index >= 0) handlers.splice(index, 1);
        });
      },
      dispatch(type, event) {
        for (const entry of [...handlers]) {
          if (entry.type === type) entry.handler(event);
        }
      },
    };

    const { app } = await createBoundApp({ ui, session: SESSION_A });
    app.openLocationEditor({
      id: PLACE_A.id,
      name: PLACE_A.name,
      notes: PLACE_A.notes,
      lat: PLACE_A.lat,
      lng: PLACE_A.lng,
    });
    app.bindEvents();
    expect(handlers.some((entry) => entry.type === 'submit')).toBe(true);

    let saveCalls = 0;
    const originalSave = StorageService.savePlace.bind(StorageService);
    StorageService.savePlace = (...args) => {
      saveCalls += 1;
      return originalSave(...args);
    };

    try {
      app.dispose();
      ui.elements.locationForm.dispatch('submit', { preventDefault() {} });
      app.handleSaveLocation();
      expect({ saveCallsAfterDispose: saveCalls }).toEqual({ saveCallsAfterDispose: 0 });
      expect(handlers.some((entry) => entry.type === 'submit')).toBe(false);
    } finally {
      StorageService.savePlace = originalSave;
    }
  });

  test('concurrent same-owner POI searches keep the newer result', async () => {
    const resolvers = [];
    OverpassService.fetchNearbyPois = () => new Promise((resolve) => {
      resolvers.push(resolve);
    });

    StorageService.setOwner(SESSION_A.user.id);
    StorageService.setHomeAddress(HOME_A);
    const ui = createStubUi();
    const { app } = await createBoundApp({ ui, session: SESSION_A });

    const first = app.handleDiscoverPois();
    const second = app.handleDiscoverPois();
    expect(resolvers.length).toBe(2);

    resolvers[1]([{ name: 'newer cafe', typeLabel: 'Cafe', category: 'favorite', address: '', notes: '', color: '#3b82f6', lat: 2, lng: 2 }]);
    await second;
    resolvers[0]([{ name: 'older cafe', typeLabel: 'Cafe', category: 'favorite', address: '', notes: '', color: '#3b82f6', lat: 1, lng: 1 }]);
    await first;

    expect(app.currentDiscoveredPois.map((poi) => poi.name)).toEqual(['newer cafe']);
    app.applyPoiFilter();
    expect(ui.renderedPois.map((poi) => poi.name)).toEqual(['newer cafe']);

    app.dispose();
  });

  test('concurrent same-owner address searches keep the newer marker', async () => {
    const resolvers = [];
    const mapboxService = createStubMapbox({
      geocode: () => new Promise((resolve) => {
        resolvers.push(resolve);
      }),
    });
    const ui = createStubUi();
    StorageService.setOwner(SESSION_A.user.id);
    const { app } = await createBoundApp({ ui, mapboxService, session: SESSION_A });

    ui.elements.addressSearchInput.value = 'one';
    const first = app.handleAddressSearch();
    ui.elements.addressSearchInput.value = 'two';
    const second = app.handleAddressSearch();
    expect(resolvers.length).toBe(2);

    resolvers[1]({ name: 'two', lat: 2, lng: 2 });
    await second;
    resolvers[0]({ name: 'one', lat: 1, lng: 1 });
    await first;

    expect(mapboxService.lastMarker).toEqual({ lat: 2, lng: 2 });
    expect(mapboxService.lastFly).toEqual({ lat: 2, lng: 2 });
    expect(mapboxService.markerOrder.at(-1)).toEqual({ lat: 2, lng: 2 });

    app.dispose();
  });

  test('concurrent same-owner map clicks keep the newer marker', async () => {
    const resolvers = [];
    const mapboxService = createStubMapbox({
      geocode: () => new Promise((resolve) => {
        resolvers.push(resolve);
      }),
    });
    const ui = createStubUi();
    StorageService.setOwner(SESSION_A.user.id);
    const { app } = await createBoundApp({ ui, mapboxService, session: SESSION_A });

    const first = app.onMapClicked({ lat: 1, lng: 1 });
    const second = app.onMapClicked({ lat: 2, lng: 2 });
    resolvers[1]({ name: 'two', lat: 2, lng: 2 });
    await second;
    resolvers[0]({ name: 'one', lat: 1, lng: 1 });
    await first;

    expect(mapboxService.lastMarker).toEqual({ lat: 2, lng: 2 });
    expect(ui.formOpen).toBe(true);

    app.dispose();
  });

  test('concurrent JamBase searches in one editor keep the newer results', async () => {
    const resolvers = [];
    JamBaseService.searchVenues = async () => new Promise((resolve) => {
      resolvers.push(resolve);
    });
    StorageService.setOwner(SESSION_A.user.id);
    const ui = createStubUi();
    const { app } = await createBoundApp({ ui, session: SESSION_A });
    app.openLocationEditor({ name: 'Venue', lat: 1, lng: 1 });
    ui.elements.formName.value = 'Venue';
    ui.jambaseRenders = [];
    const originalRender = ui.renderJambaseSearchResults.bind(ui);
    ui.renderJambaseSearchResults = (matches, onSelect) => {
      ui.jambaseRenders.push(matches.map((match) => match.id));
      originalRender(matches, onSelect);
    };

    const first = app.handleJambaseSearch();
    const second = app.handleJambaseSearch();
    resolvers[1]([{ id: 'newer' }]);
    await second;
    resolvers[0]([{ id: 'older' }]);
    await first;

    expect(ui.jambaseRenders.at(-1)).toEqual(['newer']);
    expect(ui.jambaseRenders).not.toEqual(expect.arrayContaining([['older']]));

    app.dispose();
  });

  test('dispose during auth.initialize does not reject init', async () => {
    let release;
    const client = new FakeAuthClient({ session: SESSION_A });
    const originalLoadSession = client.loadSession.bind(client);
    client.loadSession = () => new Promise((resolve) => {
      release = () => resolve(originalLoadSession());
    });
    const ui = createStubUi();
    const app = new NeighborhoodGuruApp({
      storage: StorageService,
      ui,
      mapboxService: createStubMapbox(),
      auth: createAuthState(client),
    });
    const initPromise = app.init();
    for (let i = 0; i < 10 && typeof release !== 'function'; i += 1) {
      await Promise.resolve();
    }
    expect(typeof release).toBe('function');
    app.dispose();
    release();
    await expect(initPromise).resolves.toBeUndefined();
  });

  test('teardown unregisters map load handlers and ignores late loads', async () => {
    const { MapboxService } = await import('../src/js/mapbox-service.js');
    const service = new MapboxService();
    const map = {
      handlers: [],
      on(type, fn) { this.handlers.push({ type, fn }); },
      off(type, fn) { this.handlers = this.handlers.filter((entry) => entry.fn !== fn); },
      remove() { this.removed = true; },
    };
    service.map = map;
    let renders = 0;
    service.bindMapEvent('load', () => { renders += 1; });
    expect(map.handlers.filter((entry) => entry.type === 'load')).toHaveLength(1);
    service.teardownMap();
    expect(service.tornDown).toBe(true);
    expect(map.removed).toBe(true);
    expect(map.handlers.filter((entry) => entry.type === 'load')).toHaveLength(0);
    map.handlers.forEach((entry) => entry.fn());
    expect(renders).toBe(0);
  });

  test('late map load renders the current owner home not a captured previous home', async () => {
    const mapboxgl = (await import('mapbox-gl')).default;
    const { MapboxService } = await import('../src/js/mapbox-service.js');
    const original = {
      Map: mapboxgl.Map,
      NavigationControl: mapboxgl.NavigationControl,
      ScaleControl: mapboxgl.ScaleControl,
    };
    const createdMaps = [];
    class DeferredMap {
      constructor() {
        this.handlers = [];
        createdMaps.push(this);
      }
      on(type, fn) { this.handlers.push({ type, fn }); }
      off(type, fn) { this.handlers = this.handlers.filter((entry) => entry.fn !== fn); }
      addControl() {}
      remove() { this.removed = true; }
      getSource() { return null; }
      addSource() {}
      addLayer() {}
      getLayer() { return null; }
      getStyle() { return { layers: [] }; }
      setFog() {}
      setTerrain() {}
      setLayoutProperty() {}
      loaded() { return false; }
      emit(type, event) {
        for (const entry of [...this.handlers]) {
          if (entry.type === type) entry.fn(event);
        }
      }
    }
    class FakeControl {}
    mapboxgl.Map = DeferredMap;
    mapboxgl.NavigationControl = FakeControl;
    mapboxgl.ScaleControl = FakeControl;

    try {
      const mapboxService = new MapboxService();
      const homes = [];
      mapboxService.renderHomeMarker = (home) => {
        homes.push(home?.name ?? null);
      };
      mapboxService.renderSavedMarkers = () => {};

      StorageService.setOwner(SESSION_A.user.id);
      StorageService.setHomeAddress({ name: 'Alice home', lat: 1, lng: 1 });
      const ui = createStubUi();
      const { app, auth } = await createBoundApp({ ui, mapboxService, session: SESSION_A });
      expect(app.homeAddress.name).toBe('Alice home');

      const map = mapboxService.initMap('map', {
        token: 'pk.test',
        homeAddress: app.homeAddress,
        onLoad: () => {
          if (app.disposed || mapboxService.tornDown) return;
          app.renderNeighborhoodView();
        },
      });
      expect(map).toBeTruthy();
      expect(createdMaps).toHaveLength(1);
      expect(map.handlers.some((entry) => entry.type === 'load')).toBe(true);

      await auth.signIn({ session: SESSION_B });
      await app.unsubscribeWorkingCopy.ready;
      expect(app.homeAddress).toBeNull();
      homes.length = 0;
      map.emit('load');
      expect(homes).toEqual([]);
      app.dispose();
    } finally {
      mapboxgl.Map = original.Map;
      mapboxgl.NavigationControl = original.NavigationControl;
      mapboxgl.ScaleControl = original.ScaleControl;
    }
  });

  test('older address search cannot replace a newer map-click marker', async () => {
    const resolvers = [];
    const mapboxService = createStubMapbox({
      geocode: () => new Promise((resolve) => {
        resolvers.push(resolve);
      }),
    });
    const ui = createStubUi();
    StorageService.setOwner(SESSION_A.user.id);
    const { app } = await createBoundApp({ ui, mapboxService, session: SESSION_A });
    ui.elements.addressSearchInput.value = 'older';
    const search = app.handleAddressSearch();
    const click = app.onMapClicked({ lat: 9, lng: 9 });
    resolvers[1]({ name: 'click', lat: 9, lng: 9 });
    await click;
    resolvers[0]({ name: 'older', lat: 1, lng: 1 });
    await search;
    expect(mapboxService.lastMarker).toEqual({ lat: 9, lng: 9 });
    app.dispose();
  });

  test('UIController.dispose removes listeners and clears timeouts', async () => {
    const ui = new UIController();
    let clicks = 0;
    let timed = 0;
    const target = {
      addEventListener(type, handler) {
        this.handler = handler;
      },
      removeEventListener() {
        this.removed = true;
      },
    };
    ui.listen(target, 'click', () => { clicks += 1; });
    ui.scheduleTimeout(() => { timed += 1; }, 20);
    ui.dispose();
    target.handler?.();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(clicks).toBe(0);
    expect(timed).toBe(0);
    expect(target.removed).toBe(true);
  });

  test('UIController.showToast is a no-op after dispose', () => {
    const ui = new UIController();
    const appended = [];
    ui.elements.toastContainer = {
      appendChild(node) { appended.push(node); },
    };
    ui.dispose();
    ui.showToast('late toast');
    expect(appended).toEqual([]);
  });

  test('waitUntilIdle follows A to B and does not fire stale ready callbacks', async () => {
    const locks = installHoldableWebLocks();
    try {
      StorageService.setOwner(SESSION_A.user.id, { migrate: false });
      const client = new FakeAuthClient({ session: SESSION_A });
      const auth = createAuthState(client);
      await auth.initialize();
      const readyOwners = [];
      locks.hold();
      const unsub = bindNeighborhoodWorkingCopy(auth, StorageService, {
        onOwnerReady: (ownerId) => { readyOwners.push(ownerId); },
      });
      expect(locks.pendingCount()).toBeGreaterThan(0);
      const stale = unsub.ready;
      await auth.signIn({ session: SESSION_B });
      expect(StorageService.getOwnerId()).toBe(SESSION_B.user.id);
      expect(locks.pendingCount()).toBeGreaterThan(0);
      locks.releaseAll();
      await stale;
      expect(StorageService.getOwnerId()).toBe(SESSION_B.user.id);
      await unsub.ready;
      expect(readyOwners.at(-1)).toBe(SESSION_B.user.id);
      expect(readyOwners.filter((id) => id === SESSION_A.user.id)).toHaveLength(0);
      unsub();
    } finally {
      globalThis.navigator = locks.previous;
    }
  });

  test('unsubscribe invalidates pending ready callbacks', async () => {
    const locks = installHoldableWebLocks();
    try {
      const client = new FakeAuthClient({ session: SESSION_A });
      const auth = createAuthState(client);
      await auth.initialize();
      const readyOwners = [];
      locks.hold();
      const unsub = bindNeighborhoodWorkingCopy(auth, StorageService, {
        onOwnerReady: (ownerId) => { readyOwners.push(ownerId); },
      });
      unsub();
      locks.releaseAll();
      await Promise.resolve();
      await Promise.resolve();
      expect(readyOwners).toEqual([]);
    } finally {
      globalThis.navigator = locks.previous;
    }
  });

  test('disposed UI does not run a previous-owner card callback', () => {
    const ui = new UIController();
    const ran = [];
    const list = {
      addEventListener(type, handler) { this.handler = handler; },
      removeEventListener() { this.removed = true; },
    };
    ui.elements.savedPlacesList = list;
    ui.bindDelegatedEvents();
    ui._placesById.set(PLACE_A.id, PLACE_A);
    ui._onEditClick = (place) => ran.push(place.name);
    ui._onPlaceClick = (place) => ran.push(`fly:${place.name}`);
    ui.dispose();
    const card = { dataset: { id: PLACE_A.id } };
    list.handler?.({
      stopPropagation() {},
      target: {
        closest(selector) {
          if (selector === '.card-refresh-jb-btn') return null;
          if (selector === 'a') return null;
          if (selector === '.edit-place-btn') return { closest: () => this };
          if (selector === '.fly-place-btn') return null;
          if (selector === '.place-card') return card;
          return null;
        },
      },
    });
    expect({
      disposed: ui.disposed,
      trackedListeners: ui.listeners.length,
      oldCardCallbackRan: ran,
    }).toEqual({
      disposed: true,
      trackedListeners: 0,
      oldCardCallbackRan: [],
    });
  });

  test('legacy recovery banner shows only unapplied leftover', () => {
    const ui = new UIController();
    const classes = new Set(['hidden']);
    const restoreClasses = new Set();
    ui.elements.legacyRecoveryBanner = {
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
      },
    };
    ui.elements.legacyRecoveryMessage = { textContent: '' };
    ui.elements.restoreLegacyBtn = {
      disabled: false,
      classList: {
        toggle(name, force) {
          if (force) restoreClasses.add(name);
          else restoreClasses.delete(name);
        },
      },
    };

    ui.updateLegacyRecoveryBanner({ leftoverPresent: true, leftoverUnapplied: false, locksAvailable: true });
    expect(classes.has('hidden')).toBe(true);

    ui.updateLegacyRecoveryBanner({ leftoverPresent: true, leftoverUnapplied: true, leftoverAdoptable: true, locksAvailable: false });
    expect(classes.has('hidden')).toBe(false);
    expect(ui.elements.legacyRecoveryMessage.textContent).toContain('cannot take a Web Lock');
    expect(ui.elements.restoreLegacyBtn.disabled).toBe(true);

    ui.updateLegacyRecoveryBanner({ leftoverPresent: true, leftoverUnapplied: true, leftoverAdoptable: false, locksAvailable: true });
    expect(classes.has('hidden')).toBe(false);
    expect(ui.elements.legacyRecoveryMessage.textContent).not.toContain('Restore it into this account');
    expect(ui.elements.legacyRecoveryMessage.textContent).toContain('cannot be restored into this account');
    expect(restoreClasses.has('hidden')).toBe(true);
  });

  test('disposed UI mutators do not write into mounted chrome', () => {
    const ui = new UIController();
    const weatherHidden = new Set();
    const settingsHidden = new Set(['hidden']);
    ui.elements.weatherHeaderPill = {
      classList: {
        add(name) { weatherHidden.add(name); },
        remove(name) { weatherHidden.delete(name); },
      },
      weatherIcon: true,
    };
    ui.elements.weatherIcon = { textContent: '' };
    ui.elements.weatherTemp = { textContent: '' };
    ui.elements.weatherDesc = { textContent: '' };
    ui.elements.settingsModal = {
      classList: {
        add(name) { settingsHidden.add(name); },
        remove(name) { settingsHidden.delete(name); },
      },
    };
    ui.elements.settingsMapboxToken = { value: '' };
    ui.elements.settingsJambaseToken = { value: '' };
    ui.elements.peopleListContainer = { innerHTML: 'keep' };
    ui.dispose();
    ui.updateWeatherDisplay({ icon: '☀️', temp: 70, desc: 'Fair' });
    ui.openSettingsModal('pk.test', 'jb.test');
    ui.renderPeopleFields(['Ada']);
    expect(ui.elements.weatherIcon.textContent).toBe('');
    expect(settingsHidden.has('hidden')).toBe(true);
    expect(ui.elements.peopleListContainer.innerHTML).toBe('');
  });

  test('reopening a Mapbox popup does not stack edit handlers', async () => {
    const mapboxgl = (await import('mapbox-gl')).default;
    const { MapboxService } = await import('../src/js/mapbox-service.js');
    const original = { Popup: mapboxgl.Popup, Marker: mapboxgl.Marker };
    const popups = [];
    mapboxgl.Popup = class FakePopup {
      constructor() {
        this.listeners = [];
        this.editBtn = { onclick: null };
        this.refreshBtn = { onclick: null };
        this.addBtn = { onclick: null };
        this.showsBody = { innerHTML: '', dataset: {} };
        popups.push(this);
      }
      setHTML() { return this; }
      on(type, fn) { this.listeners.push({ type, fn }); return this; }
      getElement() {
        return {
          querySelector: (sel) => {
            const value = String(sel);
            if (value.includes('popup-edit-btn')) return this.editBtn;
            if (value.includes('popup-refresh-jb-btn')) return this.refreshBtn;
            if (value.includes('temp-add-btn')) return this.addBtn;
            if (value.includes('jb-popup-shows-body')) return this.showsBody;
            return null;
          },
        };
      }
      remove() {}
      emitOpen() {
        this.listeners.filter((entry) => entry.type === 'open').forEach((entry) => entry.fn());
      }
    };
    mapboxgl.Marker = class FakeMarker {
      setLngLat() { return this; }
      setPopup() { return this; }
      addTo() { return this; }
      remove() {}
    };
    const previousDocument = globalThis.document;
    globalThis.document = {
      createElement() {
        return {
          className: '',
          style: {},
          innerHTML: '',
          title: '',
          addEventListener() {},
        };
      },
    };
    const originalFetchShows = JamBaseService.fetchUpcomingShows;
    JamBaseService.fetchUpcomingShows = async () => [];
    try {
      const service = new MapboxService();
      service.tornDown = false;
      service.map = { loaded: true };
      const editClicks = [];
      const addClicks = [];
      const refreshCalls = [];
      JamBaseService.fetchUpcomingShows = async (_id, force) => {
        refreshCalls.push(Boolean(force));
        return [];
      };
      service.renderSavedMarkers([{
        ...PLACE_A,
        jambaseId: 'venue-1',
      }], (place) => {
        editClicks.push(place.id);
      });
      const savedPopup = popups[0];
      savedPopup.emitOpen();
      savedPopup.emitOpen();
      savedPopup.editBtn.onclick();
      savedPopup.refreshBtn.onclick({ stopPropagation() {} });
      expect({
        editCallsAfterOneClick: editClicks.length,
        refreshCallsAfterOneClick: refreshCalls.filter((force) => force).length,
      }).toEqual({
        editCallsAfterOneClick: 1,
        refreshCallsAfterOneClick: 1,
      });

      service.showTempMarker({ lat: 1, lng: 2 }, (coords) => {
        addClicks.push(`${coords.lat},${coords.lng}`);
      });
      const tempPopup = popups[1];
      tempPopup.emitOpen();
      tempPopup.emitOpen();
      tempPopup.addBtn.onclick();
      expect(addClicks).toEqual(['1,2']);
      service.teardownMap?.();
    } finally {
      mapboxgl.Popup = original.Popup;
      mapboxgl.Marker = original.Marker;
      globalThis.document = previousDocument;
      JamBaseService.fetchUpcomingShows = originalFetchShows;
    }
  });

  test('older popup JamBase responses do not overwrite a newer open', async () => {
    const mapboxgl = (await import('mapbox-gl')).default;
    const { MapboxService } = await import('../src/js/mapbox-service.js');
    const original = { Popup: mapboxgl.Popup, Marker: mapboxgl.Marker };
    const popups = [];
    mapboxgl.Popup = class FakePopup {
      constructor() {
        this.listeners = [];
        this.editBtn = { onclick: null };
        this.refreshBtn = { onclick: null };
        this.showsBody = { innerHTML: '', dataset: {} };
        popups.push(this);
      }
      setHTML() { return this; }
      on(type, fn) { this.listeners.push({ type, fn }); return this; }
      getElement() {
        return {
          querySelector: (sel) => {
            const value = String(sel);
            if (value.includes('popup-edit-btn')) return this.editBtn;
            if (value.includes('popup-refresh-jb-btn')) return this.refreshBtn;
            if (value.includes('jb-popup-shows-body')) return this.showsBody;
            return null;
          },
        };
      }
      remove() {}
      emitOpen() {
        this.listeners.filter((entry) => entry.type === 'open').forEach((entry) => entry.fn());
      }
    };
    mapboxgl.Marker = class FakeMarker {
      setLngLat() { return this; }
      setPopup() { return this; }
      addTo() { return this; }
      remove() {}
    };
    const previousDocument = globalThis.document;
    globalThis.document = { createElement() { return { className: '', style: {}, innerHTML: '', title: '', addEventListener() {} }; } };
    const originalFetchShows = JamBaseService.fetchUpcomingShows;
    const deferred = [];
    JamBaseService.fetchUpcomingShows = () => new Promise((resolve) => { deferred.push(resolve); });
    try {
      const service = new MapboxService();
      service.tornDown = false;
      service.map = { loaded: true };
      service.renderSavedMarkers([{ ...PLACE_A, jambaseId: 'venue-1' }]);
      const popup = popups[0];
      popup.emitOpen();
      popup.emitOpen();
      expect(deferred).toHaveLength(2);
      deferred[1]([{ title: 'NEW', date: 'Fri', isToday: false, url: 'https://example.test/new' }]);
      await Promise.resolve();
      deferred[0]([{ title: 'OLD', date: 'Thu', isToday: false, url: 'https://example.test/old' }]);
      await Promise.resolve();
      expect(popup.showsBody.innerHTML).toContain('NEW');
      expect(popup.showsBody.innerHTML).not.toContain('OLD');
      service.teardownMap?.();
    } finally {
      mapboxgl.Popup = original.Popup;
      mapboxgl.Marker = original.Marker;
      globalThis.document = previousDocument;
      JamBaseService.fetchUpcomingShows = originalFetchShows;
    }
  });

  test('older sidebar JamBase load does not overwrite a newer refresh', async () => {
    const ui = new UIController();
    const deferred = [];
    const originalFetchShows = JamBaseService.fetchUpcomingShows;
    JamBaseService.fetchUpcomingShows = () => new Promise((resolve) => { deferred.push(resolve); });
    const listEl = { innerHTML: '', dataset: {}, isConnected: true };
    const box = {
      dataset: { jambaseId: 'venue-1' },
      querySelector(selector) {
        return String(selector).includes('jb-card-shows-list') ? listEl : this;
      },
      closest() { return this; },
    };
    const list = {
      innerHTML: '',
      handler: null,
      addEventListener(_type, handler) { this.handler = handler; },
      removeEventListener() {},
      appendChild() {},
      querySelectorAll() { return [box]; },
    };
    ui.elements.savedPlacesList = list;
    ui.elements.placesCountBadge = { textContent: '' };
    ui.bindDelegatedEvents();
    const previousDocument = globalThis.document;
    globalThis.document = {
      createElement() {
        return { className: '', dataset: {}, style: {}, innerHTML: '' };
      },
    };
    try {
      ui.renderPlacesList([{ ...PLACE_A, jambaseId: 'venue-1' }]);
      expect(deferred).toHaveLength(1);
      list.handler?.({
        stopPropagation() {},
        target: {
          closest(selector) {
            if (selector === '.card-refresh-jb-btn') return { closest: () => box };
            return null;
          },
        },
      });
      expect(deferred).toHaveLength(2);
      deferred[1]([{ title: 'NEW', date: 'Fri', isToday: false, url: 'https://example.test/new' }]);
      await Promise.resolve();
      deferred[0]([{ title: 'OLD', date: 'Thu', isToday: false, url: 'https://example.test/old' }]);
      await Promise.resolve();
      expect(listEl.innerHTML).toContain('NEW');
      expect(listEl.innerHTML).not.toContain('OLD');
    } finally {
      globalThis.document = previousDocument;
      JamBaseService.fetchUpcomingShows = originalFetchShows;
    }
  });

  test('duplicate place cards keep distinct delegated edit targets', () => {
    const ui = new UIController();
    const opened = [];
    const cards = [];
    const list = {
      innerHTML: '',
      handler: null,
      addEventListener(type, handler) { this.handler = handler; },
      removeEventListener() {},
      appendChild(node) { cards.push(node); },
      querySelectorAll() { return []; },
    };
    ui.elements.savedPlacesList = list;
    ui.elements.placesCountBadge = { textContent: '' };
    ui.bindDelegatedEvents();
    const previous = globalThis.document;
    globalThis.document = {
      createElement() {
        return {
          className: '',
          dataset: {},
          style: {},
          innerHTML: '',
        };
      },
    };
    try {
      ui.renderPlacesList([
        { ...PLACE_A, id: 'dup', name: 'First' },
        { ...PLACE_A, id: 'dup', name: 'Second' },
      ], null, (place) => opened.push(place.name));
      expect(cards).toHaveLength(2);
      expect(ui._placesByToken.size).toBe(2);
      const firstCard = cards[0];
      const click = {
        stopPropagation() {},
        target: {
          closest(selector) {
            if (selector === '.card-refresh-jb-btn') return null;
            if (selector === 'a') return null;
            if (selector === '.edit-place-btn') return { closest: () => this };
            if (selector === '.fly-place-btn') return null;
            if (selector === '.place-card') return firstCard;
            return null;
          },
        },
      };
      list.handler?.(click);
      expect(opened).toEqual(['First']);
    } finally {
      globalThis.document = previous;
    }
  });

  test('stale leftover restore does not refresh the replacement owner', async () => {
    const locks = installHoldableWebLocks();
    try {
      const ui = createStubUi();
      StorageService.setOwner(SESSION_A.user.id, { migrate: false });
      const { app, auth } = await createBoundApp({ ui, session: SESSION_A });
      app.syncNeighborhoodViewFromStorage();
      let syncs = 0;
      const originalSync = app.syncNeighborhoodViewFromStorage.bind(app);
      app.syncNeighborhoodViewFromStorage = (...args) => {
        syncs += 1;
        return originalSync(...args);
      };
      locks.hold();
      const restore = app.handleRestoreLegacyLeftover();
      await auth.signIn({ session: SESSION_B });
      expect(app.storage.getOwnerId()).toBe(SESSION_B.user.id);
      const syncsAfterSwitch = syncs;
      locks.releaseAll();
      await restore;
      await app.unsubscribeWorkingCopy.ready;
      expect(app.storage.getOwnerId()).toBe(SESSION_B.user.id);
      expect(syncs).toBe(syncsAfterSwitch + 1);
      expect(ui.toasts.some((message) => String(message).includes('Leftover data is still on this device'))).toBe(false);
    } finally {
      globalThis.navigator = locks.previous;
    }
  });

  test('owner-bound orphan banner exposes merge and replace actions', () => {
    const ui = new UIController();
    const classes = new Set(['hidden']);
    ui.elements.legacyRecoveryBanner = {
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
      },
    };
    ui.elements.legacyRecoveryMessage = { textContent: '' };
    ui.elements.restoreLegacyBtn = { disabled: false, classList: { toggle() {} } };
    ui.elements.exportDeviceRecoveryBtn = { classList: { hidden: false, toggle(name, force) { this.hidden = force; } } };
    ui.elements.legacyOwnerOrphanList = { innerHTML: '' };
    ui.updateLegacyRecoveryBanner({
      leftoverUnapplied: false,
      leftoverAdoptable: false,
      locksAvailable: true,
      ownerOrphans: [{ key: 'neighborhood_guru:orphaned:home_address', preview: { homeName: 'Alice orphan' } }],
      deviceOrphans: [],
      ambiguousLeftovers: [],
    });
    expect(classes.has('hidden')).toBe(false);
    expect(ui.elements.legacyOwnerOrphanList.innerHTML).toContain('Alice orphan');
    expect(ui.elements.legacyOwnerOrphanList.innerHTML).toContain('data-orphan-action="merge"');
    expect(ui.elements.exportDeviceRecoveryBtn.classList.hidden).toBe(true);
  });

  test('lock-unavailable import is not reported as invalid format', async () => {
    const ui = createStubUi();
    let changeHandler = null;
    ui.elements.importFileInput = {
      addEventListener(type, handler) {
        if (type === 'change') changeHandler = handler;
      },
      removeEventListener() {},
    };
    const originalFileReader = globalThis.FileReader;
    globalThis.FileReader = class FakeFileReader {
      readAsText() {
        queueMicrotask(() => {
          this.onload?.({
            target: {
              result: JSON.stringify({
                version: 1,
                homeAddress: { name: 'Valid backup', lat: 1, lng: 1 },
              }),
            },
          });
        });
      }
    };
    try {
      const { app } = await createBoundApp({ ui, session: SESSION_A });
      app.storage.importDataJSON = async () => ({ ok: false, reason: 'lock-unavailable' });
      app.bindEvents();
      expect(changeHandler).toBeTypeOf('function');
      changeHandler({ target: { files: [{ name: 'backup.json' }] } });
      await Promise.resolve();
      await Promise.resolve();
      expect(ui.toasts.some((message) => String(message).includes('Invalid format'))).toBe(false);
      expect(ui.toasts.some((message) => String(message).toLowerCase().includes('lock'))).toBe(true);
    } finally {
      globalThis.FileReader = originalFileReader;
    }
  });

  test('rejected leftover restore shows an actionable toast and keeps recovery visible', async () => {
    const previous = globalThis.navigator;
    globalThis.navigator = {
      ...(previous || {}),
      locks: {
        request() {
          return Promise.reject(new Error('lock denied'));
        },
      },
    };
    const ui = createStubUi();
    try {
      localStorage.setItem('neighborhood_guru_home_address', JSON.stringify(HOME_A));
      const { app } = await createBoundApp({ ui, session: SESSION_A });
      const before = app.storage.legacyMigrationStatus();
      expect(before.locksAvailable).toBe(true);
      expect(before.leftoverAdoptable).toBe(true);
      await app.handleRestoreLegacyLeftover();
      const after = app.storage.legacyMigrationStatus();
      expect(after.leftoverAdoptable).toBe(true);
      expect(after.leftoverUnapplied).toBe(true);
      expect(ui.toasts.some((message) => String(message).toLowerCase().includes('lock'))).toBe(true);
    } finally {
      globalThis.navigator = previous;
    }
  });
});
