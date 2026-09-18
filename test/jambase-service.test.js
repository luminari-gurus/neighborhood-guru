import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { JamBaseService } from '../src/js/jambase-service.js';

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

function createMockLocalStorage(data = {}) {
  const store = { ...data };
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => Object.keys(store).forEach(k => delete store[k]),
    get length() { return Object.keys(store).length; },
    key: (index) => Object.keys(store)[index] || null,
  };
}

function isJamBaseApiUrl(url) {
  const value = String(url);
  return value.includes('/api-jambase') || value.includes('api.data.jambase.com');
}

function isScraperUrl(url) {
  const value = String(url);
  return value.includes('corsproxy') || value.includes('allorigins');
}

function jsonResponse(body, status = 200, headerMap = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headerMap[String(name).toLowerCase()] ?? headerMap[name] ?? null,
    },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function errorResponse(status, body = '', headerMap = {}) {
  return jsonResponse(body, status, headerMap);
}

describe('JamBaseService API fallback notification', () => {
  beforeEach(() => {
    JamBaseService.resetApiFallbackNotification();
    JamBaseService.setApiFallbackCallback(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });

  test('calls fallback callback when API returns 401 auth error', async () => {
    let callbackReason = null;
    JamBaseService.setApiFallbackCallback((reason) => {
      callbackReason = reason;
    });

    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'expired-api-key',
    });

    globalThis.fetch = async (url) => {
      if (isJamBaseApiUrl(url) || isScraperUrl(url)) {
        return errorResponse(401, 'Unauthorized');
      }
      return errorResponse(404);
    };

    await JamBaseService.fetchUpcomingShows('test-venue');

    expect(callbackReason).toBe('auth');
  });

  test('calls fallback callback when API returns 403 forbidden', async () => {
    let callbackReason = null;
    JamBaseService.setApiFallbackCallback((reason) => {
      callbackReason = reason;
    });

    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'invalid-api-key',
    });

    globalThis.fetch = async (url) => {
      if (isJamBaseApiUrl(url) || isScraperUrl(url)) {
        return errorResponse(403, 'Forbidden');
      }
      return errorResponse(404);
    };

    await JamBaseService.fetchUpcomingShows('test-venue');

    expect(callbackReason).toBe('auth');
  });

  test('calls fallback callback when API returns 429 rate limit', async () => {
    let callbackReason = null;
    JamBaseService.setApiFallbackCallback((reason) => {
      callbackReason = reason;
    });

    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'valid-api-key',
    });

    globalThis.fetch = async (url) => {
      if (isJamBaseApiUrl(url) || isScraperUrl(url)) {
        return errorResponse(429, 'Too Many Requests', { 'retry-after': '0' });
      }
      return errorResponse(404);
    };

    await JamBaseService.fetchUpcomingShows('test-venue');

    expect(callbackReason).toBe('rate_limit');
  });

  test('calls fallback callback on network error', async () => {
    let callbackReason = null;
    JamBaseService.setApiFallbackCallback((reason) => {
      callbackReason = reason;
    });

    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'valid-api-key',
    });

    globalThis.fetch = async (url) => {
      if (isJamBaseApiUrl(url) || isScraperUrl(url)) {
        throw new Error('Network error');
      }
      return { ok: false, status: 404 };
    };

    await JamBaseService.fetchUpcomingShows('test-venue');

    expect(callbackReason).toBe('network');
  });

  test('does not fall back when API returns 200 with no upcoming events', async () => {
    let callbackReason = null;
    let scraperHits = 0;
    JamBaseService.setApiFallbackCallback((reason) => {
      callbackReason = reason;
    });

    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'valid-api-key',
    });

    globalThis.fetch = async (url) => {
      if (isScraperUrl(url)) {
        scraperHits += 1;
        return errorResponse(404);
      }
      if (isJamBaseApiUrl(url)) {
        return jsonResponse({ events: [], venues: [] });
      }
      return errorResponse(404);
    };

    const shows = await JamBaseService.fetchUpcomingShows('test-venue', true);

    expect(callbackReason).toBeNull();
    expect(scraperHits).toBe(0);
    expect(shows).toEqual([]);
  });

  test('only calls callback once per session to avoid spam', async () => {
    let callbackCount = 0;
    JamBaseService.setApiFallbackCallback(() => {
      callbackCount++;
    });

    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'expired-api-key',
    });

    globalThis.fetch = async (url) => {
      if (isJamBaseApiUrl(url) || isScraperUrl(url)) {
        return errorResponse(401, 'Unauthorized');
      }
      return errorResponse(404);
    };

    await JamBaseService.fetchUpcomingShows('venue-1');
    await JamBaseService.fetchUpcomingShows('venue-2');
    await JamBaseService.fetchUpcomingShows('venue-3');

    expect(callbackCount).toBe(1);
  });

  test('does not call callback when API succeeds', async () => {
    let callbackCalled = false;
    JamBaseService.setApiFallbackCallback(() => {
      callbackCalled = true;
    });

    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'valid-api-key',
    });

    const mockEvents = {
      events: [
        {
          name: 'Test Concert',
          startDate: '2026-09-01T20:00:00',
          url: 'https://jambase.com/event/test',
        },
      ],
    };

    globalThis.fetch = async (url) => {
      if (isJamBaseApiUrl(url)) {
        return jsonResponse(mockEvents);
      }
      return { ok: false, status: 404 };
    };

    const shows = await JamBaseService.fetchUpcomingShows('the-fillmore-15421', true);

    expect(callbackCalled).toBe(false);
    expect(shows.length).toBeGreaterThan(0);
  });

  test('resolves slug venues through /venues then queries venueId', async () => {
    const requested = [];
    let callbackCalled = false;
    JamBaseService.setApiFallbackCallback(() => {
      callbackCalled = true;
    });

    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'valid-api-key',
    });

    globalThis.fetch = async (url) => {
      const value = String(url);
      requested.push(value);
      if (value.includes('/venues?')) {
        return jsonResponse({
          venues: [{
            identifier: 'jambase:62108',
            name: 'Neighborhood Theatre',
            url: 'https://www.jambase.com/venue/neighborhood-theatre',
          }],
        });
      }
      if (value.includes('venueId=')) {
        return jsonResponse({
          events: [{ name: 'Lettuce', startDate: '2026-08-23T20:00:00' }],
        });
      }
      return jsonResponse({ events: [] });
    };

    const shows = await JamBaseService.fetchUpcomingShows('neighborhood-theatre', true);

    expect(callbackCalled).toBe(false);
    expect(requested.some((url) => url.includes('/venues?venueName='))).toBe(true);
    expect(requested.some((url) => url.includes('venueId=jambase%3A62108') || url.includes('venueId=jambase:62108'))).toBe(true);
    expect(shows[0].title).toBe('Lettuce');
    expect(globalThis.localStorage.getItem('guru_jb_venueid_neighborhood-theatre')).toBe('jambase:62108');
  });

  test('falls back when venue resolution succeeds but the events request fails', async () => {
    let callbackReason = null;
    let scraperHits = 0;
    JamBaseService.setApiFallbackCallback((reason) => {
      callbackReason = reason;
    });

    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'valid-api-key',
    });

    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes('/venues?')) {
        return jsonResponse({
          venues: [{
            identifier: 'jambase:62108',
            name: 'Neighborhood Theatre',
            url: 'https://www.jambase.com/venue/neighborhood-theatre',
          }],
        });
      }
      if (value.includes('/events?')) {
        throw new Error('events endpoint unavailable');
      }
      if (isScraperUrl(value)) {
        scraperHits += 1;
        return jsonResponse('<script type="application/ld+json">{"@type":"MusicEvent","name":"Fallback Show","startDate":"2026-10-01T20:00:00Z"}</script>');
      }
      return errorResponse(404);
    };

    const shows = await JamBaseService.fetchUpcomingShows('neighborhood-theatre', true);

    expect(callbackReason).toBe('network');
    expect(scraperHits).toBe(1);
    expect(shows[0].title).toBe('Fallback Show');
  });

  test('retries 429 with Retry-After and stays on the API', async () => {
    let callbackCalled = false;
    let apiHits = 0;
    JamBaseService.setApiFallbackCallback(() => {
      callbackCalled = true;
    });

    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'valid-api-key',
    });

    globalThis.fetch = async (url) => {
      if (!isJamBaseApiUrl(url)) return errorResponse(404);
      apiHits += 1;
      if (apiHits === 1) {
        return errorResponse(429, 'Too Many Requests', { 'retry-after': '0' });
      }
      return jsonResponse({
        events: [{ name: 'Retry Concert', startDate: '2026-09-01T20:00:00' }],
      });
    };

    const shows = await JamBaseService.fetchUpcomingShows('the-fillmore-15421', true);

    expect(callbackCalled).toBe(false);
    expect(apiHits).toBe(2);
    expect(shows[0].title).toBe('Retry Concert');
  });

  test('queries numeric venue IDs with venueId=jambase:', async () => {
    const requested = [];
    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'valid-api-key',
    });

    globalThis.fetch = async (url) => {
      requested.push(String(url));
      if (String(url).includes('venueId=')) {
        return jsonResponse({
          events: [{ name: 'Fillmore Night', startDate: '2026-09-01T20:00:00' }],
        });
      }
      return jsonResponse({ events: [] });
    };

    const shows = await JamBaseService.fetchUpcomingShows('the-fillmore-15421', true);

    expect(requested.some((url) => url.includes('venueId=jambase%3A15421') || url.includes('venueId=jambase:15421'))).toBe(true);
    expect(shows[0].title).toBe('Fillmore Night');
  });

  test('does not call callback when no API key is configured', async () => {
    let callbackCalled = false;
    JamBaseService.setApiFallbackCallback(() => {
      callbackCalled = true;
    });

    globalThis.localStorage = createMockLocalStorage({});

    globalThis.fetch = async () => {
      return { ok: false, status: 404 };
    };

    await JamBaseService.fetchUpcomingShows('test-venue');

    expect(callbackCalled).toBe(false);
  });

  test('resetApiFallbackNotification allows callback to fire again', async () => {
    let callbackCount = 0;
    JamBaseService.setApiFallbackCallback(() => {
      callbackCount++;
    });

    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'expired-api-key',
    });

    globalThis.fetch = async (url) => {
      if (isJamBaseApiUrl(url) || isScraperUrl(url)) {
        return errorResponse(401, 'Unauthorized');
      }
      return errorResponse(404);
    };

    await JamBaseService.fetchUpcomingShows('venue-1');
    expect(callbackCount).toBe(1);

    JamBaseService.resetApiFallbackNotification();

    await JamBaseService.fetchUpcomingShows('venue-2');
    expect(callbackCount).toBe(2);
  });
});

