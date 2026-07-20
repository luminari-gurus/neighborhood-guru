/* ==========================================================================
   JAMBASE SERVICE - VENUE SEARCH & CONCERT EVENTS LINKING
   ========================================================================== */

export class JamBaseService {
  static CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 Hours TTL

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
   * Fetch REAL upcoming concert schedule from JamBase with 4-Hour TTL caching & forceRefresh
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
