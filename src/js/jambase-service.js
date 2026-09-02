import { StorageService } from './storage.js';

export class JamBaseService {
  static CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 Hours TTL
  // Same-origin proxy (Vite dev + production server) so Bearer auth is not stripped by CORS proxies.
  static API_PROXY_BASE = '/api-jambase/v3';
  static _apiFallbackNotified = false;
  static _onApiFallback = null;

  /**
   * Set callback for when API fails and falls back to scraper.
   * Used to show user-visible notification about slower loads.
   */
  static setApiFallbackCallback(callback) {
    this._onApiFallback = typeof callback === 'function' ? callback : null;
  }

  /**
   * Reset the API fallback notification state.
   * Call this to allow showing the notification again (e.g., after page load or settings change).
   */
  static resetApiFallbackNotification() {
    this._apiFallbackNotified = false;
  }

  /**
   * Internal: notify about API failure (only once per session to avoid spam)
   */
  static _notifyApiFallback(reason) {
    if (this._apiFallbackNotified) return;
    this._apiFallbackNotified = true;
    try {
      if (this._onApiFallback) {
        this._onApiFallback(reason);
      }
    } catch (err) {
      console.warn('JamBase API fallback notification error:', err);
    }
  }

  /**
   * Convert a stored venue slug/URL/id into a JamBase Data API venueId (jambase:12345).
   * Numeric IDs and slugs that end in digits (e.g. the-fillmore-15421) are supported.
   */
  static toJamBaseVenueId(inputStr) {
    const cleanId = this.extractVenueId(inputStr);
    if (!cleanId) return null;
    if (/^\d+$/.test(cleanId)) return `jambase:${cleanId}`;
    // Trailing 4+ digits from URLs like jambase.com/venue/the-fillmore-15421
    const trailing = cleanId.match(/-(\d{4,})$/);
    if (trailing) return `jambase:${trailing[1]}`;
    return null;
  }

