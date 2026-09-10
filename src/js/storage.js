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

/** Reserved, non-adoptable keys for divergent leftovers that must not follow a later account. */
export const ORPHANED_WORKING_COPY_PREFIX = 'neighborhood_guru:orphaned:';

export function orphanedWorkingCopyKey(suffix, token = '') {
  return token
    ? `${ORPHANED_WORKING_COPY_PREFIX}${suffix}:${token}`
    : `${ORPHANED_WORKING_COPY_PREFIX}${suffix}`;
}

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
  if (ownerId.trim().length === 0) return ANONYMOUS_OWNER_ID;
  return ownerId;
}

/**
 * Namespaced localStorage key for a logical owner.
 * `null` / blank / the canonical unsigned-in token use the anonymous tag.
 * Any authenticated user.id, including the string "anonymous", uses a distinct
 * `user:` tag and encodeURIComponent so AuthClient ids stay injective.
 */
export function workingCopyKey(ownerId, suffix) {
  if (ownerId == null || ownerId === ANONYMOUS_OWNER_ID || (typeof ownerId === 'string' && ownerId.trim().length === 0)) {
    return `neighborhood_guru:${ANONYMOUS_OWNER_ID}:${suffix}`;
  }
  if (typeof ownerId !== 'string') {
    throw new TypeError('Owner id must be a string or null');
  }
  return `neighborhood_guru:user:${encodeURIComponent(ownerId)}:${suffix}`;
}

export function authenticatedWorkingCopyKey(userId, suffix) {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new TypeError('Authenticated owner id must be a non-empty string');
  }
  return `neighborhood_guru:user:${encodeURIComponent(userId)}:${suffix}`;
}

export function isDemoSeedId(id) {
  const value = String(id || '');
  return value === 'demo-1' || value === 'demo-2';
}

export function isDemoPlace(place) {
  if (!place || typeof place !== 'object') return false;
  if (place.source === 'demo') return true;
  return isDemoSeedId(place.id);
}

const DEMO_COMPARE_OMIT = new Set(['id', 'source', 'createdAt', 'updatedAt']);

function demoContentSnapshot(place) {
  const snapshot = {};
  for (const key of Object.keys(place).sort()) {
    if (DEMO_COMPARE_OMIT.has(key)) continue;
    snapshot[key] = place[key];
  }
  return JSON.stringify(snapshot);
}

