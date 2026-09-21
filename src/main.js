/* ==========================================================================
   NEIGHBORHOOD GURU - APPLICATION ENTRY POINT
   ========================================================================== */

import { StorageService } from './js/storage.js';
import { bindNeighborhoodWorkingCopy } from './js/neighborhood-working-copy.js';
import { MapboxService } from './js/mapbox-service.js';
import { UIController } from './js/ui.js';
import { WeatherService } from './js/weather-service.js';
import { OverpassService } from './js/overpass-service.js';
import { JamBaseService } from './js/jambase-service.js';
import { createAnonymousAuthClient, createAuthState, createHttpAuthClient } from './js/auth/index.js';

export function createRuntimeAuthClient(config = globalThis.__NG_RUNTIME_CONFIG__ || { authMode: 'disabled' }) {
  return config.authMode === 'optional' || config.authMode === 'required' ? createHttpAuthClient() : createAnonymousAuthClient();
}

export class NeighborhoodGuruApp {
  constructor({
    storage = StorageService,
    ui = new UIController(),
    mapboxService = new MapboxService(),
    auth = null,
    authClient = null,
  } = {}) {
    this.storage = storage;
    this.mapboxService = mapboxService;
    this.ui = ui;
    this.auth = auth || createAuthState(authClient || createRuntimeAuthClient());
    this.unsubscribeAuth = this.auth.subscribe((state) => {
      this.authState = state;
    });
    this.unsubscribeWorkingCopy = null;
    this.viewReady = false;
    this.disposed = false;

    this.homeAddress = null;
    this.savedPlaces = [];
    this.sunAnimationTimer = null;
    this.currentDiscoveredPois = [];
    this.poiFilter = 'all';
    this.neighborhoodGeneration = 0;
    this.poiDiscoveryGeneration = -1;
    this.poiSearchGeneration = 0;
    this.locationSelectionGeneration = 0;
    this.editorNamespaceId = null;
    this.editorRevision = 0;
    this.eventAbort = new AbortController();
    this.domListeners = [];
    this.timeouts = [];
    this.jambaseSearchGeneration = 0;
  }

  async init() {
    try {
      await this.auth.initialize();
    } catch (err) {
      if (this.disposed) return;
      throw err;
    }
    if (this.disposed) return;

    // Bind after initialize() so restore has already settled (this call does
    // not observe AUTHENTICATING from loadSession). Later sign-in still goes
    // through the subscribe path, which ignores AUTHENTICATING so another
    // namespace is not flashed. Login never uploads.
    this.unsubscribeWorkingCopy = bindNeighborhoodWorkingCopy(this.auth, this.storage, {
      onOwnerChange: () => {
        if (this.viewReady && !this.disposed) {
          this.clearOwnerScopedPresentation();
        }
      },
      onOwnerReady: () => {
        if (this.viewReady && !this.disposed) {
          this.syncNeighborhoodViewFromStorage();
        }
      },
    });
    if (this.unsubscribeWorkingCopy?.ready) {
      await this.unsubscribeWorkingCopy.ready;
    }
    if (this.disposed) return;

    // 1. Initialize UI Controller & cache elements
    this.ui.init();
    this.viewReady = true;

    // Wire up JamBase API fallback notification (shows toast when API fails)
    JamBaseService.setApiFallbackCallback((reason) => {
      this.ui.showJambaseApiFallbackToast(reason);
    });

    // 2. Load stored data for the active namespace
    this.syncNeighborhoodViewFromStorage();
    const token = this.storage.getMapboxToken();
    const preferredStyle = this.storage.getPreferredStyle();

    // Update style switcher button active states
    const styleBtn = document.querySelector(`.style-btn[data-style="${preferredStyle}"]`);
    if (styleBtn) {
      document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
      styleBtn.classList.add('active');
    }

    // 4. ALWAYS Bind event listeners FIRST so UI is 100% interactive
    this.bindEvents();

    // 5. Check Mapbox Key Status
    const hasKey = Boolean(token && token.trim().startsWith('pk.'));
    this.ui.updateKeyWarningState(hasKey);

    // 6. Safely initialize Mapbox Engine
    if (hasKey) {
      try {
        const map = this.mapboxService.initMap('map', {
          token: token,
          homeAddress: this.homeAddress,
          preferredStyle: preferredStyle,
          onMapClick: (coords) => this.onMapClicked(coords),
          onLoad: () => {
            if (this.disposed || this.mapboxService.tornDown) return;
            this.renderNeighborhoodView();
          },
          onTokenError: () => {
            this.ui.updateKeyWarningState(false);
            this.ui.openKeyPromptModal(token);
            this.ui.showToast('Invalid Mapbox access token. Please check your key.', 'error');
          }
        });
      } catch (err) {
        console.warn('Mapbox initialization failed:', err);
        this.ui.updateKeyWarningState(false);
      }
    } else {
      this.scheduleTimeout(() => {
        if (this.disposed) return;
        this.ui.openKeyPromptModal(token);
      }, 300);
      this.ui.showToast('Mapbox Access Token required. Provide a key to enable map features!', 'error');
    }
  }

  /**
   * Reload home / places from the current namespace and refresh UI.
   * On owner change, fail closed: clear editor/in-memory state before reading
   * the destination so another user's data cannot remain rendered or be saved.
   */
  syncNeighborhoodViewFromStorage({ ownerChanged = false } = {}) {
    this.neighborhoodGeneration += 1;
    this.editorNamespaceId = null;

    if (ownerChanged) {
      this.clearOwnerScopedPresentation();
    }

    try {
      this.homeAddress = this.storage.getHomeAddress();
      this.savedPlaces = this.storage.getSavedPlaces();
    } catch {
      this.homeAddress = null;
      this.savedPlaces = [];
    }

    this.renderNeighborhoodView();
    this.fetchAndDisplayWeather();
    this.refreshLegacyRecovery();
  }

