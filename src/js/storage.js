/* ==========================================================================
   STORAGE SERVICE - LOCALSTORAGE MANAGEMENT & PERSISTENCE
   ========================================================================== */

export const ANONYMOUS_OWNER_ID = 'anonymous';

export const DEVICE_STORAGE_KEYS = Object.freeze({
  MAPBOX_TOKEN: 'neighborhood_guru_mapbox_token',
  JAMBASE_TOKEN: 'neighborhood_guru_jambase_token',
  MAP_STYLE: 'neighborhood_guru_map_style',
});

export const WORKING_COPY_KEYS = Object.freeze({
  HOME_ADDRESS: 'home_address',
  SAVED_PLACES: 'saved_places',
  SYNC_CONSENT: 'sync_consent',
  DIRTY: 'dirty',
  LAST_ETAG: 'last_etag',
});

export const LEGACY_WORKING_COPY_KEYS = Object.freeze({
  [WORKING_COPY_KEYS.HOME_ADDRESS]: 'neighborhood_guru_home_address',
  [WORKING_COPY_KEYS.SAVED_PLACES]: 'neighborhood_guru_saved_places',
});

// Default Sample Neighborhood Data if storage is empty
const DEMO_PLACES = [
  {
    id: 'demo-1',
    source: 'demo',
    name: 'Oak Street Bakery & Cafe',
    category: 'favorite',
    people: ['Chef Elena'],
    contacts: [
      { type: 'phone_work', label: 'Order Line', value: '(555) 345-6789' },
      { type: 'email_work', label: 'Catering Email', value: 'hello@oakstreetbakery.com' }
    ],
    events: [
      { title: "Farmer's Market & Fresh Bread", day: 'friday', time: '8:00 AM - 1:00 PM' }
    ],
    address: '102 Oak Street',
    notes: 'Best sourdough and espresso in the neighborhood. Closed Mondays.',
    color: '#f59e0b',
    lat: 37.7749,
    lng: -122.4194,
    createdAt: Date.now() - 86400000 * 5,
  },
  {
    id: 'demo-2',
    source: 'demo',
    name: 'The Millers (Neighbors)',
    category: 'neighbor',
    people: ['Bob Miller', 'Karen Miller'],
    contacts: [
      { type: 'phone_mobile', label: 'Bob Cell', value: '(555) 987-6543' },
      { type: 'phone_home', label: 'House Landline', value: '(555) 987-1122' },
      { type: 'email_personal', label: 'Karen Email', value: 'millers742@gmail.com' }
    ],
    events: [
      { title: 'Trash & Recycling Pickup', day: 'tuesday', time: '7:00 AM' }
    ],
    address: '742 Evergreen Terrace',
    notes: 'Friendly neighbors. Have spare house key & key to water shutoff.',
    color: '#10b981',
    lat: 37.7765,
    lng: -122.4170,
    createdAt: Date.now() - 86400000 * 2,
  }
];

const DAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function normalizeOwnerId(ownerId) {
  if (ownerId == null) return ANONYMOUS_OWNER_ID;
  if (typeof ownerId !== 'string') {
    throw new TypeError('Owner id must be a string or null');
  }
  const trimmed = ownerId.trim();
  return trimmed.length === 0 ? ANONYMOUS_OWNER_ID : trimmed;
}

export function workingCopyKey(ownerId, suffix) {
  return `neighborhood_guru:${normalizeOwnerId(ownerId)}:${suffix}`;
}

export function isDemoPlace(place) {
  if (!place || typeof place !== 'object') return false;
  if (place.source === 'demo') return true;
  const id = String(place.id || '');
  return id === 'demo-1' || id === 'demo-2';
}

export function isUserAuthoredWorkingCopy({ homeAddress = null, savedPlaces = [] } = {}) {
  if (homeAddress) return true;
  return (Array.isArray(savedPlaces) ? savedPlaces : []).some((place) => !isDemoPlace(place));
}

export function isEventHappeningToday(event) {
  if (!event || !event.day) return false;
  const today = new Date();
  const currentDayNum = today.getDay(); // 0 = Sun, 1 = Mon, ..., 5 = Fri, 6 = Sat
  
  const targetDay = String(event.day).toLowerCase();
  
  if (targetDay === 'daily') return true;
  if (targetDay === 'weekdays' && currentDayNum >= 1 && currentDayNum <= 5) return true;
  if (targetDay === 'weekends' && (currentDayNum === 0 || currentDayNum === 6)) return true;
  
  if (DAY_MAP[targetDay] !== undefined && DAY_MAP[targetDay] === currentDayNum) {
    return true;
  }
  
  return false;
}

