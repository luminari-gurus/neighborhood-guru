import { getPlaceContacts, getPlacePeople, getPlaceEvents, isEventHappeningToday } from './storage.js';
import { JamBaseService } from './jambase-service.js';

export class UIController {
  constructor() {
    this.elements = {};
    this.currentFilter = 'all';
    this.searchQuery = '';
    this.disposed = false;
    this.listeners = [];
    this.timeouts = [];
    this._placesById = new Map();
    this._onPlaceClick = null;
    this._onEditClick = null;
    this._onPoiImport = null;
    this._discoveredPois = [];
    this._jambaseMatches = [];
    this._onJambaseSelect = null;
    this._delegated = false;
  }

  listen(target, type, handler) {
    if (this.disposed || !target || typeof target.addEventListener !== 'function') return;
    const wrapped = (...args) => {
      if (this.disposed) return;
      handler(...args);
    };
    target.addEventListener(type, wrapped);
    this.listeners.push({ target, type, handler: wrapped });
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
    for (const { target, type, handler } of this.listeners) {
      try {
        target.removeEventListener(type, handler);
      } catch {
        // Node may already be gone.
      }
    }
    this.listeners = [];
    for (const id of this.timeouts) {
      try {
        clearTimeout(id);
      } catch {
        // Timer may already have fired.
      }
    }
    this.timeouts = [];
    this._onPlaceClick = null;
    this._onEditClick = null;
    this._onPoiImport = null;
    this._onJambaseSelect = null;
    this._placesById.clear();
    this._discoveredPois = [];
    this._jambaseMatches = [];
    this.resetOwnerScopedPresentation?.();
    try {
      if (this.elements.savedPlacesList) this.elements.savedPlacesList.innerHTML = '';
      if (this.elements.poiResultsContainer) this.elements.poiResultsContainer.innerHTML = '';
      if (this.elements.jambasePickerResultsContainer) this.elements.jambasePickerResultsContainer.innerHTML = '';
      if (this.elements.peopleListContainer) this.elements.peopleListContainer.innerHTML = '';
      if (this.elements.contactMethodsContainer) this.elements.contactMethodsContainer.innerHTML = '';
      if (this.elements.eventsListContainer) this.elements.eventsListContainer.innerHTML = '';
    } catch {
      // Nodes may already be gone.
    }
  }

  init() {
    this.cacheElements();
    this.bindDelegatedEvents();
    this.bindPeopleFieldEvents();
    this.bindContactFieldEvents();
    this.bindEventFieldEvents();

    if (this.elements.formCategory) {
      this.listen(this.elements.formCategory, 'change', () => {
        this.updateCategoryFields(this.elements.formCategory.value);
      });
    }
  }

  bindDelegatedEvents() {
    if (this._delegated) return;
    this._delegated = true;
    this.listen(this.elements.savedPlacesList, 'click', (e) => {
      if (this.disposed) return;
      const refreshBtn = e.target.closest('.card-refresh-jb-btn');
      if (refreshBtn) {
        e.stopPropagation();
        const box = refreshBtn.closest('.jb-card-shows-box');
        const jbId = box?.dataset?.jambaseId;
        const listEl = box?.querySelector('.jb-card-shows-list');
        if (!jbId || !listEl) return;
        listEl.innerHTML = `<span style="font-size: 0.72rem; color: #a855f7;">Refreshing JamBase schedule...</span>`;
        JamBaseService.fetchUpcomingShows(jbId, true).then((shows) => {
          if (this.disposed || !listEl.isConnected) return;
          this.renderSidebarJamBaseShows(listEl, shows);
        });
        return;
      }
      if (e.target.closest('a')) {
        e.stopPropagation();
        return;
      }
      const editBtn = e.target.closest('.edit-place-btn');
      const flyBtn = e.target.closest('.fly-place-btn');
      const card = e.target.closest('.place-card');
      const id = card?.dataset?.id;
      const place = id ? this._placesById.get(id) : null;
      if (!place) return;
      if (editBtn) {
        e.stopPropagation();
        this._onEditClick?.(place);
        return;
      }
      if (flyBtn) {
        e.stopPropagation();
        this._onPlaceClick?.(place);
        return;
      }
      this._onPlaceClick?.(place);
    });
    this.listen(this.elements.poiResultsContainer, 'click', (e) => {
      if (this.disposed) return;
      const btn = e.target.closest('.btn-import-single');
      if (!btn) return;
      const card = btn.closest('.poi-item-card');
      const index = Number(card?.dataset?.index);
      const poi = this._discoveredPois[index];
      if (!poi) return;
      this._onPoiImport?.(poi);
      card.style.opacity = '0.5';
      btn.textContent = '✓ Imported';
      btn.disabled = true;
    });
    this.listen(this.elements.jambasePickerResultsContainer, 'click', (e) => {
      if (this.disposed) return;
      const btn = e.target.closest('.btn-select-venue');
      if (!btn) return;
      const card = btn.closest('.poi-item-card');
      const index = Number(card?.dataset?.index);
      const venue = this._jambaseMatches[index];
      if (!venue) return;
      this._onJambaseSelect?.(venue);
      this.closeJambasePickerModal();
    });
    this.listen(this.elements.peopleListContainer, 'click', (e) => {
      if (this.disposed) return;
      const btn = e.target.closest('.btn-remove-row');
      if (btn) btn.closest('.person-row')?.remove();
    });
    this.listen(this.elements.contactMethodsContainer, 'click', (e) => {
      if (this.disposed) return;
      const btn = e.target.closest('.btn-remove-row');
      if (btn) btn.closest('.contact-method-row')?.remove();
    });
    this.listen(this.elements.contactMethodsContainer, 'change', (e) => {
      if (this.disposed) return;
      const select = e.target.closest('.contact-type-select');
      if (!select) return;
      const row = select.closest('.contact-method-row');
      const valueInput = row?.querySelector('.contact-value-input');
      if (valueInput) {
        valueInput.placeholder = select.value.startsWith('email') ? 'e.g. name@example.com' : 'e.g. (555) 000-0000';
      }
    });
    this.listen(this.elements.eventsListContainer, 'click', (e) => {
      if (this.disposed) return;
      const btn = e.target.closest('.btn-remove-row');
      if (btn) btn.closest('.event-row')?.remove();
    });
  }

