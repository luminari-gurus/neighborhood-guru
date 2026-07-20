/* ==========================================================================
   NEIGHBORHOOD GURU - APPLICATION ENTRY POINT
   ========================================================================== */

import { StorageService } from './js/storage.js';
import { MapboxService } from './js/mapbox-service.js';
import { UIController } from './js/ui.js';

class NeighborhoodGuruApp {
  constructor() {
    this.storage = StorageService;
    this.mapboxService = new MapboxService();
    this.ui = new UIController();

    this.homeAddress = null;
    this.savedPlaces = [];
  }

  async init() {
    // 1. Initialize UI Controller & cache elements
    this.ui.init();

    // 2. Load stored data
    this.homeAddress = this.storage.getHomeAddress();
    this.savedPlaces = this.storage.getSavedPlaces();
    const token = this.storage.getMapboxToken();
    const preferredStyle = this.storage.getPreferredStyle();

    // 3. Update UI Header & Sidebar state
    this.ui.updateHomeHeaderStatus(this.homeAddress);
    this.ui.renderPlacesList(
      this.savedPlaces,
      (place) => this.onPlaceSelected(place),
      (place) => this.ui.openLocationModal(place)
    );

    // Update style switcher button active states
    const styleBtn = document.querySelector(`.style-btn[data-style="${preferredStyle}"]`);
    if (styleBtn) {
      document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
      styleBtn.classList.add('active');
    }

    // 4. Initialize Mapbox Engine
    this.mapboxService.initMap('map', {
      token: token,
      homeAddress: this.homeAddress,
      preferredStyle: preferredStyle,
      onMapClick: (coords) => this.onMapClicked(coords),
    });

    // 5. Render markers once map is loaded
    this.mapboxService.map.on('load', () => {
      this.mapboxService.renderSavedMarkers(this.savedPlaces, (place) => {
        this.ui.openLocationModal(place);
      });
    });

    // 6. Bind event listeners
    this.bindEvents();

    // Show initial welcome toast
    if (!this.homeAddress) {
      this.ui.showToast('App loaded in 3D Earth Globe view. Search an address to set your Home base!', 'info');
    } else {
      this.ui.showToast(`Welcome back! Zoomed into Home at ${this.homeAddress.name || 'your neighborhood'}`, 'success');
    }
  }

