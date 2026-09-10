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
 */
export function bindNeighborhoodWorkingCopy(
  auth,
  storage = StorageService,
  { onOwnerChange, neighborhoodStore } = {},
) {
  // Reserved so callers/tests can pass a store spy. Must stay unused here.
  void neighborhoodStore;

  let currentNamespaceId = storage.getNamespaceId?.() ?? storage.getOwnerId();

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

    try {
      if (typeof storage.ensureLegacyMigrated === 'function') {
        storage.ensureLegacyMigrated();
      } else {
        storage.setOwner(nextOwnerId);
      }
    } catch {
      // Presentation was already cleared when the owner flipped. A storage
      // exception must not skip that clear or keep the previous view mounted.
    }
    return namespaceId;
  };

  apply(auth.getState());
  const unsubscribe = auth.subscribe(apply);
  return () => unsubscribe();
}