  renderSidebarJamBaseShows(listEl, shows) {
    if (this.disposed || !listEl) return;
    if (shows && shows.length > 0) {
      listEl.innerHTML = shows.map((s) => `
            <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 3px; font-size: 0.75rem; color: ${s.isToday ? '#fbbf24' : '#e2e8f0'}; font-weight: ${s.isToday ? '700' : '400'};">
              <span>${s.isToday ? '🔥 TODAY: ' : '📅 '}<a href="${s.url}" target="_blank" rel="noopener noreferrer" style="color: ${s.isToday ? '#fbbf24' : '#c084fc'}; text-decoration: none;">${this.escapeHtml(s.title)}</a></span>
              <span style="font-size: 0.7rem; color: #94a3b8; white-space: nowrap;">${this.escapeHtml(s.date)}${s.time ? ` ${this.escapeHtml(s.time)}` : ''}</span>
            </div>
          `).join('');
    } else {
      listEl.innerHTML = `<p style="font-size: 0.72rem; color: #94a3b8; font-style: italic;">No upcoming shows listed on JamBase.</p>`;
    }
  }

  updateCategoryFields(category) {
    const isVenue = category === 'venue';
    if (this.elements.formJambaseContainer) {
      if (isVenue) {
        this.elements.formJambaseContainer.classList.remove('hidden');
      } else {
        this.elements.formJambaseContainer.classList.add('hidden');
      }
    }
    if (this.elements.formCapacityContainer) {
      if (isVenue) {
        this.elements.formCapacityContainer.classList.remove('hidden');
      } else {
        this.elements.formCapacityContainer.classList.add('hidden');
      }
    }
  }

