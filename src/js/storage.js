/* ==========================================================================
   STORAGE SERVICE - LOCALSTORAGE MANAGEMENT & PERSISTENCE
   ========================================================================== */

const STORAGE_KEYS = {
  MAPBOX_TOKEN: 'neighborhood_guru_mapbox_token',
  HOME_ADDRESS: 'neighborhood_guru_home_address',
  SAVED_PLACES: 'neighborhood_guru_saved_places',
  MAP_STYLE: 'neighborhood_guru_map_style',
};

// Default Sample Neighborhood Data if storage is empty
const DEMO_PLACES = [
  {
    id: 'demo-1',
    name: 'Oak Street Bakery & Cafe',
    category: 'favorite',
    contactName: 'Chef Elena',
    contacts: [
      { type: 'phone_work', label: 'Work Phone', value: '(555) 345-6789' },
      { type: 'email_work', label: 'Email', value: 'hello@oakstreetbakery.com' }
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
    name: 'The Millers (Neighbors)',
    category: 'neighbor',
    contactName: 'Bob & Karen Miller',
    contacts: [
      { type: 'phone_mobile', label: 'Mobile (Bob)', value: '(555) 987-6543' },
      { type: 'phone_home', label: 'Home Phone', value: '(555) 987-1122' },
      { type: 'email_personal', label: 'Email', value: 'millers742@gmail.com' }
    ],
    address: '742 Evergreen Terrace',
    notes: 'Friendly neighbors. Have spare house key & key to water shutoff.',
    color: '#10b981',
    lat: 37.7765,
    lng: -122.4170,
    createdAt: Date.now() - 86400000 * 2,
  }
];

export function normalizePlaceContacts(place) {
  if (!place) return [];
  if (Array.isArray(place.contacts) && place.contacts.length > 0) {
    return place.contacts;
  }
  const contacts = [];
  if (place.phone) {
    contacts.push({ type: 'phone_mobile', label: 'Mobile', value: place.phone });
  }
  if (place.email) {
    contacts.push({ type: 'email_personal', label: 'Email', value: place.email });
  }
  return contacts;
}

export const StorageService = {
  /**
   * Mapbox Access Token
   */
  getMapboxToken() {
    return localStorage.getItem(STORAGE_KEYS.MAPBOX_TOKEN) || import.meta.env.VITE_MAPBOX_TOKEN || '';
  },

  setMapboxToken(token) {
    localStorage.setItem(STORAGE_KEYS.MAPBOX_TOKEN, token.trim());
  },

  /**
   * Home Address Object { name, lat, lng, formattedAddress }
   */
  getHomeAddress() {
    const raw = localStorage.getItem(STORAGE_KEYS.HOME_ADDRESS);
    return raw ? JSON.parse(raw) : null;
  },

  setHomeAddress(addressObj) {
    localStorage.setItem(STORAGE_KEYS.HOME_ADDRESS, JSON.stringify(addressObj));
  },

  clearHomeAddress() {
    localStorage.removeItem(STORAGE_KEYS.HOME_ADDRESS);
  },

  /**
   * Saved Places Array
   */
  getSavedPlaces() {
    const raw = localStorage.getItem(STORAGE_KEYS.SAVED_PLACES);
    if (!raw) {
      // Seed initial demo data for first time users
      localStorage.setItem(STORAGE_KEYS.SAVED_PLACES, JSON.stringify(DEMO_PLACES));
      return DEMO_PLACES;
    }
    return JSON.parse(raw);
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

    localStorage.setItem(STORAGE_KEYS.SAVED_PLACES, JSON.stringify(places));
    return places;
  },

  deletePlace(id) {
    const places = this.getSavedPlaces().filter(p => p.id !== id);
    localStorage.setItem(STORAGE_KEYS.SAVED_PLACES, JSON.stringify(places));
    return places;
  },

  /**
   * Map Style Preference
   */
  getPreferredStyle() {
    return localStorage.getItem(STORAGE_KEYS.MAP_STYLE) || 'streets';
  },

  setPreferredStyle(styleName) {
    localStorage.setItem(STORAGE_KEYS.MAP_STYLE, styleName);
  },

  /**
   * Backup Export & Import
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
        localStorage.setItem(STORAGE_KEYS.SAVED_PLACES, JSON.stringify(data.savedPlaces));
      }
      return true;
    } catch (e) {
      console.error('Failed to parse import JSON', e);
      return false;
    }
  }
};
