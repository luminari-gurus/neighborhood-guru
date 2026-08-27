import { normalizeProviders, normalizeSession } from './auth-client.js';

export class FakeAuthClient {
  #providers;
  constructor({ providers = [], session = null } = {}) {
    this.#providers = normalizeProviders(providers);
    this.session = normalizeSession(session);
    this.listeners = new Set();
    this.failures = new Map();
  }

  failNext(method, error = new Error(`Fake ${method} failure`)) {
    this.failures.set(method, error);
  }

  async #result(method, value) {
    if (this.failures.has(method)) {
      const error = this.failures.get(method);
      this.failures.delete(method);
      throw error;
    }
    return value;
  }

  discoverProviders() {
    return this.#result('discoverProviders', this.#providers);
  }

  loadSession() {
    return this.#result('loadSession', this.session);
  }

  refreshSession() {
    return this.#result('refreshSession', this.session);
  }

  async signIn({ session } = {}) {
    const nextSession = normalizeSession(await this.#result('signIn', session ?? this.session));
    this.setSession(nextSession);
    return nextSession;
  }

  async signOut() {
    await this.#result('signOut', null);
    this.setSession(null);
    return null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSession(session) {
    this.session = normalizeSession(session);
    this.listeners.forEach((listener) => listener(this.session));
  }
}