  cacheElements() {
    this.elements = {
      // Header
      homeStatusSubtitle: document.getElementById('home-status-subtitle'),
      addressSearchInput: document.getElementById('address-search-input'),
      searchGoBtn: document.getElementById('search-go-btn'),
      addLocationBtn: document.getElementById('add-location-btn'),
      setHomeBtn: document.getElementById('set-home-btn'),
      flyHomeBtn: document.getElementById('fly-home-btn'),
      flyGlobeBtn: document.getElementById('fly-globe-btn'),
      styleSwitcher: document.getElementById('style-switcher'),
      toggle3dBtn: document.getElementById('toggle-3d-btn'),
      toggleSidebarBtn: document.getElementById('toggle-sidebar-btn'),
      placesCountBadge: document.getElementById('places-count-badge'),
      openSettingsBtn: document.getElementById('open-settings-btn'),

      // Map Hint Banner
      mapHintBanner: document.getElementById('map-hint-banner'),
      dismissHintBtn: document.getElementById('dismiss-hint-btn'),

      // Location Modal & Form
      locationModal: document.getElementById('location-modal'),
      closeLocationModal: document.getElementById('close-location-modal'),
      cancelLocationBtn: document.getElementById('cancel-location-btn'),
      deleteLocationBtn: document.getElementById('delete-location-btn'),
      locationForm: document.getElementById('location-form'),
      locationModalTitle: document.getElementById('location-modal-title'),
      locationModalCoords: document.getElementById('location-modal-coords'),
      formLocationId: document.getElementById('form-location-id'),
      formLat: document.getElementById('form-lat'),
      formLng: document.getElementById('form-lng'),
      formName: document.getElementById('form-name'),
      formCategory: document.getElementById('form-category'),
      formJambaseContainer: document.getElementById('form-jambase-container'),
      formCapacityContainer: document.getElementById('form-capacity-container'),
      formCapacity: document.getElementById('form-capacity'),
      formJambaseId: document.getElementById('form-jambase-id'),
      searchJambaseBtn: document.getElementById('search-jambase-btn'),
      jambaseStatusMsg: document.getElementById('jambase-status-msg'),
      addPersonFieldBtn: document.getElementById('add-person-field-btn'),
      peopleListContainer: document.getElementById('people-list-container'),
      addContactFieldBtn: document.getElementById('add-contact-field-btn'),
      contactMethodsContainer: document.getElementById('contact-methods-container'),
      addEventFieldBtn: document.getElementById('add-event-field-btn'),
      eventsListContainer: document.getElementById('events-list-container'),
      formAddress: document.getElementById('form-address'),
      formNotes: document.getElementById('form-notes'),

      // Sidebar Drawer
      placesSidebar: document.getElementById('places-sidebar'),
      sidebarAddBtn: document.getElementById('sidebar-add-btn'),
      closeSidebarBtn: document.getElementById('close-sidebar-btn'),
      sidebarSearchInput: document.getElementById('sidebar-search-input'),
      sidebarFilterPills: document.getElementById('sidebar-filter-pills'),
      savedPlacesList: document.getElementById('saved-places-list'),
      exportDataBtn: document.getElementById('export-data-btn'),
      importFileInput: document.getElementById('import-file-input'),
      exportDeviceRecoveryBtn: document.getElementById('export-device-recovery-btn'),
      restoreLegacyBtn: document.getElementById('restore-legacy-btn'),
      legacyRecoveryBanner: document.getElementById('legacy-recovery-banner'),
      legacyRecoveryMessage: document.getElementById('legacy-recovery-message'),

      // Settings Modal
      settingsModal: document.getElementById('settings-modal'),
      closeSettingsModal: document.getElementById('close-settings-modal'),
      cancelSettingsBtn: document.getElementById('cancel-settings-btn'),
      saveSettingsBtn: document.getElementById('save-settings-btn'),
      settingsMapboxToken: document.getElementById('settings-mapbox-token'),
      settingsJambaseToken: document.getElementById('settings-jambase-token'),
      currentHomeDisplay: document.getElementById('current-home-display'),
      clearHomeBtn: document.getElementById('clear-home-btn'),

      // Key Prompt Modal & Warning Banner
      keyPromptModal: document.getElementById('key-prompt-modal'),
      closeKeyPromptModal: document.getElementById('close-key-prompt-modal'),
      dismissKeyPromptBtn: document.getElementById('dismiss-key-prompt-btn'),
      saveKeyPromptBtn: document.getElementById('save-key-prompt-btn'),
      promptMapboxToken: document.getElementById('prompt-mapbox-token'),
      keyWarningBanner: document.getElementById('key-warning-banner'),
      bannerOpenKeyModalBtn: document.getElementById('banner-open-key-modal-btn'),
      keyWarningDot: document.getElementById('key-warning-dot'),

      // Weather Header Pill
      weatherHeaderPill: document.getElementById('weather-header-pill'),
      weatherIcon: document.getElementById('weather-icon'),
      weatherTemp: document.getElementById('weather-temp'),
      weatherDesc: document.getElementById('weather-desc'),

      // 3D Solar Light Controller
      sunLightController: document.getElementById('sun-light-controller'),
      sunTimeSlider: document.getElementById('sun-time-slider'),
      sunTimeDisplay: document.getElementById('sun-time-display'),
      sunPlayBtn: document.getElementById('sun-play-btn'),
      sunNowBtn: document.getElementById('sun-now-btn'),

      // OpenStreetMap POI Discovery Modal
      discoverPoiBtn: document.getElementById('discover-poi-btn'),
      poiDiscoveryModal: document.getElementById('poi-discovery-modal'),
      closePoiModal: document.getElementById('close-poi-modal'),
      poiStatusSubtitle: document.getElementById('poi-status-subtitle'),
      poiCategoryPills: document.getElementById('poi-category-pills'),
      importAllPoisBtn: document.getElementById('import-all-pois-btn'),
      poiCountNum: document.getElementById('poi-count-num'),
      poiResultsContainer: document.getElementById('poi-results-container'),

      // JamBase Venue Selector Modal
      jambasePickerModal: document.getElementById('jambase-picker-modal'),
      closeJambasePickerModal: document.getElementById('close-jambase-picker-modal'),
      jambasePickerSubtitle: document.getElementById('jambase-picker-subtitle'),
      jambasePickerResultsContainer: document.getElementById('jambase-picker-results-container'),

      // Toasts
      toastContainer: document.getElementById('toast-container'),
    };
  }

  /**
   * Header Status Updates
   */
  updateHomeHeaderStatus(homeAddress) {
    if (this.disposed) return;
    if (!this.elements?.homeStatusSubtitle) return;
    if (homeAddress && homeAddress.name) {
      const shortAddr = homeAddress.name.split(',')[0];
      this.elements.homeStatusSubtitle.textContent = `Home: ${shortAddr}`;
      this.elements.homeStatusSubtitle.style.color = '#10b981';
      if (this.elements.currentHomeDisplay) this.elements.currentHomeDisplay.textContent = homeAddress.name;
      this.elements.clearHomeBtn?.classList.remove('hidden');
    } else {
      this.elements.homeStatusSubtitle.textContent = 'Earth Globe View';
      this.elements.homeStatusSubtitle.style.color = '#3b82f6';
      if (this.elements.currentHomeDisplay) this.elements.currentHomeDisplay.textContent = 'No Home address configured yet';
      this.elements.clearHomeBtn?.classList.add('hidden');
    }
  }

  updateWeatherDisplay(weatherData) {
    if (!this.elements.weatherHeaderPill) return;
    if (!weatherData) {
      this.elements.weatherHeaderPill.classList.add('hidden');
      return;
    }
    this.elements.weatherIcon.textContent = weatherData.icon || '☀️';
    this.elements.weatherTemp.textContent = `${weatherData.temp}${weatherData.tempUnit || '°F'}`;
    this.elements.weatherDesc.textContent = weatherData.desc || 'Fair';
    this.elements.weatherHeaderPill.classList.remove('hidden');
  }

  formatHourDisplay(hourVal) {
    const totalMinutes = Math.round(parseFloat(hourVal) * 60);
    const hrs = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const padMins = mins < 10 ? `0${mins}` : mins;

    let ampm = 'AM';
    let h12 = hrs;
    if (hrs >= 12) {
      ampm = 'PM';
      if (hrs > 12) h12 = hrs - 12;
    }
    if (h12 === 0) h12 = 12;

    return `${h12}:${padMins} ${ampm}`;
  }

  /**
   * OpenStreetMap POI Discovery Modal Controls
   */
  openPoiModal() {
    if (this.elements.poiDiscoveryModal) {
      this.elements.poiDiscoveryModal.classList.remove('hidden');
    }
  }

