import { getPlaceContacts, getPlacePeople, getPlaceEvents, isEventHappeningToday } from './storage.js';

export class UIController {
  constructor() {
    this.elements = {};
    this.currentFilter = 'all';
    this.searchQuery = '';
  }

  init() {
    this.cacheElements();
    this.bindPeopleFieldEvents();
    this.bindContactFieldEvents();
    this.bindEventFieldEvents();
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

      // Settings Modal
      settingsModal: document.getElementById('settings-modal'),
      closeSettingsModal: document.getElementById('close-settings-modal'),
      cancelSettingsBtn: document.getElementById('cancel-settings-btn'),
      saveSettingsBtn: document.getElementById('save-settings-btn'),
      settingsMapboxToken: document.getElementById('settings-mapbox-token'),
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

      // Toasts
      toastContainer: document.getElementById('toast-container'),
    };
  }

  /**
   * Header Status Updates
   */
  updateHomeHeaderStatus(homeAddress) {
    if (homeAddress && homeAddress.name) {
      const shortAddr = homeAddress.name.split(',')[0];
      this.elements.homeStatusSubtitle.textContent = `Home: ${shortAddr}`;
      this.elements.homeStatusSubtitle.style.color = '#10b981';
      this.elements.currentHomeDisplay.textContent = homeAddress.name;
      this.elements.clearHomeBtn.classList.remove('hidden');
    } else {
      this.elements.homeStatusSubtitle.textContent = 'Earth Globe View';
      this.elements.homeStatusSubtitle.style.color = '#3b82f6';
      this.elements.currentHomeDisplay.textContent = 'No Home address configured yet';
      this.elements.clearHomeBtn.classList.add('hidden');
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
    const container = this.elements.poiResultsContainer;
    if (!container) return;
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

    pois.forEach((poi) => {
      const card = document.createElement('div');
      card.className = 'poi-item-card';

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

      card.querySelector('.btn-import-single').addEventListener('click', () => {
        if (onImportClick) onImportClick(poi);
        card.style.opacity = '0.5';
        card.querySelector('.btn-import-single').textContent = '✓ Imported';
        card.querySelector('.btn-import-single').disabled = true;
      });

      container.appendChild(card);
    });
  }

  /**
   * Dynamic People Management
   */
  bindPeopleFieldEvents() {
    if (this.elements.addPersonFieldBtn) {
      this.elements.addPersonFieldBtn.addEventListener('click', () => {
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
    const container = this.elements.peopleListContainer;
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'person-row';

    row.innerHTML = `
      <input type="text" class="person-name-input" placeholder="e.g. Sarah, John, Vickie" value="${this.escapeHtml(name)}" />
      <button type="button" class="btn-remove-row" title="Remove person">&times;</button>
    `;

    row.querySelector('.btn-remove-row').addEventListener('click', () => {
      row.remove();
    });

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
      this.elements.addContactFieldBtn.addEventListener('click', () => {
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

    const select = row.querySelector('.contact-type-select');
    const valueInput = row.querySelector('.contact-value-input');
    select.addEventListener('change', () => {
      const selectedType = select.value;
      if (selectedType.startsWith('email')) {
        valueInput.placeholder = 'e.g. name@example.com';
      } else {
        valueInput.placeholder = 'e.g. (555) 000-0000';
      }
    });

    row.querySelector('.btn-remove-row').addEventListener('click', () => {
      row.remove();
    });

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
      this.elements.addEventFieldBtn.addEventListener('click', () => {
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

    row.querySelector('.btn-remove-row').addEventListener('click', () => {
      row.remove();
    });

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
    const isEdit = Boolean(data.id);
    this.elements.locationModalTitle.textContent = isEdit ? 'Edit Location Details' : 'Add Neighborhood Location';
    
    // Explicitly set ID: empty string for new locations to prevent overwriting existing markers
    this.elements.formLocationId.value = isEdit ? String(data.id) : '';
    this.elements.formLat.value = data.lat || '';
    this.elements.formLng.value = data.lng || '';

    this.elements.locationModalCoords.textContent = `Coordinates: ${Number(data.lat).toFixed(5)}, ${Number(data.lng).toFixed(5)}`;
    this.elements.formName.value = data.name || '';
    this.elements.formCategory.value = data.category || 'neighbor';

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
    this.elements.locationModal.classList.add('hidden');
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

      // Click card to fly to location
      card.querySelector('.fly-place-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (onPlaceClick) onPlaceClick(place);
      });

      card.querySelector('.edit-place-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (onEditClick) onEditClick(place);
      });

      card.addEventListener('click', () => {
        if (onPlaceClick) onPlaceClick(place);
      });

      listContainer.appendChild(card);
    });
  }

  /**
   * Settings Modal Controls
   */
  openSettingsModal(token) {
    this.elements.settingsMapboxToken.value = token || '';
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
   * Toast Notifications System
   */
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '⚠️';

    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    this.elements.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
}
