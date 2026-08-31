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
  };
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
      if (url.includes('api.data.jambase.com') || url.includes('corsproxy') || url.includes('allorigins')) {
        return { ok: false, status: 401, text: async () => 'Unauthorized' };
      }
      return { ok: false, status: 404 };
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
      if (url.includes('api.data.jambase.com') || url.includes('corsproxy') || url.includes('allorigins')) {
        return { ok: false, status: 403, text: async () => 'Forbidden' };
      }
      return { ok: false, status: 404 };
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
      if (url.includes('api.data.jambase.com') || url.includes('corsproxy') || url.includes('allorigins')) {
        return { ok: false, status: 429, text: async () => 'Too Many Requests' };
      }
      return { ok: false, status: 404 };
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
      if (url.includes('api.data.jambase.com') || url.includes('corsproxy') || url.includes('allorigins')) {
        throw new Error('Network error');
      }
      return { ok: false, status: 404 };
    };

    await JamBaseService.fetchUpcomingShows('test-venue');

    expect(callbackReason).toBe('network');
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
      if (url.includes('api.data.jambase.com') || url.includes('corsproxy') || url.includes('allorigins')) {
        return { ok: false, status: 401, text: async () => 'Unauthorized' };
      }
      return { ok: false, status: 404 };
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
      if (url.includes('corsproxy') || url.includes('allorigins')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(mockEvents),
        };
      }
      return { ok: false, status: 404 };
    };

    const shows = await JamBaseService.fetchUpcomingShows('test-venue', true);

    expect(callbackCalled).toBe(false);
    expect(shows.length).toBeGreaterThan(0);
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
      if (url.includes('api.data.jambase.com') || url.includes('corsproxy') || url.includes('allorigins')) {
        return { ok: false, status: 401, text: async () => 'Unauthorized' };
      }
      return { ok: false, status: 404 };
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
  });

  test('getVenueUrl generates correct URLs', () => {
    expect(JamBaseService.getVenueUrl('soundcheck-studios'))
      .toBe('https://www.jambase.com/venue/soundcheck-studios');
    expect(JamBaseService.getVenueUrl('12345'))
      .toBe('https://www.jambase.com/venue/12345');
  });
});
