import { normalizeProviders, normalizeSession } from './auth-client.js';

const API = Object.freeze({ providers: '/api/auth/providers', session: '/api/auth/session', login: '/api/auth/login/', logout: '/api/auth/logout' });
async function parse(response) {
  if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error?.code || `Authentication request failed (${response.status})`); }
  return response.json();
}
export function createHttpAuthClient({ fetch: request = globalThis.fetch, location = globalThis.location } = {}) {
  let csrfToken = null;
  const listeners = new Set();
  const load = async () => { const value = await parse(await request(API.session, { credentials: 'same-origin', headers: { accept: 'application/json' } })); csrfToken = value?.csrfToken || null; return normalizeSession(value); };
  return Object.freeze({
    async discoverProviders() { return normalizeProviders(await parse(await request(API.providers, { credentials: 'same-origin', headers: { accept: 'application/json' } }))); },
    loadSession: load,
    refreshSession: load,
    async signIn({ providerId, returnPath = location?.pathname || '/' } = {}) {
      if (typeof providerId !== 'string' || !providerId) throw new TypeError('signIn requires providerId');
      const target = `${API.login}${encodeURIComponent(providerId)}?returnPath=${encodeURIComponent(returnPath)}`;
      location.assign(target); return null;
    },
    async signOut() {
      const response = await request(API.logout, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'x-csrf-token': csrfToken || '' } });
      await parse(response); csrfToken = null; listeners.forEach((listener) => listener(null)); return null;
    },
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('Auth listener must be a function'); listeners.add(listener); return () => listeners.delete(listener); },
  });
}