  closePoiModal() {
    if (this.elements.poiDiscoveryModal) {
      this.elements.poiDiscoveryModal.classList.add('hidden');
    }
  }

  renderPoiResults(pois = [], onImportClick = null) {
    if (this.disposed) return;
    const container = this.elements.poiResultsContainer;
    if (!container) return;
    this._onPoiImport = onImportClick;
    this._discoveredPois = Array.isArray(pois) ? pois : [];
    container.innerHTML = '';

    if (this.elements.poiCountNum) {
      this.elements.poiCountNum.textContent = pois.length;
    }

    if (this.elements.importAllPoisBtn) {
      if (pois.length > 0) {
        this.elements.importAllPoisBtn.classList.remove('hidden');
      } else {
        this.elements.importAllPoisBtn.classList.add('hidden');
      }
    }

    if (pois.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>No new public spots found around this location. Try panning the map or selecting a different category!</p>
        </div>
      `;
      return;
    }

    pois.forEach((poi, index) => {
      const card = document.createElement('div');
      card.className = 'poi-item-card';
      card.dataset.index = String(index);

      card.innerHTML = `
        <div class="poi-title-group">
          <span class="poi-name">${this.escapeHtml(poi.name)}</span>
          <div class="poi-meta">
            <span style="color: ${poi.color || '#3b82f6'}; font-weight: 600;">${this.escapeHtml(poi.typeLabel)}</span>
            ${poi.address ? `<span>📍 ${this.escapeHtml(poi.address)}</span>` : ''}
          </div>
        </div>
        <button class="btn btn-secondary btn-sm btn-import-single" style="white-space: nowrap;">
          + Import Spot
        </button>
      `;

      container.appendChild(card);
    });
  }

  /**
   * JamBase Venue Match Selector Modal Controls
   */
  openJambasePickerModal() {
    if (this.elements.jambasePickerModal) {
      this.elements.jambasePickerModal.classList.remove('hidden');
    }
  }

  closeJambasePickerModal() {
    if (this.elements.jambasePickerModal) {
      this.elements.jambasePickerModal.classList.add('hidden');
    }
  }

  renderJambaseSearchResults(matches = [], onSelect = null) {
    if (this.disposed) return;
    const container = this.elements.jambasePickerResultsContainer;
    if (!container) return;
    this._onJambaseSelect = onSelect;
    this._jambaseMatches = Array.isArray(matches) ? matches : [];
    container.innerHTML = '';

    if (!matches || matches.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <p>No matching venues found on JamBase. Try refining the search name or pasting the direct JamBase venue URL.</p>
        </div>
      `;
      return;
    }

    matches.forEach((venue, index) => {
      const card = document.createElement('div');
      card.className = 'poi-item-card';
      card.dataset.index = String(index);

      const locationBadge = [venue.city, venue.state].filter(Boolean).join(', ');

      card.innerHTML = `
        <div class="poi-title-group" style="gap: 4px;">
          <span class="poi-name" style="color: #c084fc; font-size: 0.98rem; font-weight: 700;">🎸 ${this.escapeHtml(venue.name)}</span>
          <div class="poi-meta" style="flex-wrap: wrap; gap: 8px; font-size: 0.78rem;">
            ${locationBadge ? `<span style="color: #10b981; font-weight: 600;">📍 ${this.escapeHtml(locationBadge)}</span>` : ''}
            ${venue.address && venue.address !== locationBadge ? `<span style="color: #94a3b8;">🏢 ${this.escapeHtml(venue.address)}</span>` : ''}
            ${venue.type ? `<span style="color: #60a5fa;">🎭 ${this.escapeHtml(venue.type)}</span>` : ''}
            ${venue.capacity ? `<span style="color: #fbbf24;">👥 Cap: ${this.escapeHtml(venue.capacity)}</span>` : ''}
            <span style="font-family: monospace; font-size: 0.72rem; color: #64748b; background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 4px;">ID: ${this.escapeHtml(venue.id)}</span>
          </div>
        </div>
        <button class="btn btn-primary btn-sm btn-select-venue" style="white-space: nowrap; margin-left: 8px;">
          ✓ Select Venue
        </button>
      `;

      container.appendChild(card);
    });
  }

  /**
   * Dynamic People Management
   */
  bindPeopleFieldEvents() {
    if (this.elements.addPersonFieldBtn) {
      this.listen(this.elements.addPersonFieldBtn, 'click', () => {
        this.addPersonRow('');
      });
    }
  }

  renderPeopleFields(people = []) {
    const container = this.elements.peopleListContainer;
    if (!container) return;
    container.innerHTML = '';

    const list = Array.isArray(people) && people.length > 0 ? people : [''];
    list.forEach(p => this.addPersonRow(p || ''));
  }

  addPersonRow(name = '') {
    if (this.disposed) return;
    const container = this.elements.peopleListContainer;
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'person-row';

    row.innerHTML = `
      <input type="text" class="person-name-input" placeholder="e.g. Sarah, John, Vickie" value="${this.escapeHtml(name)}" />
      <button type="button" class="btn-remove-row" title="Remove person">&times;</button>
    `;

    container.appendChild(row);
  }

  getPeopleFieldsData() {
    if (!this.elements.peopleListContainer) return [];
    const rows = this.elements.peopleListContainer.querySelectorAll('.person-row');
    const people = [];
    rows.forEach(row => {
      const val = row.querySelector('.person-name-input').value.trim();
      if (val) {
        people.push(val);
      }
    });
    return people;
  }

