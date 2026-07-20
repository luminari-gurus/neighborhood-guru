/* ==========================================================================
   MAPBOX SERVICE - MAP ENGINE, 3D GLOBE & MARKERS MANAGEMENT
   ========================================================================== */

import mapboxgl from 'mapbox-gl';
import { normalizePlaceContacts } from './storage.js';

const STYLES = {
  streets: 'mapbox://styles/mapbox/streets-v12',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
};

// Default token relies on VITE_MAPBOX_TOKEN or user entry in UI Settings
const DEFAULT_TOKEN = '';

export class MapboxService {
  constructor() {
    this.map = null;
    this.activeMarkers = [];
    this.homeMarker = null;
    this.tempClickMarker = null;
    this.currentToken = '';
    this.currentStyle = 'streets';
  }

  /**
   * Initialize Mapbox instance
   */
  initMap(containerId, options = {}) {
    const {
      token = '',
      homeAddress = null,
      preferredStyle = 'streets',
      onMapClick = null,
      onMarkerClick = null,
    } = options;

    this.currentToken = token.trim() || DEFAULT_TOKEN;
    mapboxgl.accessToken = this.currentToken;

    this.currentStyle = preferredStyle;
    const initialStyle = STYLES[preferredStyle] || STYLES.streets;

    // Determine initial camera view & projection mode
    const hasHome = homeAddress && typeof homeAddress.lat === 'number' && typeof homeAddress.lng === 'number';

    const mapOptions = {
      container: containerId,
      style: initialStyle,
      projection: 'globe', // Natively enables 3D Earth Globe view when zoomed out
      center: hasHome ? [homeAddress.lng, homeAddress.lat] : [0, 20],
      zoom: hasHome ? 15.5 : 1.5,
      pitch: hasHome ? 35 : 0,
      bearing: hasHome ? -10 : 0,
      attributionControl: true,
    };

    this.map = new mapboxgl.Map(mapOptions);

    // Add navigation controls (Zoom, pitch, compass)
    this.map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');

    // Add scale control
    this.map.addControl(new mapboxgl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

    this.map.on('load', () => {
      // Set atmospheric glow & starry night sky for globe projection
      this.setupGlobeEnvironment();

      if (hasHome) {
        this.renderHomeMarker(homeAddress);
      }
    });

    // Handle map click event to capture coordinates for adding a location
    if (onMapClick) {
      this.map.on('click', (e) => {
        // Prevent trigger if clicking on a marker popup
        if (e.originalEvent.target.closest('.mapboxgl-popup') || e.originalEvent.target.closest('.custom-map-marker')) {
          return;
        }

        const coords = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        this.showTempMarker(coords);
        onMapClick(coords);
      });
    }

    return this.map;
  }

  /**
   * Apply atmospheric fog & sky for 3D Globe View
   */
  setupGlobeEnvironment() {
    if (!this.map) return;
    try {
      this.map.setFog({
        color: 'rgb(186, 210, 240)', // Lower atmosphere glow
        'high-color': 'rgb(36, 92, 223)', // Upper atmosphere
        'space-color': 'rgb(11, 11, 25)', // Deep space
        'star-intensity': 0.6 // Starry background
      });
    } catch (err) {
      console.warn('Fog settings failed or unsupported by map style', err);
    }
  }

  /**
   * Switch between Streets and Satellite map styles
   */
  setStyle(styleName) {
    if (!this.map || !STYLES[styleName]) return;
    this.currentStyle = styleName;

    this.map.setStyle(STYLES[styleName]);

    // Re-apply fog and markers after style load finishes
    this.map.once('style.load', () => {
      this.setupGlobeEnvironment();
    });
  }

  /**
   * Smooth flyTo transition to Home Address
   */
  flyToHome(homeAddress) {
    if (!this.map || !homeAddress) return;

    this.map.flyTo({
      center: [homeAddress.lng, homeAddress.lat],
      zoom: 16,
      pitch: 45,
      bearing: 0,
      duration: 3200,
      essential: true,
    });
  }

  /**
   * Smooth flyTo transition out to 3D Earth Globe view
   */
  flyToGlobe() {
    if (!this.map) return;

    this.map.flyTo({
      center: [0, 20],
      zoom: 1.5,
      pitch: 0,
      bearing: 0,
      duration: 3000,
      essential: true,
    });
  }

  /**
   * Fly to specific coordinates
   */
  flyToLocation(lat, lng, zoom = 16) {
    if (!this.map) return;

    this.map.flyTo({
      center: [lng, lat],
      zoom: zoom,
      pitch: 35,
      duration: 2000,
      essential: true,
    });
  }

  /**
   * Render or Update Home Marker
   */
  renderHomeMarker(homeAddress) {
    if (!this.map || !homeAddress) return;

    if (this.homeMarker) {
      this.homeMarker.remove();
    }

    const el = document.createElement('div');
    el.className = 'custom-map-marker home-marker';
    el.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
    `;

    const popupContent = `
      <div style="text-align: center; padding: 4px;">
        <strong style="color: #10b981; font-size: 1rem;">🏡 Home Address</strong>
        <p style="margin-top: 4px; font-size: 0.82rem; color: #94a3b8;">${homeAddress.name || 'Your Home Base'}</p>
      </div>
    `;

    const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(popupContent);

    this.homeMarker = new mapboxgl.Marker({ element: el })
      .setLngLat([homeAddress.lng, homeAddress.lat])
      .setPopup(popup)
      .addTo(this.map);
  }

  /**
   * Temporary marker when user clicks on map or searches to add a place
   */
  showTempMarker(coords, onTempMarkerClick = null) {
    if (this.tempClickMarker) {
      this.tempClickMarker.remove();
    }

    this.currentTempCoords = coords;

    const el = document.createElement('div');
    el.className = 'custom-map-marker temp-map-marker';
    el.style.backgroundColor = '#ef4444';
    el.style.cursor = 'pointer';
    el.title = 'Click + to save location details';
    el.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    `;

    if (onTempMarkerClick) {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onTempMarkerClick(coords);
      });
    }

