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
      localStorage.setItem(STORAGE_KEYS.SAVED_PLACES, JSON.stringify(DEMO_PLACES));
      return DEMO_PLACES;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return DEMO_PLACES;
      
      const validModern = parsed.filter(isModernPlace);
      
      // Purge any legacy items from localStorage
      if (validModern.length !== parsed.length) {
        const finalPlaces = validModern.length > 0 ? validModern : DEMO_PLACES;
        localStorage.setItem(STORAGE_KEYS.SAVED_PLACES, JSON.stringify(finalPlaces));
        return finalPlaces;
      }
      return validModern;
    } catch (e) {
      return DEMO_PLACES;
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
