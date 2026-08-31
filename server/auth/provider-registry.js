const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export function createProviderRegistry(adapters = []) {
  const providers = new Map();
  for (const adapter of adapters) {
    if (!adapter || !PROVIDER_ID_PATTERN.test(adapter.id) || typeof adapter.displayName !== 'string' || typeof adapter.createAuthorizationUrl !== 'function' || typeof adapter.exchangeCallback !== 'function') throw new TypeError('Invalid authentication provider adapter');
    if (providers.has(adapter.id)) throw new TypeError(`Duplicate authentication provider: ${adapter.id}`);
    providers.set(adapter.id, adapter);
  }
  return Object.freeze({ list: () => Object.freeze([...providers.values()].map(({ id, displayName }) => Object.freeze({ id, displayName }))), get: (id) => providers.get(id) || null });
}