  refreshLegacyRecovery() {
    if (this.disposed) return;
    const status = typeof this.storage.legacyMigrationStatus === 'function'
      ? this.storage.legacyMigrationStatus()
      : { leftoverPresent: false, leftoverUnapplied: false, leftoverAdoptable: false, locksAvailable: true, leftovers: [], ambiguousLeftovers: [], ownerOrphans: [], deviceOrphans: [], importRollbackIncomplete: false, foreignImportJournalUnresolved: false };
    this.ui.updateLegacyRecoveryBanner?.(status);
  }

  async handleRestoreLegacyLeftover() {
    if (this.disposed) return;
    const generation = this.neighborhoodGeneration;
    const namespaceId = this.storage.getNamespaceId();
    const status = this.storage.legacyMigrationStatus?.() || {};
    if (!status.locksAvailable) {
      this.ui.showToast('This browser cannot finish the leftover upgrade automatically. Download device recovery instead.', 'warning', 8000);
      return;
    }
    const result = await this.storage.ensureLegacyMigratedAsync();
    if (this.disposed || !this.isSameOwnerGeneration(generation, namespaceId)) return;
    this.refreshLegacyRecovery();
    if (!result?.ok) {
      const reason = result?.reason;
      if (reason === 'lock-rejected' || reason === 'lock-unavailable') {
        this.ui.showToast('Could not finish leftover restore because a storage lock was unavailable. Download device recovery to keep a copy.', 'warning', 8000);
      } else if (reason === 'owner-changed') {
        this.ui.showToast('Account changed before leftover restore finished. Nothing was applied to the new account.', 'warning', 8000);
      } else {
        this.ui.showToast('Leftover restore did not finish. Download device recovery to keep a copy.', 'warning', 8000);
      }
      return;
    }
    this.syncNeighborhoodViewFromStorage();
    if (this.disposed || !this.isSameOwnerGeneration(generation, namespaceId)) return;
    const after = this.storage.legacyMigrationStatus?.() || {};
    const destHasHome = Boolean(this.homeAddress);
    const destHasPlaces = Array.isArray(this.savedPlaces) && this.savedPlaces.length > 0;
    if (!destHasHome && !destHasPlaces && (after.leftoverPresent || after.leftoverUnapplied)) {
      this.ui.showToast('Leftover data is still on this device and was not applied to this account. Download device recovery to keep a copy.', 'warning', 8000);
    }
  }

  handleOwnerOrphanAction(action, key) {
    if (this.disposed || !key) return;
    const generation = this.neighborhoodGeneration;
    const namespaceId = this.storage.getNamespaceId();
    const preview = this.storage.previewOrphanedWorkingCopy?.(key);
    if (!preview) {
      this.ui.showToast('That leftover record is not available for this account.', 'warning', 6000);
      return;
    }
    const label = preview.preview?.homeName
      || (Array.isArray(preview.preview?.placeNames) && preview.preview.placeNames[0])
      || 'leftover record';
    if (action === 'preview') {
      const extra = preview.preview?.placeCount
        ? ` (${preview.preview.placeCount} place(s))`
        : '';
      this.ui.showToast(`Leftover preview: ${label}${extra}`, 'info', 7000);
      return;
    }
    const mode = action === 'merge' ? 'merge' : 'replace';
    const confirmed = typeof globalThis.confirm === 'function'
      ? globalThis.confirm(`${mode === 'merge' ? 'Merge' : 'Replace with'} leftover "${label}" in this account?`)
      : true;
    if (!confirmed) return;
    if (this.disposed || !this.isSameOwnerGeneration(generation, namespaceId)) return;
    const result = this.storage.restoreOrphanedWorkingCopy(key, { mode });
    if (!result?.ok) {
      this.ui.showToast(result?.reason === 'conflict'
        ? 'This account already has a home. Use Replace to overwrite it, or keep the current home.'
        : 'Could not restore that leftover into this account.', 'warning', 7000);
      this.refreshLegacyRecovery();
      return;
    }
    this.syncNeighborhoodViewFromStorage();
    this.ui.showToast(mode === 'merge' ? 'Leftover merged into this account.' : 'Leftover restored into this account.', 'success');
  }

  clearOwnerScopedPresentation() {
    this.homeAddress = null;
    this.savedPlaces = [];
    this.currentDiscoveredPois = [];
    this.neighborhoodGeneration += 1;
    this.poiSearchGeneration += 1;
    this.poiDiscoveryGeneration = -1;
    this.bumpEditorRevision();
    this.editorNamespaceId = null;
    this.locationSelectionGeneration += 1;
    this.jambaseSearchGeneration += 1;
    try {
      this.ui.resetOwnerScopedPresentation?.();
      this.ui.updateWeatherDisplay?.(null);
      this.mapboxService.clearTempMarker?.();
      this.mapboxService.currentTempCoords = null;
      if (this.mapboxService.homeMarker) {
        this.mapboxService.homeMarker.remove();
        this.mapboxService.homeMarker = null;
      }
      this.mapboxService.renderSavedMarkers?.([]);
      this.ui.updateHomeHeaderStatus(null);
      this.ui.renderPlacesList([], (place) => this.onPlaceSelected(place), (place) => this.openLocationEditor(place));
    } catch {
      // Destination render follows; never keep the previous owner's UI.
    }
  }

  renderNeighborhoodView() {
    if (!this.ui?.elements || Object.keys(this.ui.elements).length === 0) return;

    this.ui.updateHomeHeaderStatus(this.homeAddress);
    this.ui.renderPlacesList(
      this.savedPlaces,
      (place) => this.onPlaceSelected(place),
      (place) => this.openLocationEditor(place)
    );

    if (this.mapboxService.map) {
      this.mapboxService.renderSavedMarkers(this.savedPlaces, (place) => {
        this.openLocationEditor(place);
      });
      if (this.homeAddress) {
        this.mapboxService.renderHomeMarker(this.homeAddress);
      } else if (this.mapboxService.homeMarker) {
        this.mapboxService.homeMarker.remove();
        this.mapboxService.homeMarker = null;
      }
    }
  }