  /**
   * Dynamic Contact Fields Management
   */
  bindContactFieldEvents() {
    if (this.elements.addContactFieldBtn) {
      this.listen(this.elements.addContactFieldBtn, 'click', () => {
        this.addContactRow('phone_mobile', '', '');
      });
    }
  }

  renderContactFields(contacts = []) {
    const container = this.elements.contactMethodsContainer;
    if (!container) return;
    container.innerHTML = '';

    const list = Array.isArray(contacts) && contacts.length > 0 ? contacts : [{ type: 'phone_mobile', label: '', value: '' }];
    list.forEach(c => this.addContactRow(c.type || 'phone_mobile', c.label || '', c.value || ''));
  }

  addContactRow(type = 'phone_mobile', label = '', value = '') {
    if (this.disposed) return;
    const container = this.elements.contactMethodsContainer;
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'contact-method-row';

    const isEmail = type.startsWith('email');

    row.innerHTML = `
      <select class="contact-type-select">
        <option value="phone_mobile" ${type === 'phone_mobile' ? 'selected' : ''}>📱 Mobile</option>
        <option value="phone_home" ${type === 'phone_home' ? 'selected' : ''}>📞 Home Phone</option>
        <option value="phone_work" ${type === 'phone_work' ? 'selected' : ''}>💼 Work Phone</option>
        <option value="email_personal" ${type === 'email_personal' ? 'selected' : ''}>✉️ Personal Email</option>
        <option value="email_work" ${type === 'email_work' ? 'selected' : ''}>🏢 Work Email</option>
        <option value="other" ${type === 'other' ? 'selected' : ''}>📌 Other Contact</option>
      </select>
      <input type="text" class="contact-label-input" placeholder="Label (e.g. Vickie cell)" value="${this.escapeHtml(label)}" />
      <input type="text" class="contact-value-input" placeholder="${isEmail ? 'e.g. name@example.com' : 'e.g. (555) 000-0000'}" value="${this.escapeHtml(value)}" />
      <button type="button" class="btn-remove-row" title="Remove method">&times;</button>
    `;

    container.appendChild(row);
  }

  getContactFieldsData() {
    if (!this.elements.contactMethodsContainer) return [];
    const rows = this.elements.contactMethodsContainer.querySelectorAll('.contact-method-row');
    const contacts = [];
    rows.forEach(row => {
      const type = row.querySelector('.contact-type-select').value;
      const label = row.querySelector('.contact-label-input').value.trim();
      const value = row.querySelector('.contact-value-input').value.trim();
      if (value || label) {
        contacts.push({ type, label, value });
      }
    });
    return contacts;
  }

  /**
   * Dynamic Events & Schedules Management
   */
  bindEventFieldEvents() {
    if (this.elements.addEventFieldBtn) {
      this.listen(this.elements.addEventFieldBtn, 'click', () => {
        this.addEventRow({ title: '', day: 'friday', time: '' });
      });
    }
  }

  renderEventFields(events = []) {
    const container = this.elements.eventsListContainer;
    if (!container) return;
    container.innerHTML = '';

    const list = Array.isArray(events) && events.length > 0 ? events : [];
    list.forEach(e => this.addEventRow(e));
  }

  addEventRow(eventObj = { title: '', day: 'friday', time: '' }) {
    if (this.disposed) return;
    const container = this.elements.eventsListContainer;
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'event-row';

    const day = eventObj.day || 'friday';

    row.innerHTML = `
      <input type="text" class="event-title-input" placeholder="Event (e.g. Farmer's Market)" value="${this.escapeHtml(eventObj.title || '')}" />
      <select class="event-day-select">
        <option value="daily" ${day === 'daily' ? 'selected' : ''}>Every Day</option>
        <option value="weekdays" ${day === 'weekdays' ? 'selected' : ''}>Weekdays</option>
        <option value="weekends" ${day === 'weekends' ? 'selected' : ''}>Weekends</option>
        <option value="monday" ${day === 'monday' ? 'selected' : ''}>Every Monday</option>
        <option value="tuesday" ${day === 'tuesday' ? 'selected' : ''}>Every Tuesday</option>
        <option value="wednesday" ${day === 'wednesday' ? 'selected' : ''}>Every Wednesday</option>
        <option value="thursday" ${day === 'thursday' ? 'selected' : ''}>Every Thursday</option>
        <option value="friday" ${day === 'friday' ? 'selected' : ''}>Every Friday</option>
        <option value="saturday" ${day === 'saturday' ? 'selected' : ''}>Every Saturday</option>
        <option value="sunday" ${day === 'sunday' ? 'selected' : ''}>Every Sunday</option>
      </select>
      <input type="text" class="event-time-input" placeholder="Time (e.g. 8am-1pm)" value="${this.escapeHtml(eventObj.time || '')}" />
      <button type="button" class="btn-remove-row" title="Remove event">&times;</button>
    `;

    container.appendChild(row);
  }

  getEventFieldsData() {
    if (!this.elements.eventsListContainer) return [];
    const rows = this.elements.eventsListContainer.querySelectorAll('.event-row');
    const events = [];
    rows.forEach(row => {
      const title = row.querySelector('.event-title-input').value.trim();
      const day = row.querySelector('.event-day-select').value;
      const time = row.querySelector('.event-time-input').value.trim();
      if (title) {
        events.push({ title, day, time });
      }
    });
    return events;
  }