describe('JamBaseService utility methods', () => {
  test('extractVenueId handles JamBase URLs', () => {
    expect(JamBaseService.extractVenueId('https://www.jambase.com/venue/soundcheck-studios'))
      .toBe('soundcheck-studios');
    expect(JamBaseService.extractVenueId('https://jambase.com/venue/the-fillmore/'))
      .toBe('the-fillmore');
    expect(JamBaseService.extractVenueId('simple-slug'))
      .toBe('simple-slug');
    expect(JamBaseService.extractVenueId('jambase:62108'))
      .toBe('jambase:62108');
  });

  test('toJamBaseVenueId extracts numeric IDs from slugs and URLs', () => {
    expect(JamBaseService.toJamBaseVenueId('15421')).toBe('jambase:15421');
    expect(JamBaseService.toJamBaseVenueId('the-fillmore-15421')).toBe('jambase:15421');
    expect(JamBaseService.toJamBaseVenueId('https://www.jambase.com/venue/the-fillmore-15421'))
      .toBe('jambase:15421');
    expect(JamBaseService.toJamBaseVenueId('jambase:62108')).toBe('jambase:62108');
    expect(JamBaseService.toJamBaseVenueId('soundcheck-studios')).toBeNull();
    expect(JamBaseService.toJamBaseVenueId('venue-1')).toBeNull();
  });

  test('getVenueUrl generates correct URLs', () => {
    expect(JamBaseService.getVenueUrl('soundcheck-studios'))
      .toBe('https://www.jambase.com/venue/soundcheck-studios');
    expect(JamBaseService.getVenueUrl('12345'))
      .toBe('https://www.jambase.com/venue/12345');
  });
});

describe('JamBaseService venue search', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  });

  test('keeps the public slug and caches the canonical Data API identifier', async () => {
    globalThis.localStorage = createMockLocalStorage({
      neighborhood_guru_jambase_token: 'valid-api-key',
    });

    globalThis.fetch = async (url) => {
      if (String(url).includes('/venues?')) {
        return jsonResponse({
          venues: [{
            identifier: 'jambase:62108',
            name: 'Neighborhood Theatre',
            url: 'https://www.jambase.com/venue/neighborhood-theatre',
            address: { addressLocality: 'Charlotte', addressRegion: 'NC' },
            maximumAttendeeCapacity: 956,
          }],
        });
      }
      return errorResponse(404);
    };

    const matches = await JamBaseService.searchVenues('Neighborhood Theatre');
    expect(matches[0].id).toBe('neighborhood-theatre');
    expect(matches[0].url).toBe('https://www.jambase.com/venue/neighborhood-theatre');
    expect(matches[0].city).toBe('Charlotte');
    expect(matches[0].capacity).toBe('956');
    expect(globalThis.localStorage.getItem('guru_jb_venueid_neighborhood-theatre')).toBe('jambase:62108');
  });
});