export function isUntouchedDemoSeed(place) {
  if (!isDemoPlace(place)) return false;
  const seed = DEMO_PLACES.find((candidate) => candidate.id === place.id);
  if (!seed) return false;
  return demoContentSnapshot(place) === demoContentSnapshot(seed);
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

function mintPlaceId() {
  return `place_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function parseJsonOr(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function storageValuesEquivalent(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(JSON.parse(left)) === JSON.stringify(JSON.parse(right));
  } catch {
    return false;
  }
}

function namespaceKey(anonymous, ownerId, suffix) {
  return anonymous ? workingCopyKey(null, suffix) : authenticatedWorkingCopyKey(ownerId, suffix);
}

function matchesCopiedValue(value, copied) {
  return value === copied || storageValuesEquivalent(value, copied);
}

/**
 * Move a leftover off the adoptable unprefixed key so a later empty account
 * cannot inherit it. Orphaned keys are never read by migrate/load.
 */
function quarantineLegacyValue(suffix, value) {
  const primary = orphanedWorkingCopyKey(suffix);
  const existing = readItem(primary);
  if (existing == null) {
    writeItem(primary, value);
    return readItem(primary) === value;
  }
  if (matchesCopiedValue(existing, value)) {
    return true;
  }
  const overflow = orphanedWorkingCopyKey(
    suffix,
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  );
  writeItem(overflow, value);
  return readItem(overflow) === value;
}

/**
 * Move unprefixed working-copy keys into the active namespace once.
 * Local only — never an upload.
 *
 * A legacy key is removed only after dest and the current source still equal
 * the copied snapshot. If dest already exists and differs, or either side
 * changes during the copy, the leftover is quarantined under a reserved
 * non-adoptable key so a later empty account cannot adopt it.
 */
function migrateLegacyWorkingCopy(anonymous, ownerId) {
  for (const [suffix, legacyKey] of Object.entries(LEGACY_WORKING_COPY_KEYS)) {
    const copied = readItem(legacyKey);
    if (copied == null) continue;
    const destKey = namespaceKey(anonymous, ownerId, suffix);
    const dest = readItem(destKey);
    if (dest == null) {
      writeItem(destKey, copied);
    }

    const destNow = readItem(destKey);
    const sourceNow = readItem(legacyKey);
    if (sourceNow == null) continue;

    const destMatchesCopied = destNow != null && matchesCopiedValue(destNow, copied);
    const sourceMatchesCopied = matchesCopiedValue(sourceNow, copied);
    if (destMatchesCopied && sourceMatchesCopied) {
      removeItem(legacyKey);
      continue;
    }

    // Copy did not land; leave the adoptable key for a later retry.
    if (destNow == null) continue;

    // Dest has data that is not a proven copy of the current source, or the
    // source changed after we copied. Quarantine so later accounts cannot adopt.
    if (quarantineLegacyValue(suffix, sourceNow)) {
      removeItem(legacyKey);
    }
  }
}

function promoteEditedDemoPlaces(places) {
  let changed = false;
  const next = places.map((place) => {
    if (!isDemoPlace(place) || isUntouchedDemoSeed(place)) return place;
    changed = true;
    const promoted = { ...place, id: mintPlaceId(), updatedAt: Date.now() };
    delete promoted.source;
    return promoted;
  });
  return { places: next, changed };
}

function readWorkingCopy(anonymous, ownerId, suffix) {
  migrateLegacyWorkingCopy(anonymous, ownerId);
  return readItem(namespaceKey(anonymous, ownerId, suffix));
}

function writeWorkingCopy(anonymous, ownerId, suffix, value) {
  migrateLegacyWorkingCopy(anonymous, ownerId);
  writeItem(namespaceKey(anonymous, ownerId, suffix), value);
}

function removeWorkingCopy(anonymous, ownerId, suffix) {
  migrateLegacyWorkingCopy(anonymous, ownerId);
  removeItem(namespaceKey(anonymous, ownerId, suffix));
}

export const StorageService = {
  _ownerId: ANONYMOUS_OWNER_ID,
  _anonymous: true,

  getOwnerId() {
    return this._anonymous ? ANONYMOUS_OWNER_ID : this._ownerId;
  },

  getNamespaceId() {
    return this._anonymous ? ANONYMOUS_OWNER_ID : `user:${this._ownerId}`;
  },

  /**
   * Switch the working copy. Does not copy values between namespaces.
   * `null` selects the unsigned-in anonymous namespace. An authenticated
   * user.id of `"anonymous"` is stored under the distinct `user:` tag.
   *
   * Identity is applied before any localStorage I/O. Pass `{ migrate: false }`
   * to flip the owner without touching storage so callers can clear UI first.
   */
  setOwner(ownerId, { migrate = true } = {}) {
    if (ownerId == null || (typeof ownerId === 'string' && ownerId.trim().length === 0)) {
      this._anonymous = true;
      this._ownerId = ANONYMOUS_OWNER_ID;
    } else if (typeof ownerId !== 'string') {
      throw new TypeError('Owner id must be a string or null');
    } else {
      this._anonymous = false;
      this._ownerId = ownerId;
    }
    if (migrate) {
      migrateLegacyWorkingCopy(this._anonymous, this._ownerId);
    }
    return this.getOwnerId();
  },

  ensureLegacyMigrated() {
    migrateLegacyWorkingCopy(this._anonymous, this._ownerId);
  },

  workingCopyKey(suffix) {
    return namespaceKey(this._anonymous, this._ownerId, suffix);
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
    const raw = readWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.HOME_ADDRESS);
    const parsed = parseJsonOr(raw, null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  },

  setHomeAddress(addressObj) {
    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.HOME_ADDRESS, JSON.stringify(addressObj));
  },

  clearHomeAddress() {
    removeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.HOME_ADDRESS);
  },

  /**
   * Saved Places Array
   */
  getSavedPlaces() {
    const raw = readWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES);
    if (!raw) {
      const seeded = clonePlaces(DEMO_PLACES);
      writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(seeded));
      return seeded;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      const validModern = parsed.filter(isModernPlace);
      if (validModern.length === 0 && parsed.length !== 0) {
        const seeded = clonePlaces(DEMO_PLACES);
        writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(seeded));
        return seeded;
      }

      const { places: promoted, changed } = promoteEditedDemoPlaces(validModern);
      if (validModern.length !== parsed.length || changed) {
        writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(promoted));
      }
      return promoted;
    } catch (e) {
      return [];
    }
  },

  savePlace(place) {
    const places = this.getSavedPlaces();
    const targetId = place.id && String(place.id).trim() !== '' ? String(place.id) : null;
    const existingIndex = targetId ? places.findIndex(p => String(p.id) === targetId) : -1;

    if (existingIndex >= 0) {
      const previous = places[existingIndex];
      const merged = { ...previous, ...place, updatedAt: Date.now() };
      if (isDemoPlace(previous)) {
        delete merged.source;
        merged.id = mintPlaceId();
      } else {
        merged.id = targetId;
      }
      places[existingIndex] = merged;
    } else {
      places.push({
        ...place,
        id: mintPlaceId(),
        createdAt: Date.now(),
      });
    }

    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(places));
    return places;
  },

  deletePlace(id) {
    const places = this.getSavedPlaces().filter(p => p.id !== id);
    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(places));
    return places;
  },

  /**
   * Per-namespace sync metadata. Login / session restore must not read or
   * write a remote NeighborhoodStore; these keys stay local.
   */
  getSyncConsent() {
    const raw = readWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SYNC_CONSENT);
    if (raw == null) return false;
    try {
      return JSON.parse(raw) === true;
    } catch {
      return raw === 'true';
    }
  },

  setSyncConsent(enabled) {
    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SYNC_CONSENT, JSON.stringify(Boolean(enabled)));
  },

  isDirty() {
    const raw = readWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.DIRTY);
    return raw === '1' || raw === 'true';
  },

  setDirty(dirty) {
    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.DIRTY, dirty ? '1' : '0');
  },

  getLastEtag() {
    return readWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.LAST_ETAG);
  },

  setLastEtag(etag) {
    if (etag == null || etag === '') {
      removeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.LAST_ETAG);
      return;
    }
    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.LAST_ETAG, String(etag));
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
        writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(data.savedPlaces));
      }
      return true;
    } catch (e) {
      console.error('Failed to parse import JSON', e);
      return false;
    }
  }
};
