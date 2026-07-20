/* ==========================================================================
   UI CONTROLLER - MODALS, DRAWER, FORMS, FILTERS & TOAST NOTIFICATIONS
   ========================================================================== */

import { normalizePlaceContacts } from './storage.js';

export class UIController {
  constructor() {
    this.elements = {};
    this.currentFilter = 'all';
    this.searchQuery = '';
  }

  init() {
    this.cacheElements();
    this.bindContactFieldEvents();
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
      formContactName: document.getElementById('form-contact-name'),
      addContactFieldBtn: document.getElementById('add-contact-field-btn'),
      contactMethodsContainer: document.getElementById('contact-methods-container'),
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

  /**
   * Dynamic Contact Fields Management
   */
  bindContactFieldEvents() {
    if (this.elements.addContactFieldBtn) {
      this.elements.addContactFieldBtn.addEventListener('click', () => {
        this.addContactRow('phone_mobile', '');
      });
    }
  }

  renderContactFields(contacts = []) {
    const container = this.elements.contactMethodsContainer;
    if (!container) return;
    container.innerHTML = '';

    const list = Array.isArray(contacts) && contacts.length > 0 ? contacts : [{ type: 'phone_mobile', value: '' }];
    list.forEach(c => this.addContactRow(c.type || 'phone_mobile', c.value || ''));
  }

  addContactRow(type = 'phone_mobile', value = '') {
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
        <option value="email_personal" ${type === 'email_personal' ? 'selected' : ''}>✉️ Email (Personal)</option>
        <option value="email_work" ${type === 'email_work' ? 'selected' : ''}>🏢 Email (Work)</option>
        <option value="other" ${type === 'other' ? 'selected' : ''}>📌 Other Contact</option>
      </select>
      <input type="text" class="contact-value-input" placeholder="${isEmail ? 'e.g. name@example.com' : 'e.g. (555) 000-0000'}" value="${this.escapeHtml(value)}" />
      <button type="button" class="btn-remove-contact" title="Remove method">&times;</button>
    `;

    const select = row.querySelector('.contact-type-select');
    const input = row.querySelector('.contact-value-input');
    select.addEventListener('change', () => {
      const selectedType = select.value;
      if (selectedType.startsWith('email')) {
        input.placeholder = 'e.g. name@example.com';
      } else {
        input.placeholder = 'e.g. (555) 000-0000';
      }
    });

    row.querySelector('.btn-remove-contact').addEventListener('click', () => {
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
      const value = row.querySelector('.contact-value-input').value.trim();
      if (value) {
        contacts.push({ type, value });
      }
    });
    return contacts;
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
    this.elements.formContactName.value = data.contactName || '';

    // Populate dynamic contact fields (phones & emails)
    const contacts = normalizePlaceContacts(data);
    this.renderContactFields(contacts);

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
      const matchesCategory = this.currentFilter === 'all' || p.category === this.currentFilter;
      const q = this.searchQuery.toLowerCase();
      const matchesSearch =
        !q ||
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.contactName && p.contactName.toLowerCase().includes(q)) ||
        (p.phone && p.phone.includes(q)) ||
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

      const contacts = normalizePlaceContacts(place);

      let contactsHtml = '';
      let actionButtonsHtml = '';

      contacts.forEach((c) => {
        const isEmail = c.type.startsWith('email');
        const icon = isEmail ? '✉️' : '📞';
        let label = 'Contact';
        if (c.type === 'phone_mobile') label = 'Mobile';
        else if (c.type === 'phone_home') label = 'Home';
        else if (c.type === 'phone_work') label = 'Work';
        else if (c.type === 'email_personal') label = 'Personal';
        else if (c.type === 'email_work') label = 'Work Email';

        contactsHtml += `<div class="contact-row">${icon} <strong style="font-size: 0.75rem; color: #94a3b8;">${label}:</strong> ${this.escapeHtml(c.value)}</div>`;

        if (isEmail) {
          actionButtonsHtml += `<a href="mailto:${c.value}" class="btn btn-glass btn-sm" title="Email ${c.value}">✉️ ${label}</a>`;
        } else {
          actionButtonsHtml += `<a href="tel:${c.value}" class="btn btn-glass btn-sm" title="Call ${c.value}">📞 ${label}</a>`;
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
        ${place.contactName ? `<div class="contact-row">👤 ${this.escapeHtml(place.contactName)}</div>` : ''}
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