  /**
   * Location Editor Modal Controls
   */
  openLocationModal(data = {}) {
    if (this.disposed) return;
    const isEdit = Boolean(data.id);
    this.elements.locationModalTitle.textContent = isEdit ? 'Edit Location Details' : 'Add Neighborhood Location';
    
    // Explicitly set ID: empty string for new locations to prevent overwriting existing markers
    this.elements.formLocationId.value = isEdit ? String(data.id) : '';
    this.elements.formLat.value = data.lat || '';
    this.elements.formLng.value = data.lng || '';

    this.elements.locationModalCoords.textContent = `Coordinates: ${Number(data.lat).toFixed(5)}, ${Number(data.lng).toFixed(5)}`;
    this.elements.formName.value = data.name || '';
    const categoryVal = data.category || 'neighbor';
    this.elements.formCategory.value = categoryVal;
    this.updateCategoryFields(categoryVal);

    if (this.elements.formCapacity) {
      this.elements.formCapacity.value = data.capacity || '';
    }

    const jbId = data.jambaseId || data.pollstarId || '';
    if (this.elements.formJambaseId) {
      this.elements.formJambaseId.value = jbId;
    }
    if (this.elements.jambaseStatusMsg) {
      this.elements.jambaseStatusMsg.textContent = jbId ? `✓ Linked to JamBase Venue (${jbId})` : '';
    }

    // Populate dynamic People fields
    const people = getPlacePeople(data);
    this.renderPeopleFields(people);

    // Populate dynamic contact fields with custom labels
    const contacts = getPlaceContacts(data);
    this.renderContactFields(contacts);

    // Populate dynamic Recurring Event fields
    const events = getPlaceEvents(data);
    this.renderEventFields(events);

    this.elements.formAddress.value = data.address || '';
    this.elements.formNotes.value = data.notes || '';

    // Color radios
    const color = data.color || '#3b82f6';
    const colorRadio = this.elements.locationForm.querySelector(`input[name="form-color"][value="${color}"]`);
    if (colorRadio) colorRadio.checked = true;

    if (isEdit) {
      this.elements.deleteLocationBtn.classList.remove('hidden');
    } else {
      this.elements.deleteLocationBtn.classList.add('hidden');
    }

    this.elements.locationModal.classList.remove('hidden');
  }

  closeLocationModal() {
    this.elements?.locationModal?.classList?.add('hidden');
  }

  resetLocationEditor() {
    const el = this.elements || {};
    if (el.locationForm && typeof el.locationForm.reset === 'function') {
      el.locationForm.reset();
    }
    for (const field of [
      'formLocationId', 'formLat', 'formLng', 'formName', 'formCategory',
      'formAddress', 'formNotes', 'formCapacity', 'formJambaseId', 'formPollstarId',
    ]) {
      if (el[field]) el[field].value = '';
    }
    if (el.locationModalCoords) el.locationModalCoords.textContent = '';
    if (el.jambaseStatusMsg) el.jambaseStatusMsg.textContent = '';
    if (el.peopleListContainer) el.peopleListContainer.innerHTML = '';
    if (el.contactMethodsContainer) el.contactMethodsContainer.innerHTML = '';
    if (el.eventsListContainer) el.eventsListContainer.innerHTML = '';
    if (el.poiResultsContainer) el.poiResultsContainer.innerHTML = '';
    if (el.jambasePickerResultsContainer) el.jambasePickerResultsContainer.innerHTML = '';
    this.closeLocationModal();
  }

  /**
   * Close owner-scoped editors so an account switch cannot leak or submit
   * another namespace's contacts, notes, or coordinates.
   */
  resetOwnerScopedPresentation() {
    this.resetLocationEditor();
    this.closePoiModal();
    this.closeJambasePickerModal();
  }

  /**
   * Sidebar Drawer Controls
   */
  toggleSidebar(open = null) {
    if (open === true) {
      this.elements.placesSidebar.classList.add('open');
    } else if (open === false) {
      this.elements.placesSidebar.classList.remove('open');
    } else {
      this.elements.placesSidebar.classList.toggle('open');
    }
  }