export function getPlaceEvents(place) {
  if (place && Array.isArray(place.events)) {
    return place.events.map(e => ({
      title: e.title || '',
      day: e.day || 'friday',
      time: e.time || '',
    }));
  }
  return [];
}

export function getPlacePeople(place) {
  if (place && Array.isArray(place.people)) {
    return place.people.filter(p => p && typeof p === 'string' && p.trim() !== '');
  }
  return [];
}

export function getPlaceContacts(place) {
  if (place && Array.isArray(place.contacts)) {
    return place.contacts.map(c => ({
      type: c.type || 'phone_mobile',
      label: c.label || '',
      value: c.value || '',
    }));
  }
  return [];
}

function isModernPlace(place) {
  return (
    place &&
    typeof place === 'object' &&
    Array.isArray(place.people) &&
    Array.isArray(place.contacts) &&
    !('contactName' in place) &&
    !('phone' in place) &&
    !('email' in place)
  );
}

function clonePlaces(places) {
  return JSON.parse(JSON.stringify(places));
}

function readItem(key) {
  return localStorage.getItem(key);
}

function writeItem(key, value) {
  localStorage.setItem(key, value);
}

function removeItem(key) {
  localStorage.removeItem(key);
}

/**
 * Move unprefixed working-copy keys into the active namespace once.
 * Local only — never an upload. Does not overwrite namespaced keys that
 * already exist. Target is the current owner (anonymous, or the restored
 * session's user.id when that is the sole identity using the old keys).
 *
 * Invoked from setOwner and from every working-copy read/write so a getter
 * cannot seed demos into an empty namespaced key before migration runs.
 */
function migrateLegacyWorkingCopy(ownerId) {
  const owner = normalizeOwnerId(ownerId);
  for (const [suffix, legacyKey] of Object.entries(LEGACY_WORKING_COPY_KEYS)) {
    const legacy = readItem(legacyKey);
    if (legacy == null) continue;
    const dest = workingCopyKey(owner, suffix);
    if (readItem(dest) == null) {
      writeItem(dest, legacy);
    }
    removeItem(legacyKey);
  }
}

function readWorkingCopy(ownerId, suffix) {
  migrateLegacyWorkingCopy(ownerId);
  return readItem(workingCopyKey(ownerId, suffix));
}

function writeWorkingCopy(ownerId, suffix, value) {
  migrateLegacyWorkingCopy(ownerId);
  writeItem(workingCopyKey(ownerId, suffix), value);
}

function removeWorkingCopy(ownerId, suffix) {
  migrateLegacyWorkingCopy(ownerId);
  removeItem(workingCopyKey(ownerId, suffix));
}