  bindEvents() {
    const el = this.ui.elements;

    // --- Search & Home Address Handlers ---
    el.searchGoBtn.addEventListener('click', () => this.handleAddressSearch());
    el.addressSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleAddressSearch();
    });

    const handleAddLocationClick = async () => {
      const mapCenter = this.mapboxService.map.getCenter();
      const coords = this.mapboxService.currentTempCoords || {
        lat: mapCenter.lat,
        lng: mapCenter.lng,
      };

      this.ui.showToast('Preparing location details form...', 'info');
      let placeName = '';
      try {
        const result = await this.mapboxService.geocodeAddress(`${coords.lng},${coords.lat}`);
        if (result) placeName = result.name;
      } catch (e) {
        console.warn('Reverse geocoding failed', e);
      }

      // Explicitly ensure id is undefined so a new unique location is created
      this.ui.openLocationModal({
        id: undefined,
        lat: coords.lat,
        lng: coords.lng,
        address: placeName,
        name: placeName ? placeName.split(',')[0] : '',
      });
    };

    el.addLocationBtn.addEventListener('click', handleAddLocationClick);
    if (el.sidebarAddBtn) el.sidebarAddBtn.addEventListener('click', handleAddLocationClick);

    el.setHomeBtn.addEventListener('click', () => this.handleSetHomeAddress());

    // --- Quick Navigation Buttons ---
    el.flyHomeBtn.addEventListener('click', () => {
      if (this.homeAddress) {
        this.mapboxService.flyToHome(this.homeAddress);
        this.ui.showToast('Flying to Home address...', 'info');
      } else {
        this.ui.showToast('No Home address set. Use the search bar to set your Home location!', 'error');
      }
    });

    el.flyGlobeBtn.addEventListener('click', () => {
      this.mapboxService.flyToGlobe();
      this.ui.showToast('Flying out to 3D Earth Globe view...', 'info');
    });

    // --- Style Switcher Toggles (Streets vs Satellite) ---
    el.styleSwitcher.addEventListener('click', (e) => {
      const btn = e.target.closest('.style-btn');
      if (!btn) return;

      const style = btn.dataset.style;
      document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      this.storage.setPreferredStyle(style);
      this.mapboxService.setStyle(style);
      
      // Re-render markers after style swap
      setTimeout(() => {
        this.mapboxService.renderSavedMarkers(this.savedPlaces, (place) => this.ui.openLocationModal(place));
        if (this.homeAddress) this.mapboxService.renderHomeMarker(this.homeAddress);
      }, 500);

      this.ui.showToast(`Switched map style to ${style.toUpperCase()}`, 'info');
    });

    // --- Sidebar Drawer Controls & Filters ---
    el.toggleSidebarBtn.addEventListener('click', () => this.ui.toggleSidebar());
    el.closeSidebarBtn.addEventListener('click', () => this.ui.toggleSidebar(false));

    el.sidebarSearchInput.addEventListener('input', (e) => {
      this.ui.searchQuery = e.target.value;
      this.ui.renderPlacesList(
        this.savedPlaces,
        (place) => this.onPlaceSelected(place),
        (place) => this.ui.openLocationModal(place)
      );
    });

    el.sidebarFilterPills.addEventListener('click', (e) => {
      const pill = e.target.closest('.pill');
      if (!pill) return;

      document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      this.ui.currentFilter = pill.dataset.filter;
      this.ui.renderPlacesList(
        this.savedPlaces,
        (place) => this.onPlaceSelected(place),
        (place) => this.ui.openLocationModal(place)
      );
    });

    // --- Location Editor Modal Submit & Delete ---
    el.locationForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSaveLocation();
    });

    el.closeLocationModal.addEventListener('click', () => {
      this.ui.closeLocationModal();
      this.mapboxService.clearTempMarker();
    });

    el.cancelLocationBtn.addEventListener('click', () => {
      this.ui.closeLocationModal();
      this.mapboxService.clearTempMarker();
    });

    el.deleteLocationBtn.addEventListener('click', () => {
      const id = el.formLocationId.value;
      if (id && confirm('Are you sure you want to delete this location contact?')) {
        this.savedPlaces = this.storage.deletePlace(id);
        this.mapboxService.renderSavedMarkers(this.savedPlaces, (place) => this.ui.openLocationModal(place));
        this.ui.renderPlacesList(
          this.savedPlaces,
          (place) => this.onPlaceSelected(place),
          (place) => this.ui.openLocationModal(place)
        );
        this.ui.closeLocationModal();
        this.mapboxService.clearTempMarker();
        this.ui.showToast('Location deleted', 'info');
      }
    });

    // --- Settings Modal Handlers ---
    el.openSettingsBtn.addEventListener('click', () => {
      this.ui.openSettingsModal(this.storage.getMapboxToken());
    });

    el.closeSettingsModal.addEventListener('click', () => this.ui.closeSettingsModal());
    el.cancelSettingsBtn.addEventListener('click', () => this.ui.closeSettingsModal());

    el.saveSettingsBtn.addEventListener('click', () => {
      const token = el.settingsMapboxToken.value.trim();
      this.storage.setMapboxToken(token);
      this.ui.closeSettingsModal();
      this.ui.showToast('Mapbox token saved. Reloading map...', 'success');
      setTimeout(() => window.location.reload(), 1000);
    });

    el.clearHomeBtn.addEventListener('click', () => {
      if (confirm('Clear configured Home address? App will revert to Earth Globe view.')) {
        this.storage.clearHomeAddress();
        this.homeAddress = null;
        this.ui.updateHomeHeaderStatus(null);
        if (this.mapboxService.homeMarker) this.mapboxService.homeMarker.remove();
        this.ui.showToast('Home address cleared', 'info');
      }
    });

    // --- Backup Export & Import ---
    el.exportDataBtn.addEventListener('click', () => {
      const jsonStr = this.storage.exportDataJSON();
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `neighborhood-guru-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.ui.showToast('Neighborhood data exported successfully!', 'success');
    });

    el.importFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const success = this.storage.importDataJSON(event.target.result);
        if (success) {
          this.ui.showToast('Data imported successfully! Reloading...', 'success');
          setTimeout(() => window.location.reload(), 1000);
        } else {
          this.ui.showToast('Failed to import JSON file. Invalid format.', 'error');
        }
      };
      reader.readAsText(file);
    });

    // --- Map Hint Dismiss ---
    el.dismissHintBtn.addEventListener('click', () => {
      el.mapHintBanner.style.display = 'none';
    });
  }

  /**
   * Handle Map Click: Reverse geocode if possible & open editor modal
   */
  async onMapClicked(coords) {
    let placeName = '';
    
    // Attempt reverse geocoding via Mapbox Places API
    try {
      const result = await this.mapboxService.geocodeAddress(`${coords.lng},${coords.lat}`);
      if (result) placeName = result.name;
    } catch (e) {
      console.warn('Reverse geocoding failed', e);
    }

    const locationData = {
      lat: coords.lat,
      lng: coords.lng,
      address: placeName,
    };

    this.mapboxService.showTempMarker(coords, () => {
      this.ui.openLocationModal(locationData);
    });

    this.ui.openLocationModal(locationData);
  }

  /**
   * Address Search Handler
   */
  async handleAddressSearch() {
    const query = this.ui.elements.addressSearchInput.value.trim();
    if (!query) return;

    this.ui.showToast(`Searching for "${query}"...`, 'info');
    const result = await this.mapboxService.geocodeAddress(query);

    if (result) {
      const coords = { lat: result.lat, lng: result.lng };
      this.mapboxService.flyToLocation(result.lat, result.lng, 16.5);
      
      this.mapboxService.showTempMarker(coords, () => {
        this.ui.openLocationModal({
          lat: result.lat,
          lng: result.lng,
          address: result.name,
        });
      });

      this.ui.showToast(`Found: ${result.name.split(',')[0]}! Click "+ Add Location" to record details.`, 'success');
    } else {
      this.ui.showToast('Could not locate address. Try a more specific search.', 'error');
    }
  }

  /**
   * Set Focused Address as Home Address
   */
  async handleSetHomeAddress() {
    const center = this.mapboxService.map.getCenter();
    const coords = { lat: center.lat, lng: center.lng };

    this.ui.showToast('Updating Home address...', 'info');
    const geocode = await this.mapboxService.geocodeAddress(`${coords.lng},${coords.lat}`);

    const homeData = {
      name: geocode ? geocode.name : `Home (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`,
      lat: coords.lat,
      lng: coords.lng,
    };

    this.storage.setHomeAddress(homeData);
    this.homeAddress = homeData;

    this.mapboxService.renderHomeMarker(homeData);
    this.ui.updateHomeHeaderStatus(homeData);
    this.mapboxService.flyToHome(homeData);
    this.ui.showToast(`Home address set to ${homeData.name.split(',')[0]}!`, 'success');
  }

  /**
   * Save Location Form Handler
   */
  handleSaveLocation() {
    const el = this.ui.elements;
    const name = el.formName.value.trim() || `Location (${parseFloat(el.formLat.value).toFixed(3)}, ${parseFloat(el.formLng.value).toFixed(3)})`;

    const colorRadio = el.locationForm.querySelector('input[name="form-color"]:checked');
    const existingId = el.formLocationId.value.trim();
    const contacts = this.ui.getContactFieldsData();

    const placeData = {
      id: existingId ? existingId : undefined,
      lat: parseFloat(el.formLat.value),
      lng: parseFloat(el.formLng.value),
      name: name,
      category: el.formCategory.value,
      contactName: el.formContactName.value.trim(),
      contacts: contacts,
      address: el.formAddress.value.trim(),
      notes: el.formNotes.value.trim(),
      color: colorRadio ? colorRadio.value : '#3b82f6',
    };

    this.savedPlaces = this.storage.savePlace(placeData);

    // Clear temporary pin & coords reset
    this.mapboxService.clearTempMarker();
    this.mapboxService.currentTempCoords = null;

    // Update map markers & sidebar list
    this.mapboxService.renderSavedMarkers(this.savedPlaces, (place) => this.ui.openLocationModal(place));
    this.ui.renderPlacesList(
      this.savedPlaces,
      (place) => this.onPlaceSelected(place),
      (place) => this.ui.openLocationModal(place)
    );

    this.ui.closeLocationModal();
    this.ui.showToast(`Saved location "${name}"!`, 'success');
  }

  /**
   * Handle sidebar or popup click to focus on place
   */
  onPlaceSelected(place) {
    this.mapboxService.flyToLocation(place.lat, place.lng, 17);
    this.ui.showToast(`Focused on ${place.name}`, 'info');
  }
}

// Initialize Application on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  const app = new NeighborhoodGuruApp();
  app.init();
});