  openLocationEditor(place) {
    this.bumpEditorRevision();
    this.editorNamespaceId = this.storage.getNamespaceId();
    this.ui.openLocationModal(place);
  }

  closeLocationEditor() {
    this.bumpEditorRevision();
    this.editorNamespaceId = null;
    this.ui.closeLocationModal();
  }

  bumpEditorRevision() {
    this.editorRevision += 1;
    return this.editorRevision;
  }

  isCurrentGeneration(generation) {
    return !this.disposed && generation === this.neighborhoodGeneration;
  }

  isSameOwnerGeneration(generation, namespaceId) {
    return this.isCurrentGeneration(generation) && this.storage.getNamespaceId() === namespaceId;
  }

  editorMatchesCurrentOwner() {
    return this.editorNamespaceId != null && this.editorNamespaceId === this.storage.getNamespaceId();
  }

  editorMatchesCurrentRequest(editorRevision) {
    return !this.disposed
      && this.editorMatchesCurrentOwner()
      && editorRevision === this.editorRevision;
  }

  listen(target, type, handler) {
    if (this.disposed) return;
    if (!target || typeof target.addEventListener !== 'function') return;
    // AbortSignal in addEventListener: Chrome/Edge 90+, Firefox 86+, Safari 15+.
    // Always track and removeEventListener so older supported engines still tear down.
    const wrapped = (event) => {
      if (this.disposed) return;
      handler(event);
    };
    try {
      target.addEventListener(type, wrapped, { signal: this.eventAbort.signal });
    } catch {
      target.addEventListener(type, wrapped);
    }
    this.domListeners.push({ target, type, handler: wrapped });
  }

  scheduleTimeout(fn, delayMs) {
    if (this.disposed) return null;
    const id = setTimeout(() => {
      this.timeouts = this.timeouts.filter((entry) => entry !== id);
      if (this.disposed) return;
      fn();
    }, delayMs);
    this.timeouts.push(id);
    return id;
  }

  dispose() {
    this.disposed = true;
    this.neighborhoodGeneration += 1;
    this.poiSearchGeneration += 1;
    this.locationSelectionGeneration += 1;
    this.jambaseSearchGeneration += 1;
    this.bumpEditorRevision();
    this.editorNamespaceId = null;
    try {
      this.eventAbort.abort();
    } catch {
      // Already aborted.
    }
    for (const id of this.timeouts) {
      try {
        clearTimeout(id);
      } catch {
        // Timer may already have fired.
      }
    }
    this.timeouts = [];
    for (const { target, type, handler } of this.domListeners) {
      try {
        target.removeEventListener(type, handler);
      } catch {
        // Node may already be gone.
      }
    }
    this.domListeners = [];
    this.mapboxService.teardownMap?.();
    this.ui.dispose?.();
    if (this.sunAnimationTimer) {
      clearInterval(this.sunAnimationTimer);
      this.sunAnimationTimer = null;
    }
    JamBaseService.setApiFallbackCallback(null);
    this.unsubscribeWorkingCopy?.();
    this.unsubscribeWorkingCopy = null;
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.auth?.dispose?.();
  }

