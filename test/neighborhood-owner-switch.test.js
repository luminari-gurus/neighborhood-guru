import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { FakeAuthClient, createAuthState } from '../src/js/auth/index.js';
import { bindNeighborhoodWorkingCopy } from '../src/js/neighborhood-working-copy.js';
import { NeighborhoodGuruApp } from '../src/main.js';
import {
  StorageService,
  WORKING_COPY_KEYS,
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
  };
  const elements = {
    formLocationId: { get value() { return values.formLocationId; }, set value(v) { values.formLocationId = v; } },
    formName: { get value() { return values.formName; }, set value(v) { values.formName = v; } },
    formNotes: { get value() { return values.formNotes; }, set value(v) { values.formNotes = v; } },
    formLat: { get value() { return values.formLat; }, set value(v) { values.formLat = v; } },
    formLng: { get value() { return values.formLng; }, set value(v) { values.formLng = v; } },
    formCategory: { get value() { return values.formCategory; }, set value(v) { values.formCategory = v; } },
    formAddress: { get value() { return values.formAddress; }, set value(v) { values.formAddress = v; } },
    formCapacity: { value: '' },
    formJambaseId: { value: '' },
    locationForm: {
      reset() {
        values.formLocationId = '';
        values.formName = '';
        values.formNotes = '';
        values.formLat = '';
        values.formLng = '';
        values.formAddress = '';
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
    formOpen: true,
    toasts: [],
    weatherUpdates: [],
    resetOwnerScopedPresentation() {
      this.formOpen = false;
      elements.locationForm.reset();
    },
    openLocationModal() { this.formOpen = true; },
    closeLocationModal() { this.formOpen = false; },
    closePoiModal() {},
    closeJambasePickerModal() {},
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
    clearTempMarker() { this.currentTempCoords = null; },
    renderSavedMarkers() {},
    renderHomeMarker() {},
    showTempMarker() {},
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
    StorageService.setOwner(null);
    globalThis.localStorage = originalLocalStorage;
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
});