  /**
   * Render Saved Places Sidebar List
   */
  renderPlacesList(places = [], onPlaceClick = null, onEditClick = null) {
    if (this.disposed) return;
    if (!this.elements?.placesCountBadge || !this.elements?.savedPlacesList) return;
    this._onPlaceClick = onPlaceClick;
    this._onEditClick = onEditClick;
    this._placesById = new Map((places || []).map((place) => [String(place.id), place]));
    this.elements.placesCountBadge.textContent = places.length;
    const listContainer = this.elements.savedPlacesList;
    listContainer.innerHTML = '';

    // Apply Filter & Search Query
    const filtered = places.filter((p) => {
      const eventsList = getPlaceEvents(p);
      const isToday = eventsList.some(isEventHappeningToday);

      let matchesCategory = false;
      if (this.currentFilter === 'all') {
        matchesCategory = true;
      } else if (this.currentFilter === 'today') {
        matchesCategory = isToday;
      } else {
        matchesCategory = p.category === this.currentFilter;
      }

      const q = this.searchQuery.toLowerCase();
      const peopleList = getPlacePeople(p);
      const contactList = getPlaceContacts(p);

      const matchesSearch =
        !q ||
        (p.name && p.name.toLowerCase().includes(q)) ||
        peopleList.some(person => person.toLowerCase().includes(q)) ||
        contactList.some(c => (c.value && c.value.toLowerCase().includes(q)) || (c.label && c.label.toLowerCase().includes(q))) ||
        eventsList.some(e => (e.title && e.title.toLowerCase().includes(q)) || (e.day && e.day.toLowerCase().includes(q))) ||
        (p.notes && p.notes.toLowerCase().includes(q));

      return matchesCategory && matchesSearch;
    });

    if (filtered.length === 0) {
      listContainer.innerHTML = `
        <div class="empty-state">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          <p>No matching locations found.</p>
        </div>
      `;
      return;
    }

    filtered.forEach((place) => {
      const card = document.createElement('div');
      card.className = 'place-card';
      card.dataset.id = place.id;

      const people = getPlacePeople(place);
      const contacts = getPlaceContacts(place);
      const events = getPlaceEvents(place);

      let peopleHtml = '';
      if (people.length > 0) {
        peopleHtml = `<div class="contact-row">👥 <strong style="font-size: 0.75rem; color: #94a3b8;">People:</strong> ${people.map(p => this.escapeHtml(p)).join(', ')}</div>`;
      }

      let eventsHtml = '';
      if (events.length > 0) {
        events.forEach(e => {
          const activeToday = isEventHappeningToday(e);
          const dayLabel = e.day.charAt(0).toUpperCase() + e.day.slice(1);
          eventsHtml += `
            <div class="contact-row" style="align-items: center; gap: 6px; margin-top: 2px;">
              <span class="event-badge ${activeToday ? 'event-today-tag' : ''}">
                ${activeToday ? '🔥 TODAY' : '📅'} ${this.escapeHtml(e.title)}
              </span>
              <span style="font-size: 0.74rem; color: #94a3b8;">${dayLabel}${e.time ? ` (${this.escapeHtml(e.time)})` : ''}</span>
            </div>
          `;
        });
      }

      let contactsHtml = '';
      let actionButtonsHtml = '';

      contacts.forEach((c) => {
        const isEmail = c.type.startsWith('email');
        const icon = isEmail ? '✉️' : '📞';
        let defaultLabel = 'Contact';
        if (c.type === 'phone_mobile') defaultLabel = 'Mobile';
        else if (c.type === 'phone_home') defaultLabel = 'Home';
        else if (c.type === 'phone_work') defaultLabel = 'Work';
        else if (c.type === 'email_personal') defaultLabel = 'Personal Email';
        else if (c.type === 'email_work') defaultLabel = 'Work Email';

        const displayLabel = c.label ? c.label : defaultLabel;

        contactsHtml += `<div class="contact-row">${icon} <strong style="font-size: 0.75rem; color: #94a3b8;">${this.escapeHtml(displayLabel)}:</strong> ${this.escapeHtml(c.value)}</div>`;

        if (isEmail) {
          actionButtonsHtml += `<a href="mailto:${c.value}" class="btn btn-glass btn-sm" title="Email ${c.value}">✉️ ${this.escapeHtml(displayLabel)}</a>`;
        } else {
          actionButtonsHtml += `<a href="tel:${c.value}" class="btn btn-glass btn-sm" title="Call ${c.value}">📞 ${this.escapeHtml(displayLabel)}</a>`;
        }
      });

      let jambaseCardHtml = '';
      const jbId = place.jambaseId || place.pollstarId;
      if (jbId) {
        const jambaseUrl = jbId.startsWith('http') ? jbId : `https://www.jambase.com/venue/${jbId}`;
        jambaseCardHtml = `
          <div class="jb-card-shows-box" data-jambase-id="${this.escapeHtml(jbId)}" style="margin-top: 8px; padding: 8px 10px; background: rgba(168, 85, 247, 0.08); border-radius: 8px; border: 1px solid rgba(168, 85, 247, 0.25);">
            <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.76rem; color: #c084fc; font-weight: 700;">
              <span>🎸 Upcoming Shows</span>
              <div style="display: flex; align-items: center; gap: 6px;">
                <button class="card-refresh-jb-btn" title="Refresh JamBase schedule" style="background: none; border: none; color: #c084fc; cursor: pointer; padding: 0 2px; display: flex; align-items: center;">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21.5 2v6h-6M2.5 22v-6h6"/>
                    <path d="M2 11.5a10 10 0 0 1 18.8-4.3L21.5 8M21.5 12.5a10 10 0 0 1-18.8 4.3L2.5 16"/>
                  </svg>
                </button>
                <a href="${jambaseUrl}" target="_blank" rel="noopener noreferrer" style="color: #a855f7; font-size: 0.71rem; text-decoration: none;">JamBase ↗</a>
              </div>
            </div>
            <div class="jb-card-shows-list" style="font-size: 0.75rem; margin-top: 4px; color: #cbd5e1;">Loading live schedule...</div>
          </div>
        `;
        actionButtonsHtml += `<a href="${jambaseUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-glass btn-sm" style="color: #c084fc; border-color: rgba(168, 85, 247, 0.4);" title="View Concerts on JamBase">🎸 JamBase ↗</a>`;
      }

      let capacityHtml = '';
      if (place.category === 'venue' && place.capacity) {
        capacityHtml = `<div class="contact-row">👥 <strong style="font-size: 0.75rem; color: #fbbf24;">Max Capacity:</strong> ${this.escapeHtml(place.capacity)} people</div>`;
      }

      card.innerHTML = `
        <div class="card-header-line">
          <div class="place-title-group">
            <span style="width: 12px; height: 12px; border-radius: 50%; background-color: ${place.color || '#3b82f6'};"></span>
            <span class="place-card-name">${this.escapeHtml(place.name)}</span>
          </div>
          <span class="category-tag" style="background: rgba(255,255,255,0.1); color: ${place.color || '#3b82f6'};">
            ${place.category || 'location'}
          </span>
        </div>
        ${peopleHtml}
        ${capacityHtml}
        ${jambaseCardHtml}
        ${eventsHtml}
        ${contactsHtml}
        ${place.address ? `<div class="contact-row">📍 ${this.escapeHtml(place.address)}</div>` : ''}
        
        <div class="contact-actions" style="flex-wrap: wrap;">
          <button class="btn btn-secondary btn-sm fly-place-btn" style="flex: 1;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="3 11 22 2 13 21 11 13 3 11"/>
            </svg> Fly to
          </button>
          ${actionButtonsHtml}
          <button class="btn btn-glass btn-sm edit-place-btn" title="Edit">✏️ Edit</button>
        </div>
      `;

      listContainer.appendChild(card);
    });

    listContainer.querySelectorAll('.jb-card-shows-box').forEach((box) => {
      const jbId = box.dataset.jambaseId;
      const listEl = box.querySelector('.jb-card-shows-list');
      if (!jbId || !listEl) return;
      JamBaseService.fetchUpcomingShows(jbId, false).then((shows) => {
        if (this.disposed || !listEl.isConnected) return;
        this.renderSidebarJamBaseShows(listEl, shows);
      });
    });
  }