  bindEvents() {
    const el = this.ui.elements;

    // --- Search & Home Address Handlers ---
    this.listen(el.searchGoBtn, 'click', () => this.handleAddressSearch());
    this.listen(el.addressSearchInput, 'keydown', (e) => {
      if (e.key === 'Enter') this.handleAddressSearch();
    });

    const handleAddLocationClick = async () => {
      const generation = this.neighborhoodGeneration;
      const operationId = ++this.locationSelectionGeneration;
      const mapCenter = this.mapboxService.map ? this.mapboxService.map.getCenter() : { lat: 37.7749, lng: -122.4194 };
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

      if (!this.isCurrentGeneration(generation) || operationId !== this.locationSelectionGeneration) return;
      this.openLocationEditor({
        id: undefined,
        lat: coords.lat,
        lng: coords.lng,
        address: placeName,
        name: placeName ? placeName.split(',')[0] : '',
      });
    };

    this.listen(el.addLocationBtn, 'click', handleAddLocationClick);
    if (el.sidebarAddBtn) this.listen(el.sidebarAddBtn, 'click', handleAddLocationClick);

    this.listen(el.setHomeBtn, 'click', () => this.handleSetHomeAddress());

    // --- Quick Navigation Buttons ---
    this.listen(el.flyHomeBtn, 'click', () => {
      if (this.homeAddress) {
        this.mapboxService.flyToHome(this.homeAddress);
        this.ui.showToast('Flying to Home address...', 'info');
      } else {
        this.ui.showToast('No Home address set. Use the search bar to set your Home location!', 'error');
      }
    });

    this.listen(el.flyGlobeBtn, 'click', () => {
      this.mapboxService.flyToGlobe();
      this.ui.showToast('Flying out to 3D Earth Globe view...', 'info');
    });

    // --- Style Switcher Toggles (Streets vs Satellite) ---
    this.listen(el.styleSwitcher, 'click', (e) => {
      const btn = e.target.closest('.style-btn');
      if (!btn) return;

      const style = btn.dataset.style;
      document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      this.storage.setPreferredStyle(style);
      this.mapboxService.setStyle(style);
      
      // Re-render markers after style swap
      this.scheduleTimeout(() => {
        this.mapboxService.renderSavedMarkers(this.savedPlaces, (place) => this.openLocationEditor(place));
        if (this.homeAddress) this.mapboxService.renderHomeMarker(this.homeAddress);
      }, 500);

      this.ui.showToast(`Switched map style to ${style.toUpperCase()}`, 'info');
    });

    // --- 3D Buildings & Terrain Toggle ---
    if (el.toggle3dBtn) {
      this.listen(el.toggle3dBtn, 'click', () => {
        const isNow3D = this.mapboxService.toggle3DMode();
        if (isNow3D) {
          el.toggle3dBtn.classList.add('active');
          this.ui.showToast('3D Buildings & Terrain Elevation Enabled!', 'success');
        } else {
          el.toggle3dBtn.classList.remove('active');
          this.ui.showToast('Switched to 2D Flat View', 'info');
        }
      });
    }

    // --- Sidebar Drawer Controls & Filters ---
    this.listen(el.toggleSidebarBtn, 'click', () => this.ui.toggleSidebar());
    this.listen(el.closeSidebarBtn, 'click', () => this.ui.toggleSidebar(false));

    this.listen(el.sidebarSearchInput, 'input', (e) => {
      this.ui.searchQuery = e.target.value;
      this.ui.renderPlacesList(
        this.savedPlaces,
        (place) => this.onPlaceSelected(place),
        (place) => this.openLocationEditor(place)
      );
    });

    this.listen(el.sidebarFilterPills, 'click', (e) => {
      const pill = e.target.closest('.pill');
      if (!pill) return;

      document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      this.ui.currentFilter = pill.dataset.filter;
      this.ui.renderPlacesList(
        this.savedPlaces,
        (place) => this.onPlaceSelected(place),
        (place) => this.openLocationEditor(place)
      );
    });

    // --- Location Editor Modal Submit & Delete ---
    this.listen(el.locationForm, 'submit', (e) => {
      e.preventDefault();
      this.handleSaveLocation();
    });

    this.listen(el.closeLocationModal, 'click', () => {
      this.closeLocationEditor();
      this.mapboxService.clearTempMarker();
    });

    this.listen(el.cancelLocationBtn, 'click', () => {
      this.closeLocationEditor();
      this.mapboxService.clearTempMarker();
    });

    this.listen(el.deleteLocationBtn, 'click', () => {
      this.handleDeleteLocation();
    });

    // --- Settings Modal Handlers ---
    this.listen(el.openSettingsBtn, 'click', () => {
      this.ui.openSettingsModal(this.storage.getMapboxToken(), this.storage.getJambaseToken());
    });

    this.listen(el.closeSettingsModal, 'click', () => this.ui.closeSettingsModal());
    this.listen(el.cancelSettingsBtn, 'click', () => this.ui.closeSettingsModal());

    this.listen(el.saveSettingsBtn, 'click', () => {
      const token = el.settingsMapboxToken ? el.settingsMapboxToken.value.trim() : '';
      const jbToken = el.settingsJambaseToken ? el.settingsJambaseToken.value.trim() : '';
      this.storage.setMapboxToken(token);
      this.storage.setJambaseToken(jbToken);
      JamBaseService.clearShowsCache();
      JamBaseService.resetApiFallbackNotification();
      this.ui.closeSettingsModal();
      this.ui.showToast('Settings saved. Reloading map...', 'success');
      this.scheduleTimeout(() => window.location.reload(), 1000);
    });

    this.listen(el.clearHomeBtn, 'click', () => {
      this.handleClearHome();
    });

    // --- Key Prompt Modal & Warning Banner Handlers ---
    this.listen(el.closeKeyPromptModal, 'click', () => this.ui.closeKeyPromptModal());

    this.listen(el.dismissKeyPromptBtn, 'click', () => {
      this.ui.closeKeyPromptModal();
      this.ui.showToast('Exploring in demo mode. Click "Provide Mapbox Key" to enable map tiles.', 'info');
    });

    this.listen(el.bannerOpenKeyModalBtn, 'click', () => {
      this.ui.openKeyPromptModal(this.storage.getMapboxToken());
    });

    this.listen(el.saveKeyPromptBtn, 'click', () => {
      const token = el.promptMapboxToken ? el.promptMapboxToken.value.trim() : '';
      if (!token) {
        this.ui.showToast('Please enter a valid Mapbox Access Token.', 'error');
        return;
      }
      if (!token.startsWith('pk.')) {
        this.ui.showToast('Mapbox public tokens usually start with "pk." Please double check your key.', 'error');
      }

      this.storage.setMapboxToken(token);
      this.ui.closeKeyPromptModal();
      this.ui.updateKeyWarningState(true);
      this.ui.showToast('Mapbox key saved! Reloading map...', 'success');
      this.scheduleTimeout(() => window.location.reload(), 800);
    });

    // --- Backup Export & Import ---
    this.listen(el.exportDataBtn, 'click', () => {
      const jsonStr = this.storage.exportDataJSON();
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `neighborhood-guru-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      let orphanCount = 0;
      try {
        orphanCount = JSON.parse(jsonStr).orphanedWorkingCopies?.length || 0;
      } catch {
        orphanCount = 0;
      }
      this.ui.showToast(
        orphanCount > 0
          ? `Neighborhood data exported, including ${orphanCount} leftover record(s) marked orphaned.`
          : 'Neighborhood data exported successfully!',
        'success',
      );
    });

    this.listen(el.importFileInput, 'change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const generation = this.neighborhoodGeneration;
      const namespaceId = this.storage.getNamespaceId();
      const reader = new FileReader();
      reader.onload = async (event) => {
        if (this.disposed) return;
        if (!this.isSameOwnerGeneration(generation, namespaceId)) {
          this.ui.showToast('Account changed before import finished. Nothing was written to the new account.', 'warning', 8000);
          return;
        }
        const result = await this.storage.importDataJSON(event.target.result);
        this.reportImportOutcome(result, generation, namespaceId);
      };
      reader.readAsText(file);
    });

    this.listen(el.exportDeviceRecoveryBtn, 'click', () => {
      const jsonStr = this.storage.exportDeviceRecoveryJSON();
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `neighborhood-guru-device-recovery-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.ui.showToast('Device recovery file downloaded. Review it before restoring — it is not bound to the signed-in account.', 'warning', 8000);
    });

    this.listen(el.restoreLegacyBtn, 'click', () => {
      this.handleRestoreLegacyLeftover();
    });

    this.listen(el.legacyRecoveryBanner, 'click', (e) => {
      const btn = e.target.closest('[data-orphan-action]');
      if (!btn) return;
      this.handleOwnerOrphanAction(btn.dataset.orphanAction, btn.dataset.orphanKey);
    });

    // --- Map Hint Dismiss ---
    this.listen(el.dismissHintBtn, 'click', () => {
      if (el.mapHintBanner) el.mapHintBanner.style.display = 'none';
    });

    // --- 3D Solar Light Controller & Weather Handlers ---
    this.listen(el.sunTimeSlider, 'input', (e) => {
      const hourVal = parseFloat(e.target.value);
      el.sunTimeDisplay.textContent = this.ui.formatHourDisplay(hourVal);
      this.mapboxService.setSolarLighting(hourVal);
    });

    this.listen(el.sunNowBtn, 'click', () => {
      if (this.sunAnimationTimer) {
        clearInterval(this.sunAnimationTimer);
        this.sunAnimationTimer = null;
        if (el.sunPlayBtn) el.sunPlayBtn.textContent = '▶ Play';
      }
      const now = new Date();
      const currentHour = now.getHours() + now.getMinutes() / 60;
      const clamped = Math.max(6, Math.min(21, currentHour));
      el.sunTimeSlider.value = clamped;
      el.sunTimeDisplay.textContent = this.ui.formatHourDisplay(clamped);
      this.mapboxService.setSolarLighting(clamped);
    });

    this.listen(el.sunPlayBtn, 'click', () => {
      if (this.sunAnimationTimer) {
        clearInterval(this.sunAnimationTimer);
        this.sunAnimationTimer = null;
        el.sunPlayBtn.textContent = '▶ Play';
      } else {
        el.sunPlayBtn.textContent = '⏸ Pause';
        this.sunAnimationTimer = setInterval(() => {
          if (this.disposed) {
            clearInterval(this.sunAnimationTimer);
            this.sunAnimationTimer = null;
            return;
          }
          let current = parseFloat(el.sunTimeSlider.value) + 0.25;
          if (current > 21) current = 6;
          el.sunTimeSlider.value = current;
          el.sunTimeDisplay.textContent = this.ui.formatHourDisplay(current);
          this.mapboxService.setSolarLighting(current);
        }, 300);
      }
    });

    // --- OpenStreetMap POI Discovery Handlers ---
    this.listen(el.discoverPoiBtn, 'click', () => this.handleDiscoverPois());
    this.listen(el.closePoiModal, 'click', () => this.ui.closePoiModal());
    this.listen(el.importAllPoisBtn, 'click', () => this.importAllPois());
    this.listen(el.poiCategoryPills, 'click', (e) => {
      const pill = e.target.closest('.pill');
      if (!pill) return;
      el.poiCategoryPills.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      this.poiFilter = pill.dataset.poiFilter || 'all';
      this.applyPoiFilter();
    });

    // --- JamBase Venue Search & Selection Handler ---
    this.listen(el.searchJambaseBtn, 'click', () => {
      this.handleJambaseSearch();
    });

    this.listen(el.formJambaseId, 'input', () => {
      if (el.formJambaseSlug) el.formJambaseSlug.value = '';
    });

    this.listen(el.formJambaseId, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (el.searchJambaseBtn) {
          el.searchJambaseBtn.click();
        }
      }
    });

    this.listen(el.closeJambasePickerModal, 'click', () => this.ui.closeJambasePickerModal());

    // --- Global Keyboard Event Handlers (ESC to close modals) ---
    this.listen(typeof document !== 'undefined' ? document : null, 'keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (el.locationModal && !el.locationModal.classList.contains('hidden')) {
          this.closeLocationEditor();
          this.mapboxService.clearTempMarker();
        }
        if (el.settingsModal && !el.settingsModal.classList.contains('hidden')) {
          this.ui.closeSettingsModal();
        }
        if (el.keyPromptModal && !el.keyPromptModal.classList.contains('hidden')) {
          this.ui.closeKeyPromptModal();
        }
        if (el.poiDiscoveryModal && !el.poiDiscoveryModal.classList.contains('hidden')) {
          this.ui.closePoiModal();
        }
        if (el.jambasePickerModal && !el.jambasePickerModal.classList.contains('hidden')) {
          this.ui.closeJambasePickerModal();
        }
      }
    });

    // --- Modal Overlay Backdrop Click Handlers ---
    [el.locationModal, el.settingsModal, el.keyPromptModal, el.poiDiscoveryModal, el.jambasePickerModal].forEach((modal) => {
      this.listen(modal, 'click', (e) => {
        if (e.target === modal) {
          if (modal === el.locationModal) {
            this.closeLocationEditor();
            this.mapboxService.clearTempMarker();
          } else if (modal === el.settingsModal) {
            this.ui.closeSettingsModal();
          } else if (modal === el.keyPromptModal) {
            this.ui.closeKeyPromptModal();
          } else if (modal === el.poiDiscoveryModal) {
            this.ui.closePoiModal();
          } else if (modal === el.jambasePickerModal) {
            this.ui.closeJambasePickerModal();
          }
        }
      });
    });
  }

  /**
   * Handle OpenStreetMap POI Discovery
   */
  async handleDiscoverPois() {
    if (this.disposed) return;
    const generation = this.neighborhoodGeneration;
    const operationId = ++this.poiSearchGeneration;
    let lat = 37.7749;
    let lng = -122.4194;

    if (this.mapboxService.map) {
      const center = this.mapboxService.map.getCenter();
      lat = center.lat;
      lng = center.lng;
    } else if (this.homeAddress) {
      lat = this.homeAddress.lat;
      lng = this.homeAddress.lng;
    }

    this.ui.openPoiModal();
    if (this.ui.elements.poiStatusSubtitle) {
      this.ui.elements.poiStatusSubtitle.textContent = `Searching OpenStreetMap near (${lat.toFixed(3)}, ${lng.toFixed(3)})...`;
    }

    const pois = await OverpassService.fetchNearbyPois(lat, lng, 1500);
    if (!this.isCurrentGeneration(generation) || operationId !== this.poiSearchGeneration) return;
    this.currentDiscoveredPois = pois;
    this.poiDiscoveryGeneration = operationId;

    if (this.ui.elements.poiStatusSubtitle) {
      this.ui.elements.poiStatusSubtitle.textContent = `Found ${this.currentDiscoveredPois.length} public amenities within 1.5km`;
    }

    this.applyPoiFilter();
  }

  applyPoiFilter() {
    if (this.disposed) return;
    if (this.poiDiscoveryGeneration !== this.poiSearchGeneration) return;
    const filtered = this.currentDiscoveredPois.filter(p => {
      if (this.poiFilter === 'all') return true;
      if (this.poiFilter === 'cafe') return p.typeLabel.includes('Cafe');
      if (this.poiFilter === 'park') return p.typeLabel.includes('Park');
      if (this.poiFilter === 'library') return p.typeLabel.includes('Library');
      if (this.poiFilter === 'ev') return p.typeLabel.includes('EV');
      return true;
    });

    this.ui.renderPoiResults(filtered, (poi) => this.importPoi(poi));
  }

  importPoi(poi) {
    if (this.disposed) return;
    if (this.poiDiscoveryGeneration !== this.poiSearchGeneration) return;
    const placeData = {
      name: poi.name,
      category: poi.category,
      people: [],
      contacts: [],
      events: [],
      address: poi.address,
      notes: poi.notes,
      color: poi.color,
      lat: poi.lat,
      lng: poi.lng,
    };

    this.savedPlaces = this.storage.savePlace(placeData);
    this.mapboxService.renderSavedMarkers(this.savedPlaces, (place) => this.openLocationEditor(place));
    this.ui.renderPlacesList(
      this.savedPlaces,
      (place) => this.onPlaceSelected(place),
      (place) => this.openLocationEditor(place)
    );
    this.ui.showToast(`Imported ${poi.name.split('(')[0].trim()} to Saved Places!`, 'success');
  }

  importAllPois() {
    if (this.disposed) return;
    if (this.poiDiscoveryGeneration !== this.poiSearchGeneration) return;
    const filtered = this.currentDiscoveredPois.filter(p => {
      if (this.poiFilter === 'all') return true;
      if (this.poiFilter === 'cafe') return p.typeLabel.includes('Cafe');
      if (this.poiFilter === 'park') return p.typeLabel.includes('Park');
      if (this.poiFilter === 'library') return p.typeLabel.includes('Library');
      if (this.poiFilter === 'ev') return p.typeLabel.includes('EV');
      return true;
    });

    if (filtered.length === 0) return;

    filtered.forEach(poi => {
      const placeData = {
        name: poi.name,
        category: poi.category,
        people: [],
        contacts: [],
        events: [],
        address: poi.address,
        notes: poi.notes,
        color: poi.color,
        lat: poi.lat,
        lng: poi.lng,
      };
      this.savedPlaces = this.storage.savePlace(placeData);
    });

    this.mapboxService.renderSavedMarkers(this.savedPlaces, (place) => this.openLocationEditor(place));
    this.ui.renderPlacesList(
      this.savedPlaces,
      (place) => this.onPlaceSelected(place),
      (place) => this.openLocationEditor(place)
    );
    this.ui.closePoiModal();
    this.ui.showToast(`Successfully imported ${filtered.length} local spots!`, 'success');
  }

  /**
   * Fetch Live Weather via Open-Meteo API
   */
  async fetchAndDisplayWeather() {
    const generation = this.neighborhoodGeneration;
    let lat = 37.7749;
    let lng = -122.4194;

    if (this.homeAddress && this.homeAddress.lat && this.homeAddress.lng) {
      lat = this.homeAddress.lat;
      lng = this.homeAddress.lng;
    }

    const weather = await WeatherService.getWeather(lat, lng);
    if (!this.isCurrentGeneration(generation)) return;
    this.ui.updateWeatherDisplay(weather);
  }

  /**
   * Handle Map Click: Reverse geocode if possible & open editor modal
   */
  async onMapClicked(coords) {
    if (this.disposed) return;
    const generation = this.neighborhoodGeneration;
    const operationId = ++this.locationSelectionGeneration;
    let placeName = '';
    
    try {
      const result = await this.mapboxService.geocodeAddress(`${coords.lng},${coords.lat}`);
      if (result) placeName = result.name;
    } catch (e) {
      console.warn('Reverse geocoding failed', e);
    }

    if (!this.isCurrentGeneration(generation) || operationId !== this.locationSelectionGeneration) return;

    const locationData = {
      lat: coords.lat,
      lng: coords.lng,
      address: placeName,
    };

    this.mapboxService.showTempMarker(coords, () => {
      if (!this.isCurrentGeneration(generation) || operationId !== this.locationSelectionGeneration) return;
      this.openLocationEditor(locationData);
    });

    this.openLocationEditor(locationData);
  }

  /**
   * Address Search Handler
   */
  async handleAddressSearch() {
    if (this.disposed) return;
    const query = this.ui.elements.addressSearchInput.value.trim();
    if (!query) return;
    const generation = this.neighborhoodGeneration;
    const operationId = ++this.locationSelectionGeneration;

    this.ui.showToast(`Searching for "${query}"...`, 'info');
    const result = await this.mapboxService.geocodeAddress(query);
    if (!this.isCurrentGeneration(generation) || operationId !== this.locationSelectionGeneration) return;

    if (result) {
      const coords = { lat: result.lat, lng: result.lng };
      this.mapboxService.flyToLocation(result.lat, result.lng, 16.5);
      
      this.mapboxService.showTempMarker(coords, () => {
        if (!this.isCurrentGeneration(generation) || operationId !== this.locationSelectionGeneration) return;
        this.openLocationEditor({
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
    if (this.disposed) return;
    const generation = this.neighborhoodGeneration;
    const namespaceId = this.storage.getNamespaceId();
    if (!this.mapboxService.map) {
      this.ui.showToast('Mapbox key required to set home from map center.', 'error');
      this.ui.openKeyPromptModal();
      return;
    }
    const center = this.mapboxService.map.getCenter();
    const coords = { lat: center.lat, lng: center.lng };

    this.ui.showToast('Updating Home address...', 'info');
    const geocode = await this.mapboxService.geocodeAddress(`${coords.lng},${coords.lat}`);
    if (!this.isCurrentGeneration(generation) || this.storage.getNamespaceId() !== namespaceId) return;

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
    this.fetchAndDisplayWeather();
    this.ui.showToast(`Home address set to ${homeData.name.split(',')[0]}!`, 'success');
  }

  /**
   * Clear Home. Generation + namespace are captured before `confirm()` so a
   * switch during the dialog cannot clear the replacement owner's home.
   */
  handleClearHome() {
    if (this.disposed) return;
    const generation = this.neighborhoodGeneration;
    const namespaceId = this.storage.getNamespaceId();
    const confirmed = typeof globalThis.confirm === 'function'
      ? globalThis.confirm('Clear configured Home address? App will revert to Earth Globe view.')
      : true;
    if (!confirmed) return;
    if (this.disposed || !this.isSameOwnerGeneration(generation, namespaceId)) {
      this.ui.showToast?.('Account changed. Home was not cleared.', 'error');
      return;
    }
    this.storage.clearHomeAddress();
    this.homeAddress = null;
    this.ui.updateHomeHeaderStatus(null);
    if (this.mapboxService.homeMarker) this.mapboxService.homeMarker.remove();
    this.ui.showToast('Home address cleared', 'info');
  }

  /**
   * Report a typed import outcome even if the owner flipped after FileReader
   * or while the mutation lock was queued. Lock failures keep their own copy.
   */
  reportImportOutcome(result, generation, namespaceId) {
    if (this.disposed) return;
    if (result?.ok) {
      if (!this.isSameOwnerGeneration(generation, namespaceId)) {
        this.ui.showToast('Account changed before import finished. Nothing was written to the new account.', 'warning', 8000);
        return;
      }
      this.ui.showToast('Data imported successfully! Reloading...', 'success');
      this.scheduleTimeout(() => window.location.reload(), 1000);
      return;
    }
    const reason = result?.reason;
    if (reason === 'lock-unavailable' || reason === 'lock-rejected') {
      this.ui.showToast('Import needs a browser storage lock. Try again, or use a browser that supports Web Locks.', 'warning', 8000);
      return;
    }
    if (reason === 'owner-changed' || !this.isSameOwnerGeneration(generation, namespaceId)) {
      this.ui.showToast('Account changed before import finished. Nothing was written to the new account.', 'warning', 8000);
      return;
    }
    if (reason === 'rollback-incomplete') {
      this.ui.showToast('Import did not finish and could not fully undo. Download device recovery and review storage before continuing.', 'error', 10000);
      this.refreshLegacyRecovery();
      return;
    }
    if (reason === 'invalid-document') {
      this.ui.showToast('Failed to import JSON file. Invalid format.', 'error');
      return;
    }
    this.ui.showToast('Failed to import neighborhood data.', 'error');
  }

  /**
   * Delete Location Form Handler. Generation, namespace, and editor stamp are
   * captured before `confirm()` so a colliding id (e.g. `demo-1`) cannot be
   * deleted from the replacement owner after OK.
   */
  handleDeleteLocation() {
    if (this.disposed) {
      this.ui.showToast?.('App is no longer active. That location was not deleted.', 'error');
      return;
    }
    if (!this.editorMatchesCurrentOwner()) {
      this.ui.resetOwnerScopedPresentation?.();
      this.ui.showToast?.('Account changed. That location was not deleted.', 'error');
      return;
    }
    const el = this.ui.elements;
    const id = el.formLocationId.value;
    if (!id) return;

    const generation = this.neighborhoodGeneration;
    const namespaceId = this.storage.getNamespaceId();
    const editorRevision = this.editorRevision;
    const confirmed = typeof globalThis.confirm === 'function'
      ? globalThis.confirm('Are you sure you want to delete this location contact?')
      : true;
    if (!confirmed) return;
    if (this.disposed
      || !this.isSameOwnerGeneration(generation, namespaceId)
      || !this.editorMatchesCurrentRequest(editorRevision)) {
      this.ui.showToast?.('Account changed. That location was not deleted.', 'error');
      return;
    }

    this.savedPlaces = this.storage.deletePlace(id);
    this.mapboxService.renderSavedMarkers(this.savedPlaces, (place) => this.openLocationEditor(place));
    this.ui.renderPlacesList(
      this.savedPlaces,
      (place) => this.onPlaceSelected(place),
      (place) => this.openLocationEditor(place)
    );
    this.closeLocationEditor();
    this.mapboxService.clearTempMarker();
    this.ui.showToast('Location deleted', 'info');
  }

  /**
   * JamBase venue search. Generation, namespace, and the initiating editor
   * revision are captured before the network call and revalidated after every
   * await, before opening the picker, before applying a selection, and before
   * every form mutation.
   */
  async handleJambaseSearch() {
    if (this.disposed) return;
    const el = this.ui.elements;
    const generation = this.neighborhoodGeneration;
    const namespaceId = this.storage.getNamespaceId();
    const editorRevision = this.editorRevision;
    const venueName = el.formName.value.trim();
    const currentInput = el.formJambaseId ? el.formJambaseId.value.trim() : '';
    const query = currentInput || venueName;
    const addressText = el.formAddress ? el.formAddress.value.trim() : '';

    if (!query) {
      this.ui.showToast('Enter a venue name or JamBase ID/URL to search.', 'warning');
      return;
    }

    const searchId = ++this.jambaseSearchGeneration;

    let locationContext = {};
    if (addressText) {
      const parts = addressText.split(',').map(s => s.trim());
      if (parts.length >= 2) {
        locationContext.city = parts[parts.length - 2] || parts[0];
        const stateZip = parts[parts.length - 1].split(' ');
        locationContext.state = stateZip[0] || '';
      } else {
        locationContext.city = parts[0];
      }
    } else if (this.homeAddress && this.homeAddress.name) {
      const parts = this.homeAddress.name.split(',').map(s => s.trim());
      if (parts.length >= 2) {
        locationContext.city = parts[1] || parts[0];
      }
    }

    this.ui.showToast(`Searching JamBase for "${query}"...`, 'info');
    const matches = await JamBaseService.searchVenues(query, locationContext);
    if (!this.isSameOwnerGeneration(generation, namespaceId)
      || !this.editorMatchesCurrentRequest(editorRevision)
      || searchId !== this.jambaseSearchGeneration) return;

    this.ui.openJambasePickerModal();
    if (this.ui.elements.jambasePickerSubtitle) {
      this.ui.elements.jambasePickerSubtitle.textContent = `Found ${matches.length} venue match${matches.length === 1 ? '' : 'es'} for "${query}"`;
    }

    this.ui.renderJambaseSearchResults(matches, async (selectedVenue) => {
      if (!this.isSameOwnerGeneration(generation, namespaceId)
        || !this.editorMatchesCurrentRequest(editorRevision)
        || searchId !== this.jambaseSearchGeneration) return;

      if (el.formJambaseId) el.formJambaseId.value = selectedVenue.id;
      if (el.formJambaseSlug) el.formJambaseSlug.value = selectedVenue.slug || '';

      let capacity = selectedVenue.capacity;
      if (!capacity) {
        const details = await JamBaseService.fetchVenueDetails(selectedVenue.id, selectedVenue.slug);
        if (!this.isSameOwnerGeneration(generation, namespaceId)
        || !this.editorMatchesCurrentRequest(editorRevision)
        || searchId !== this.jambaseSearchGeneration) return;
        if (details && details.capacity) {
          capacity = details.capacity;
        }
      }

      if (!this.isSameOwnerGeneration(generation, namespaceId)
        || !this.editorMatchesCurrentRequest(editorRevision)
        || searchId !== this.jambaseSearchGeneration) return;

      if (capacity && el.formCapacity) {
        el.formCapacity.value = capacity;
      }

      if (el.jambaseStatusMsg) {
        const locText = [selectedVenue.city, selectedVenue.state].filter(Boolean).join(', ');
        const capText = capacity ? ` | Cap: ${capacity}` : '';
        el.jambaseStatusMsg.textContent = `✓ Linked to ${selectedVenue.name} ${locText ? `(${locText})` : ''}${capText}`;
      }
      this.ui.showToast(`Linked venue to ${selectedVenue.name}${capacity ? ` (Cap: ${capacity})` : ''}!`, 'success');
    });
  }

  /**
   * Save Location Form Handler
   */
  handleSaveLocation() {
    if (this.disposed) {
      this.ui.showToast?.('App is no longer active. That location was not saved.', 'error');
      return;
    }
    if (!this.editorMatchesCurrentOwner()) {
      this.ui.resetOwnerScopedPresentation?.();
      this.ui.showToast?.('Account changed. That location was not saved.', 'error');
      return;
    }
    const el = this.ui.elements;
    const name = el.formName.value.trim() || `Location (${parseFloat(el.formLat.value).toFixed(3)}, ${parseFloat(el.formLng.value).toFixed(3)})`;

    const colorRadio = el.locationForm.querySelector('input[name="form-color"]:checked');
    const existingId = el.formLocationId.value.trim();
    const people = this.ui.getPeopleFieldsData();
    const contacts = this.ui.getContactFieldsData();
    const events = this.ui.getEventFieldsData();

    const rawJambaseId = el.formJambaseId ? el.formJambaseId.value.trim() : (el.formPollstarId ? el.formPollstarId.value.trim() : '');
    const jambaseId = JamBaseService.toJamBaseVenueId(rawJambaseId) || rawJambaseId;
    const explicitJambaseSlug = el.formJambaseSlug ? el.formJambaseSlug.value.trim() : '';
    const derivedJambaseSlug = rawJambaseId && !/^jambase:\d+$/i.test(rawJambaseId)
      ? JamBaseService.extractVenueId(rawJambaseId)
      : '';
    const jambaseSlug = JamBaseService.extractVenueId(explicitJambaseSlug) || derivedJambaseSlug;
    const capacityVal = el.formCapacity ? el.formCapacity.value.trim() : '';

    const placeData = {
      id: existingId ? existingId : undefined,
      lat: parseFloat(el.formLat.value),
      lng: parseFloat(el.formLng.value),
      name: name,
      category: el.formCategory.value,
      capacity: el.formCategory.value === 'venue' ? capacityVal : '',
      jambaseId: jambaseId,
      jambaseSlug: jambaseSlug,
      people: people,
      contacts: contacts,
      events: events,
      address: el.formAddress.value.trim(),
      notes: el.formNotes.value.trim(),
      color: colorRadio ? colorRadio.value : '#3b82f6',
    };

    this.savedPlaces = this.storage.savePlace(placeData);

    // Clear temporary pin & coords reset
    this.mapboxService.clearTempMarker();
    this.mapboxService.currentTempCoords = null;

    // Update map markers & sidebar list
    this.mapboxService.renderSavedMarkers(this.savedPlaces, (place) => this.openLocationEditor(place));
    this.ui.renderPlacesList(
      this.savedPlaces,
      (place) => this.onPlaceSelected(place),
      (place) => this.openLocationEditor(place)
    );

    this.closeLocationEditor();
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
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const app = new NeighborhoodGuruApp();
    app.init().catch((err) => {
      if (app.disposed) return;
      console.warn('Neighborhood Guru failed to initialize', err);
    });
    if (import.meta.hot) {
      import.meta.hot.dispose(() => app.dispose());
    }
  });
}