export const StorageService = {
  _ownerId: ANONYMOUS_OWNER_ID,

  getOwnerId() {
    return this._ownerId;
  },

  /**
   * Switch the working copy. Does not copy values between namespaces.
   * `null` selects the anonymous namespace.
   */
  setOwner(ownerId) {
    this._ownerId = normalizeOwnerId(ownerId);
    migrateLegacyWorkingCopy(this._ownerId);
    return this._ownerId;
  },

  workingCopyKey(suffix) {
    return workingCopyKey(this._ownerId, suffix);
  },

  /**
   * Mapbox Access Token (device-level — not namespaced)
   */
  getMapboxToken() {
    return readItem(DEVICE_STORAGE_KEYS.MAPBOX_TOKEN) || import.meta.env.VITE_MAPBOX_TOKEN || '';
  },

  setMapboxToken(token) {
    writeItem(DEVICE_STORAGE_KEYS.MAPBOX_TOKEN, token.trim());
  },

  /**
   * JamBase API Key / Token (device-level — not namespaced)
   */
  getJambaseToken() {
    return readItem(DEVICE_STORAGE_KEYS.JAMBASE_TOKEN) || import.meta.env.VITE_JAMBASE_TOKEN || '';
  },

  setJambaseToken(token) {
    writeItem(DEVICE_STORAGE_KEYS.JAMBASE_TOKEN, token.trim());
  },

  /**
   * Home Address Object { name, lat, lng, formattedAddress }
   */
  getHomeAddress() {
    const raw = readWorkingCopy(this._ownerId, WORKING_COPY_KEYS.HOME_ADDRESS);
    return raw ? JSON.parse(raw) : null;
  },

  setHomeAddress(addressObj) {
    writeWorkingCopy(this._ownerId, WORKING_COPY_KEYS.HOME_ADDRESS, JSON.stringify(addressObj));
  },

  clearHomeAddress() {
    removeWorkingCopy(this._ownerId, WORKING_COPY_KEYS.HOME_ADDRESS);
  },

  /**
   * Saved Places Array
   */
  getSavedPlaces() {
    const raw = readWorkingCopy(this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES);
    if (!raw) {
      const seeded = clonePlaces(DEMO_PLACES);
      writeWorkingCopy(this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(seeded));
      return seeded;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return clonePlaces(DEMO_PLACES);
      
      const validModern = parsed.filter(isModernPlace);
      
      // Purge any legacy items from localStorage
      if (validModern.length !== parsed.length) {
        const finalPlaces = validModern.length > 0 ? validModern : clonePlaces(DEMO_PLACES);
        writeWorkingCopy(this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(finalPlaces));
        return finalPlaces;
      }
      return validModern;
    } catch (e) {
      return clonePlaces(DEMO_PLACES);
    }
  },

  savePlace(place) {
    const places = this.getSavedPlaces();
    const targetId = place.id && String(place.id).trim() !== '' ? String(place.id) : null;
    const existingIndex = targetId ? places.findIndex(p => String(p.id) === targetId) : -1;

    if (existingIndex >= 0) {
      places[existingIndex] = { ...places[existingIndex], ...place, id: targetId, updatedAt: Date.now() };
    } else {
      const newId = `place_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      places.push({
        ...place,
        id: newId,
        createdAt: Date.now(),
      });
    }

    writeWorkingCopy(this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(places));
    return places;
  },

  deletePlace(id) {
    const places = this.getSavedPlaces().filter(p => p.id !== id);
    writeWorkingCopy(this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(places));
    return places;
  },

  /**
   * Per-namespace sync metadata. Login / session restore must not read or
   * write a remote NeighborhoodStore; these keys stay local.
   */
  getSyncConsent() {
    const raw = readWorkingCopy(this._ownerId, WORKING_COPY_KEYS.SYNC_CONSENT);
    if (raw == null) return false;
    try {
      return JSON.parse(raw) === true;
    } catch {
      return raw === 'true';
    }
  },

  setSyncConsent(enabled) {
    writeWorkingCopy(this._ownerId, WORKING_COPY_KEYS.SYNC_CONSENT, JSON.stringify(Boolean(enabled)));
  },

  isDirty() {
    const raw = readWorkingCopy(this._ownerId, WORKING_COPY_KEYS.DIRTY);
    return raw === '1' || raw === 'true';
  },

  setDirty(dirty) {
    writeWorkingCopy(this._ownerId, WORKING_COPY_KEYS.DIRTY, dirty ? '1' : '0');
  },

  getLastEtag() {
    return readWorkingCopy(this._ownerId, WORKING_COPY_KEYS.LAST_ETAG);
  },

  setLastEtag(etag) {
    if (etag == null || etag === '') {
      removeWorkingCopy(this._ownerId, WORKING_COPY_KEYS.LAST_ETAG);
      return;
    }
    writeWorkingCopy(this._ownerId, WORKING_COPY_KEYS.LAST_ETAG, String(etag));
  },

  /**
   * Map Style Preference (device-level — not namespaced)
   */
  getPreferredStyle() {
    return readItem(DEVICE_STORAGE_KEYS.MAP_STYLE) || 'streets';
  },

  setPreferredStyle(styleName) {
    writeItem(DEVICE_STORAGE_KEYS.MAP_STYLE, styleName);
  },

  /**
   * Backup Export & Import — current namespace only
   */
  exportDataJSON() {
    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      homeAddress: this.getHomeAddress(),
      savedPlaces: this.getSavedPlaces(),
    };
    return JSON.stringify(backup, null, 2);
  },

  importDataJSON(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      if (data.homeAddress) this.setHomeAddress(data.homeAddress);
      if (Array.isArray(data.savedPlaces)) {
        writeWorkingCopy(this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(data.savedPlaces));
      }
      return true;
    } catch (e) {
      console.error('Failed to parse import JSON', e);
      return false;
    }
  }
};