  /**
   * Settings Modal Controls
   */
  openSettingsModal(mapboxToken, jambaseToken) {
    if (this.elements.settingsMapboxToken) {
      this.elements.settingsMapboxToken.value = mapboxToken || '';
    }
    if (this.elements.settingsJambaseToken) {
      this.elements.settingsJambaseToken.value = jambaseToken || '';
    }
    this.elements.settingsModal.classList.remove('hidden');
  }

  closeSettingsModal() {
    this.elements.settingsModal.classList.add('hidden');
  }

  /**
   * Dedicated Key Prompt Modal & Key Warning State
   */
  openKeyPromptModal(token = '') {
    if (this.elements.promptMapboxToken) {
      this.elements.promptMapboxToken.value = token || '';
    }
    if (this.elements.keyPromptModal) {
      this.elements.keyPromptModal.classList.remove('hidden');
    }
  }

  closeKeyPromptModal() {
    if (this.elements.keyPromptModal) {
      this.elements.keyPromptModal.classList.add('hidden');
    }
  }

  updateKeyWarningState(hasKey = true) {
    if (hasKey) {
      if (this.elements.keyWarningBanner) this.elements.keyWarningBanner.classList.add('hidden');
      if (this.elements.keyWarningDot) this.elements.keyWarningDot.classList.add('hidden');
    } else {
      if (this.elements.keyWarningBanner) this.elements.keyWarningBanner.classList.remove('hidden');
      if (this.elements.keyWarningDot) this.elements.keyWarningDot.classList.remove('hidden');
    }
  }

  /**
   * Leftover unprefixed keys / device recovery. Shown instead of silently
   * seeding demos when Web Locks cannot finish a one-time upgrade.
   */
  updateLegacyRecoveryBanner(status = {}) {
    if (this.disposed) return;
    const banner = this.elements.legacyRecoveryBanner;
    const message = this.elements.legacyRecoveryMessage;
    const restoreBtn = this.elements.restoreLegacyBtn;
    if (!banner) return;
    const leftoverPresent = Boolean(status.leftoverPresent);
    const ownerOrphans = Array.isArray(status.ownerOrphans) ? status.ownerOrphans.length : 0;
    const deviceOrphans = Array.isArray(status.deviceOrphans) ? status.deviceOrphans.length : 0;
    const needsAttention = leftoverPresent || ownerOrphans > 0 || deviceOrphans > 0;
    if (!needsAttention) {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');
    const parts = [];
    if (leftoverPresent && !status.locksAvailable) {
      parts.push('Previous neighborhood data is still on this device and was not applied automatically (this browser cannot take a Web Lock).');
    } else if (leftoverPresent) {
      parts.push('Previous neighborhood data is still on this device. Restore it into this account or download a recovery file.');
    }
    if (ownerOrphans > 0) {
      parts.push(`${ownerOrphans} leftover record(s) belong to this account.`);
    }
    if (deviceOrphans > 0) {
      parts.push(`${deviceOrphans} device-level leftover record(s) are not bound to this account.`);
    }
    if (message) message.textContent = parts.join(' ');
    if (restoreBtn) {
      restoreBtn.classList.toggle('hidden', !leftoverPresent);
      restoreBtn.disabled = leftoverPresent && !status.locksAvailable;
    }
  }

  /**
   * Toast Notifications System
   */
  showToast(message, type = 'info', durationMs = 3500) {
    if (this.disposed) return;
    const container = this.elements.toastContainer || document.getElementById('toast-container');
    if (!container) {
      console.warn('Toast container missing:', message);
      return;
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '⚠️';
    if (type === 'warning') icon = '⚡';

    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    this.scheduleTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      this.scheduleTimeout(() => toast.remove(), 300);
    }, durationMs);
  }

  /**
   * Show toast notification when JamBase API falls back to slower scraping.
   * Provides user-visible feedback about why venue shows may load slowly.
   */
  showJambaseApiFallbackToast(reason) {
    let message = 'JamBase API unavailable — loading venue shows via fallback (may be slower).';
    
    if (reason === 'auth') {
      message = 'JamBase API key expired or invalid — loading shows via slower fallback.';
    } else if (reason === 'rate_limit') {
      message = 'JamBase API rate limit reached — loading shows via slower fallback.';
    } else if (reason === 'network') {
      message = 'JamBase API unreachable — loading shows via slower fallback.';
    } else if (reason === 'no_results') {
      message = 'JamBase API returned no events for this venue — loading shows via fallback.';
    }

    this.showToast(message, 'warning', 8000);
  }

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
}