  /**
   * Drop cached venue show lists (used when the API key changes).
   */
  static clearShowsCache() {
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('guru_jb_shows_')) keysToRemove.push(key);
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
    } catch (e) {
      console.warn('Cache clear error:', e);
    }
  }

  /**
   * Extract JamBase venue ID or slug from a raw ID or full JamBase URL
   * e.g. "https://www.jambase.com/venue/soundcheck-studios" -> "soundcheck-studios"
   */
  static extractVenueId(inputStr) {
    if (!inputStr) return '';
    const trimmed = String(inputStr).trim();

    // Check if full JamBase URL was pasted
    const urlMatch = trimmed.match(/jambase\.com\/venue\/([^\s?#]+)/i);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1].replace(/\/$/, '');
    }

    // Clean input slug/ID
    return trimmed.replace(/[^\w-]/g, '');
  }

  /**
   * Get JamBase venue URL
   */
  static getVenueUrl(venueIdOrQuery) {
    if (!venueIdOrQuery) return 'https://www.jambase.com';
    const clean = this.extractVenueId(venueIdOrQuery);
    if (clean.includes('-') || /^\d+$/.test(clean)) {
      return `https://www.jambase.com/venue/${clean}`;
    }
    return `https://www.jambase.com/search?q=${encodeURIComponent(venueIdOrQuery)}`;
  }

  /**
   * Parse City & State from address string and area
   */
  static parseCityState(addressStr, areaName, fallbackContext = {}) {
    let city = '';
    let state = '';

    let areaClean = areaName || '';
    if (/united states/i.test(areaClean) || /united kingdom/i.test(areaClean)) {
      areaClean = '';
    }

    if (addressStr) {
      // Find 2-letter state code e.g. ", MA 02359" or ", CA"
      const stateMatch = addressStr.match(/,\s*([A-Z]{2})\b/);
      if (stateMatch) {
        state = stateMatch[1];
      }

      const parts = addressStr.split(',').map(s => s.trim());
      if (parts.length >= 3) {
        city = parts[parts.length - 2];
      } else if (parts.length === 2) {
        city = parts[0];
      }
    }

    if (!city && areaClean) city = areaClean;
    if (!city && fallbackContext.city) city = fallbackContext.city;
    if (!state && fallbackContext.state) state = fallbackContext.state;

    return { city, state };
  }

  /**
   * Search JamBase for venue matching query, enriched with clean city & state metadata
   */
  static async searchVenues(query, locationContext = {}) {
    if (!query || query.trim() === '') return [];
    const cleanQuery = query.trim();
    const primarySlug = cleanQuery.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');

    const results = [];
    const usedSlugs = new Set();

    // 1. Query MusicBrainz Place API for real-world venue metadata
    try {
      const mbUrl = `https://musicbrainz.org/ws/2/place?query=place:${encodeURIComponent(cleanQuery)}&fmt=json&limit=6`;
      const mbRes = await fetch(mbUrl, { headers: { 'User-Agent': 'NeighborhoodGuruApp/1.0' } });
      if (mbRes.ok) {
        const mbData = await mbRes.json();
        if (mbData.places && mbData.places.length > 0) {
          mbData.places.forEach((p, index) => {
            const address = p.address || '';
            const area = p.area ? p.area.name : '';
            const { city, state } = this.parseCityState(address, area, locationContext);

            let candidateSlug = primarySlug;
            if (index > 0 || usedSlugs.has(primarySlug)) {
              const citySlug = city ? city.toLowerCase().replace(/\s+/g, '-') : `venue-${index + 1}`;
              candidateSlug = `${primarySlug}-${citySlug}`.replace(/[^\w-]/g, '');
            }
            usedSlugs.add(candidateSlug);

            results.push({
              id: candidateSlug,
              name: p.name || cleanQuery,
              city: city,
              state: state,
              address: address,
              type: p.type || 'Venue',
              url: `https://www.jambase.com/venue/${candidateSlug}`,
            });
          });
        }
      }
    } catch (e) {
      console.warn('MusicBrainz venue lookup error:', e);
    }

    // 2. Fallback if no MusicBrainz places found
    if (results.length === 0) {
      const city = locationContext.city || '';
      const state = locationContext.state || '';

      results.push({
        id: primarySlug,
        name: cleanQuery,
        city: city,
        state: state,
        address: [city, state].filter(Boolean).join(', '),
        url: `https://www.jambase.com/venue/${primarySlug}`,
      });
    }

    return results;
  }

  /**
   * Fetch extra venue metadata (such as max capacity) from JamBase venue microdata or API
   */
  static async fetchVenueDetails(jambaseId) {
    if (!jambaseId) return null;
    const cleanId = this.extractVenueId(jambaseId);
    if (!cleanId) return null;

    try {
      const targetUrl = `https://www.jambase.com/venue/${cleanId}`;
      const proxyUrls = [
        `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
        `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
      ];

      for (const proxyUrl of proxyUrls) {
        const res = await fetch(proxyUrl);
        if (!res.ok) continue;

        const htmlText = await res.text();
        const capMatch = htmlText.match(/"maximumAttendeeCapacity"\s*:\s*"?(\d+)"?/i) || htmlText.match(/Capacity\s*:\s*([\d,]+)/i) || htmlText.match(/capacity"?\s*:\s*"?(\d+)"?/i);
        if (capMatch && capMatch[1]) {
          return { capacity: capMatch[1].replace(/,/g, '') };
        }
      }
    } catch (e) {
      console.warn('Venue details capacity lookup error:', e);
    }
    return null;
  }

  /**
   * Read cached shows from localStorage if within 4-hour TTL
   */
  static getCachedShows(cleanId) {
    try {
      const stored = localStorage.getItem(`guru_jb_shows_${cleanId}`);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.timestamp && (Date.now() - parsed.timestamp < this.CACHE_TTL_MS)) {
          return parsed.shows;
        }
      }
    } catch (e) {
      console.warn('Cache read error:', e);
    }
    return null;
  }

  /**
   * Save fetched shows to localStorage cache with timestamp
   */
  static setCachedShows(cleanId, shows) {
    try {
      localStorage.setItem(`guru_jb_shows_${cleanId}`, JSON.stringify({
        timestamp: Date.now(),
        shows: shows
      }));
    } catch (e) {
      console.warn('Cache write error:', e);
    }
  }

  /**
   * Same-origin GET against the JamBase Data API v3 proxy.
   * Returns { data } on success or { failureReason, status }.
   */
  static async _fetchJamBaseApi(pathWithQuery, apiKey) {
    const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
    const url = `${this.API_PROXY_BASE}${path}`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      });

      if (res.status === 401 || res.status === 403) {
        return { failureReason: 'auth', status: res.status };
      }
      if (res.status === 429) {
        return { failureReason: 'rate_limit', status: res.status };
      }
      if (!res.ok) {
        return { failureReason: 'error', status: res.status };
      }

      const text = await res.text();
      const trimmed = text.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return { failureReason: 'error', status: res.status };
      }

      const data = JSON.parse(trimmed);
      if (data && data.success === false) {
        return { failureReason: 'error', status: res.status, data };
      }
      return { data, status: res.status };
    } catch (err) {
      console.warn('JamBase v3 API request error:', err);
      return { failureReason: 'network' };
    }
  }

  static _eventListFromPayload(data) {
    if (!data) return null;
    if (Array.isArray(data)) return data;
    const raw = data.events || data.records || data.data || null;
    return Array.isArray(raw) ? raw : null;
  }

  static _venueListFromPayload(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    const raw = data.venues || data.records || data.data || [];
    return Array.isArray(raw) ? raw : [];
  }

  static _mapApiEvents(rawEvents, cleanId) {
    const todayStr = new Date().toDateString();
    return rawEvents.map((ev) => {
      const startDateStr = ev.startDate || ev.eventDate || ev.dateTime || ev.date;
      const startDate = startDateStr ? new Date(startDateStr) : null;
      const isToday = startDate ? startDate.toDateString() === todayStr : false;

      let title = ev.name || ev.title || '';
      if (!title && ev.performer) {
        title = Array.isArray(ev.performer) ? ev.performer.map((p) => p.name || p).join(', ') : (ev.performer.name || ev.performer);
      }
      if (!title) title = 'Concert';

      return {
        title,
        date: startDate ? startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' }) : '',
        time: startDate ? startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
        isToday,
        url: ev.url || ev.ticketUrl || `https://www.jambase.com/venue/${cleanId}`,
      };
    });
  }

  /**
   * Fetch upcoming concert schedule from JamBase Data API v3, with HTML scraper fallback.
   */
  static async fetchUpcomingShows(jambaseId, forceRefresh = false) {
    if (!jambaseId) return [];
    const cleanId = this.extractVenueId(jambaseId);
    if (!cleanId || cleanId.startsWith('search:')) return [];

    if (!forceRefresh) {
      const cached = this.getCachedShows(cleanId);
      if (cached !== null) {
        return cached;
      }
    }

    const apiKey = StorageService.getJambaseToken();
    let apiFailureReason = null;

    if (apiKey) {
      const venueName = cleanId.replace(/-/g, ' ');
      const venueId = this.toJamBaseVenueId(cleanId);

      const tryEventsQuery = async (query) => {
        const result = await this._fetchJamBaseApi(`/events?${query}&perPage=5`, apiKey);
        if (result.failureReason) {
          apiFailureReason = result.failureReason;
          return null;
        }
        const rawEvents = this._eventListFromPayload(result.data);
        if (rawEvents && rawEvents.length > 0) {
          const finalShows = this._mapApiEvents(rawEvents, cleanId).slice(0, 5);
          console.log('✓ JamBase Data API v3 shows loaded:', finalShows);
          this.setCachedShows(cleanId, finalShows);
          return finalShows;
        }
        if (!apiFailureReason) apiFailureReason = 'no_results';
        return null;
      };

      if (venueId) {
        const byId = await tryEventsQuery(`venueId=${encodeURIComponent(venueId)}`);
        if (byId) return byId;
      }

      if (apiFailureReason !== 'auth' && apiFailureReason !== 'rate_limit') {
        const byName = await tryEventsQuery(`venueName=${encodeURIComponent(venueName)}`);
        if (byName) return byName;
      }

      if (apiFailureReason !== 'auth' && apiFailureReason !== 'rate_limit') {
        const venueSearch = await this._fetchJamBaseApi(
          `/venues?venueName=${encodeURIComponent(venueName)}&perPage=5`,
          apiKey
        );
        if (venueSearch.failureReason) {
          apiFailureReason = venueSearch.failureReason;
        } else {
          const venues = this._venueListFromPayload(venueSearch.data);
          const match = venues.find((v) => v && (v.identifier || v.id));
          const resolvedId = match?.identifier || match?.id;
          if (resolvedId) {
            const byResolved = await tryEventsQuery(`venueId=${encodeURIComponent(resolvedId)}`);
            if (byResolved) return byResolved;
          } else if (!apiFailureReason) {
            apiFailureReason = 'no_results';
          }
        }
      }

      console.warn('JamBase Data API unavailable, using HTML scraper fallback:', apiFailureReason || 'error');
      this._notifyApiFallback(apiFailureReason || 'error');
    }

    // Fallback: scrape JamBase venue HTML via CORS proxies if no key is configured or the API failed.
    const targetUrl = `https://www.jambase.com/venue/${cleanId}`;
    const proxyUrls = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
      `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
    ];

    for (const proxyUrl of proxyUrls) {
      try {
        const res = await fetch(proxyUrl);
        if (!res.ok) continue;

        const htmlText = await res.text();
        const todayStr = new Date().toDateString();
        const events = [];

        // 1. Parse JSON-LD microdata script tags (<script type="application/ld+json">)
        const jsonLdMatches = htmlText.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
        if (jsonLdMatches) {
          jsonLdMatches.forEach(scriptTag => {
            try {
              const jsonContent = scriptTag.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
              const parsed = JSON.parse(jsonContent);
              const itemList = Array.isArray(parsed) ? parsed : [parsed];

              itemList.forEach(item => {
                const nodes = item['@graph'] || [item];
                nodes.forEach(ev => {
                  if (ev['@type'] === 'Event' || ev['@type'] === 'MusicEvent') {
                    const startDate = ev.startDate ? new Date(ev.startDate) : null;
                    const isToday = startDate ? startDate.toDateString() === todayStr : false;
                    const dateStr = startDate ? startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' }) : '';
                    const timeStr = startDate ? startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
                    
                    let performerName = 'Concert';
                    if (ev.name) {
                      performerName = ev.name;
                    } else if (ev.performer) {
                      performerName = Array.isArray(ev.performer) ? ev.performer.map(p => p.name).join(', ') : ev.performer.name;
                    }

                    events.push({
                      title: performerName,
                      date: dateStr,
                      time: timeStr,
                      isToday: isToday,
                      url: ev.url || targetUrl,
                    });
                  }
                });
              });
            } catch (e) {
              // Ignore invalid JSON-LD scripts
            }
          });
        }

        // 2. Parse HTML event item fallback if JSON-LD tag was not present
        if (events.length === 0) {
          const showItemRegex = /class="[^"]*event-card[^"]*"[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<time[^>]*datetime="([^"]*)"[^>]*>/gi;
          let match;
          while ((match = showItemRegex.exec(htmlText)) !== null) {
            const showTitle = match[2].replace(/<[^>]+>/g, '').trim();
            const showDate = match[3] ? new Date(match[3]) : null;
            if (showTitle) {
              events.push({
                title: showTitle,
                date: showDate ? showDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' }) : 'Upcoming',
                time: showDate ? showDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
                isToday: showDate ? showDate.toDateString() === todayStr : false,
                url: match[1].startsWith('http') ? match[1] : `https://www.jambase.com${match[1]}`,
              });
            }
          }
        }

        if (events.length > 0) {
          const uniqueEvents = [];
          const seen = new Set();
          events.forEach(e => {
            const key = `${e.title}-${e.date}`;
            if (!seen.has(key)) {
              seen.add(key);
              uniqueEvents.push(e);
            }
          });

          const finalShows = uniqueEvents.slice(0, 5);
          this.setCachedShows(cleanId, finalShows);
          return finalShows;
        }
      } catch (err) {
        console.warn('Proxy fetch attempt error:', err);
      }
    }

    this.setCachedShows(cleanId, []);
    return [];
  }
}
