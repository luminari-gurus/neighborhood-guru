export function createAnonymousAuthClient() {
  return Object.freeze({
    async discoverProviders() {
      return Object.freeze([]);
    },
    async loadSession() {
      return null;
    },
    async refreshSession() {
      return null;
    },
    async signIn() {
      throw new Error('No authentication provider is configured');
    },
    async signOut() {
      return null;
    },
    subscribe() {
      return () => {};
    },
  });
}
