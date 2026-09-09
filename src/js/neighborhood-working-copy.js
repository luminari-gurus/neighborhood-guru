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

  let currentOwnerId = storage.getOwnerId();

  const apply = (state) => {
    const nextOwnerId = ownerIdFromAuthState(state);
    if (nextOwnerId === undefined) return currentOwnerId;
    storage.setOwner(nextOwnerId);
    const ownerId = storage.getOwnerId();
    if (ownerId !== currentOwnerId) {
      const previousOwnerId = currentOwnerId;
      currentOwnerId = ownerId;
      onOwnerChange?.(ownerId, previousOwnerId);
    }
    return ownerId;
  };

  apply(auth.getState());
  const unsubscribe = auth.subscribe(apply);
  return () => unsubscribe();
}
