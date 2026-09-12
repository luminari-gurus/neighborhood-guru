import { AUTH_STATUS } from './auth/auth-client.js';
import { StorageService } from './storage.js';

/**
 * Resolve the working-copy owner from auth state.
 * AUTHENTICATING and ERROR keep the previous owner so a shared browser does
 * not flash another namespace during sign-in or a failed refresh.
 *
 * @returns {string|null|undefined} user id, `null` for anonymous, or
 *   `undefined` when the owner must not change yet.
 */
export function ownerIdFromAuthState(state) {
  if (!state) return undefined;
  if (state.status === AUTH_STATUS.AUTHENTICATING || state.status === AUTH_STATUS.ERROR) {
    return undefined;
  }
  if (state.status === AUTH_STATUS.AUTHENTICATED && state.user?.id) {
    return state.user.id;
  }
  return null;
}

/**
 * Bind namespaced localStorage to AuthClient session changes.
 *
 * Login / session restore only switch the local working copy. This function
 * must not call NeighborhoodStore or `/api/neighborhood` — login is not
 * consent (ADR 0001).
 *
 * Returns an unsubscribe function with a `.ready` promise that settles after
 * the current owner's Web Lock migration (or fail-closed recovery).
 */
export function bindNeighborhoodWorkingCopy(
  auth,
  storage = StorageService,
  { onOwnerChange, onOwnerReady, neighborhoodStore } = {},
) {
  // Reserved so callers/tests can pass a store spy. Must stay unused here.
  void neighborhoodStore;

  let currentNamespaceId = storage.getNamespaceId?.() ?? storage.getOwnerId();
  let applyGeneration = 0;
  let latestReady = Promise.resolve();
  let stopped = false;

  const waitUntilIdle = async () => {
    while (!stopped) {
      const token = applyGeneration;
      const namespaceId = currentNamespaceId;
      const pending = latestReady;
      await pending;
      if (stopped) return currentNamespaceId;
      if (token === applyGeneration && namespaceId === currentNamespaceId && latestReady === pending) {
        return currentNamespaceId;
      }
    }
    return currentNamespaceId;
  };

  const apply = (state) => {
    const nextOwnerId = ownerIdFromAuthState(state);
    if (nextOwnerId === undefined) return currentNamespaceId;

    // Flip identity first (no storage I/O) so a throwing migrate cannot leave
    // auth on B while the previous owner's UI is still rendered.
    storage.setOwner(nextOwnerId, { migrate: false });
    const namespaceId = storage.getNamespaceId?.() ?? storage.getOwnerId();
    if (namespaceId !== currentNamespaceId) {
      const previousNamespaceId = currentNamespaceId;
      currentNamespaceId = namespaceId;
      try {
        onOwnerChange?.(storage.getOwnerId(), previousNamespaceId);
      } catch {
        // Destination is already selected. A throwing listener must not revert
        // the owner or leave another namespace eligible for writes.
      }
    }

    const token = ++applyGeneration;
    const migrate = typeof storage.ensureLegacyMigratedAsync === 'function'
      ? storage.ensureLegacyMigratedAsync()
      : Promise.resolve();
    latestReady = Promise.resolve(migrate).then(() => {
      if (stopped || token !== applyGeneration) return namespaceId;
      try {
        onOwnerReady?.(storage.getOwnerId());
      } catch {
        // Destination is already migrated. Listener failures stay isolated.
      }
      return namespaceId;
    }, () => {
      if (stopped || token !== applyGeneration) return namespaceId;
      try {
        onOwnerReady?.(storage.getOwnerId());
      } catch {
        // Lock rejection still notifies the current owner generation once.
      }
      return namespaceId;
    });
    return namespaceId;
  };

  apply(auth.getState());
  const unsubscribe = auth.subscribe(apply);
  const stop = () => {
    stopped = true;
    applyGeneration += 1;
    unsubscribe();
  };
  Object.defineProperty(stop, 'ready', {
    configurable: true,
    get() {
      return waitUntilIdle();
    },
  });
  return stop;
}