    const popupHtml = `
      <div style="text-align: center; padding: 4px;">
        <strong style="color: #ef4444; font-size: 0.9rem;">📍 Selected Location</strong>
        <p style="margin-top: 4px; font-size: 0.8rem; color: #cbd5e1;">Click below to record contact & details</p>
        <button class="btn btn-primary btn-sm temp-add-btn" style="margin-top: 8px; width: 100%;">➕ Add Location Details</button>
      </div>
    `;

    const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(popupHtml);

    this.tempClickMarker = new mapboxgl.Marker({ element: el })
      .setLngLat([coords.lng, coords.lat])
      .setPopup(popup)
      .addTo(this.map);

    popup.on('open', () => {
      const addBtn = popup.getElement().querySelector('.temp-add-btn');
      if (addBtn && onTempMarkerClick) {
        addBtn.addEventListener('click', () => {
          onTempMarkerClick(coords);
          popup.remove();
        });
      }
    });
  }

  clearTempMarker() {
    if (this.tempClickMarker) {
      this.tempClickMarker.remove();
      this.tempClickMarker = null;
    }
  }

  /**
   * Render all saved neighborhood location markers
   */
  renderSavedMarkers(places = [], onMarkerClick = null) {
    if (!this.map) return;

    // Clear old active markers
    this.activeMarkers.forEach(marker => marker.remove());
    this.activeMarkers = [];

    places.forEach((place) => {
      const el = document.createElement('div');
      el.className = 'custom-map-marker';
      el.style.backgroundColor = place.color || '#3b82f6';
      
      const iconSvg = this.getCategoryIconSvg(place.category);
      el.innerHTML = iconSvg;

      const contacts = normalizePlaceContacts(place);
      let popupContactsHtml = '';
      contacts.forEach(c => {
        const isEmail = c.type.startsWith('email');
        const icon = isEmail ? '✉️' : '📞';
        const link = isEmail ? `mailto:${c.value}` : `tel:${c.value}`;
        popupContactsHtml += `<p style="font-size: 0.8rem; margin-top: 2px;">${icon} <a href="${link}" style="color: #3b82f6; text-decoration: none;">${c.value}</a></p>`;
      });

      // Popup Content
      const popupHtml = `
        <div class="marker-popup-card">
          <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
            <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background-color: ${place.color || '#3b82f6'};"></span>
            <strong style="font-size: 0.95rem;">${place.name}</strong>
          </div>
          ${place.contactName ? `<p style="font-size: 0.8rem; color: #94a3b8;">👤 ${place.contactName}</p>` : ''}
          ${popupContactsHtml}
          ${place.notes ? `<p style="font-size: 0.78rem; color: #cbd5e1; margin-top: 6px; font-style: italic;">"${place.notes.substring(0, 70)}${place.notes.length > 70 ? '...' : ''}"</p>` : ''}
          <button class="btn btn-primary btn-sm popup-edit-btn" data-id="${place.id}" style="margin-top: 10px; width: 100%; font-size: 0.75rem; padding: 4px;">View & Edit Details</button>
        </div>
      `;

      const popup = new mapboxgl.Popup({ offset: 20 }).setHTML(popupHtml);

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([place.lng, place.lat])
        .setPopup(popup)
        .addTo(this.map);

      // Handle Edit button click inside popup
      popup.on('open', () => {
        const editBtn = popup.getElement().querySelector('.popup-edit-btn');
        if (editBtn && onMarkerClick) {
          editBtn.addEventListener('click', () => {
            onMarkerClick(place);
            popup.remove();
          });
        }
      });

      this.activeMarkers.push(marker);
    });
  }

  /**
   * Icon Helper by Category
   */
  getCategoryIconSvg(category) {
    switch (category) {
      case 'neighbor':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
      case 'service':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
      case 'favorite':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
      case 'business':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
      case 'emergency':
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
      default:
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
    }
  }

  /**
   * Forward Geocode query address string using Mapbox Places API
   */
  async geocodeAddress(query) {
    const token = this.currentToken || DEFAULT_TOKEN;
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}&limit=1`;

    try {
      const response = await fetch(url);
      const data = await response.json();
      if (data && data.features && data.features.length > 0) {
        const feature = data.features[0];
        return {
          name: feature.place_name,
          lng: feature.center[0],
          lat: feature.center[1],
        };
      }
      return null;
    } catch (err) {
      console.error('Geocoding error:', err);
      return null;
    }
  }
}
