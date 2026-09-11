import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { FakeAuthClient, createAuthState } from '../src/js/auth/index.js';
import { JamBaseService } from '../src/js/jambase-service.js';
import { OverpassService } from '../src/js/overpass-service.js';
import { bindNeighborhoodWorkingCopy } from '../src/js/neighborhood-working-copy.js';
import { NeighborhoodGuruApp } from '../src/main.js';
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
        app.syncNeighborhoodViewFromStorage({ ownerChanged: true });
      }
    },
  });
  app.viewReady = true;
  app.syncNeighborhoodViewFromStorage();
  return { app, auth, client };
}

describe('owner-switch presentation isolation', () => {
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
          app.syncNeighborhoodViewFromStorage({ ownerChanged: true });
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
});
