/* ==========================================================================
   STORAGE SERVICE - LOCALSTORAGE MANAGEMENT & PERSISTENCE
   ========================================================================== */

export const ANONYMOUS_OWNER_ID = 'anonymous';

export const DEVICE_STORAGE_KEYS = Object.freeze({
  MAPBOX_TOKEN: 'neighborhood_guru_mapbox_token',
  JAMBASE_TOKEN: 'neighborhood_guru_jambase_token',
  MAP_STYLE: 'neighborhood_guru_map_style',
});

export const WORKING_COPY_KEYS = Object.freeze({
  HOME_ADDRESS: 'home_address',
  SAVED_PLACES: 'saved_places',
  SYNC_CONSENT: 'sync_consent',
  DIRTY: 'dirty',
  LAST_ETAG: 'last_etag',
});

export const LEGACY_WORKING_COPY_KEYS = Object.freeze({
  [WORKING_COPY_KEYS.HOME_ADDRESS]: 'neighborhood_guru_home_address',
  [WORKING_COPY_KEYS.SAVED_PLACES]: 'neighborhood_guru_saved_places',
});

/** Reserved, non-adoptable keys for divergent leftovers that must not follow a later account. */
export const ORPHANED_WORKING_COPY_PREFIX = 'neighborhood_guru:orphaned:';

/** Durable claim tying an unprefixed leftover to the namespace that started migrating it. */
export const LEGACY_MIGRATION_CLAIM_PREFIX = 'neighborhood_guru:legacy-claim:';

/** Web Lock name for serializing one-time legacy bootstrap across tabs. */
export const LEGACY_MIGRATION_LOCK_NAME = 'neighborhood-guru:legacy-migration';

export function orphanedWorkingCopyKey(suffix, token = '') {
  return token
    ? `${ORPHANED_WORKING_COPY_PREFIX}${suffix}:${token}`
    : `${ORPHANED_WORKING_COPY_PREFIX}${suffix}`;
}

export function legacyMigrationClaimKey(suffix) {
  return `${LEGACY_MIGRATION_CLAIM_PREFIX}${suffix}`;
}

export function isOrphanedWorkingCopyKey(key) {
  return typeof key === 'string' && key.startsWith(ORPHANED_WORKING_COPY_PREFIX);
}

// Default Sample Neighborhood Data if storage is empty
const DEMO_PLACES = [
  {
    id: 'demo-1',
    source: 'demo',
    name: 'Oak Street Bakery & Cafe',
    category: 'favorite',
    people: ['Chef Elena'],
    contacts: [
      { type: 'phone_work', label: 'Order Line', value: '(555) 345-6789' },
      { type: 'email_work', label: 'Catering Email', value: 'hello@oakstreetbakery.com' }
    ],
    events: [
      { title: "Farmer's Market & Fresh Bread", day: 'friday', time: '8:00 AM - 1:00 PM' }
    ],
    address: '102 Oak Street',
    notes: 'Best sourdough and espresso in the neighborhood. Closed Mondays.',
    color: '#f59e0b',
    lat: 37.7749,
    lng: -122.4194,
    createdAt: Date.now() - 86400000 * 5,
  },
  {
    id: 'demo-2',
    source: 'demo',
    name: 'The Millers (Neighbors)',
    category: 'neighbor',
    people: ['Bob Miller', 'Karen Miller'],
    contacts: [
      { type: 'phone_mobile', label: 'Bob Cell', value: '(555) 987-6543' },
      { type: 'phone_home', label: 'House Landline', value: '(555) 987-1122' },
      { type: 'email_personal', label: 'Karen Email', value: 'millers742@gmail.com' }
    ],
    events: [
      { title: 'Trash & Recycling Pickup', day: 'tuesday', time: '7:00 AM' }
    ],
    address: '742 Evergreen Terrace',
    notes: 'Friendly neighbors. Have spare house key & key to water shutoff.',
    color: '#10b981',
    lat: 37.7765,
    lng: -122.4170,
    createdAt: Date.now() - 86400000 * 2,
  }
];

const DAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function normalizeOwnerId(ownerId) {
  if (ownerId == null) return ANONYMOUS_OWNER_ID;
  if (typeof ownerId !== 'string') {
    throw new TypeError('Owner id must be a string or null');
  }
  if (ownerId.trim().length === 0) return ANONYMOUS_OWNER_ID;
  return ownerId;
}

/**
 * Namespaced localStorage key for a logical owner.
 * `null` / blank / the canonical unsigned-in token use the anonymous tag.
 * Any authenticated user.id, including the string "anonymous", uses a distinct
 * `user:` tag and encodeURIComponent so AuthClient ids stay injective.
 */
export function workingCopyKey(ownerId, suffix) {
  if (ownerId == null || ownerId === ANONYMOUS_OWNER_ID || (typeof ownerId === 'string' && ownerId.trim().length === 0)) {
    return `neighborhood_guru:${ANONYMOUS_OWNER_ID}:${suffix}`;
  }
  if (typeof ownerId !== 'string') {
    throw new TypeError('Owner id must be a string or null');
  }
  return `neighborhood_guru:user:${encodeURIComponent(ownerId)}:${suffix}`;
}

export function authenticatedWorkingCopyKey(userId, suffix) {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new TypeError('Authenticated owner id must be a non-empty string');
  }
  return `neighborhood_guru:user:${encodeURIComponent(userId)}:${suffix}`;
}

export function isDemoSeedId(id) {
  const value = String(id || '');
  return value === 'demo-1' || value === 'demo-2';
}

export function isDemoPlace(place) {
  if (!place || typeof place !== 'object') return false;
  if (place.source === 'demo') return true;
  return isDemoSeedId(place.id);
}

const DEMO_COMPARE_OMIT = new Set(['id', 'source', 'createdAt', 'updatedAt']);

function demoContentSnapshot(place) {
  const snapshot = {};
  for (const key of Object.keys(place).sort()) {
    if (DEMO_COMPARE_OMIT.has(key)) continue;
    snapshot[key] = place[key];
  }
  return JSON.stringify(snapshot);
}

export function isUntouchedDemoSeed(place) {
  if (!isDemoPlace(place)) return false;
  const seed = DEMO_PLACES.find((candidate) => candidate.id === place.id);
  if (!seed) return false;
  return demoContentSnapshot(place) === demoContentSnapshot(seed);
}

export function isUserAuthoredWorkingCopy({ homeAddress = null, savedPlaces = [] } = {}) {
  if (homeAddress) return true;
  return (Array.isArray(savedPlaces) ? savedPlaces : []).some((place) => !isDemoPlace(place));
}

export function isEventHappeningToday(event) {
  if (!event || !event.day) return false;
  const today = new Date();
  const currentDayNum = today.getDay(); // 0 = Sun, 1 = Mon, ..., 5 = Fri, 6 = Sat
  
  const targetDay = String(event.day).toLowerCase();
  
  if (targetDay === 'daily') return true;
  if (targetDay === 'weekdays' && currentDayNum >= 1 && currentDayNum <= 5) return true;
  if (targetDay === 'weekends' && (currentDayNum === 0 || currentDayNum === 6)) return true;
  
  if (DAY_MAP[targetDay] !== undefined && DAY_MAP[targetDay] === currentDayNum) {
    return true;
  }
  
  return false;
}

export function getPlaceEvents(place) {
  if (place && Array.isArray(place.events)) {
    return place.events.map(e => ({
      title: e.title || '',
      day: e.day || 'friday',
      time: e.time || '',
    }));
  }
  return [];
}

export function getPlacePeople(place) {
  if (place && Array.isArray(place.people)) {
    return place.people.filter(p => p && typeof p === 'string' && p.trim() !== '');
  }
  return [];
}

export function getPlaceContacts(place) {
  if (place && Array.isArray(place.contacts)) {
    return place.contacts.map(c => ({
      type: c.type || 'phone_mobile',
      label: c.label || '',
      value: c.value || '',
    }));
  }
  return [];
}

function isModernPlace(place) {
  return (
    place &&
    typeof place === 'object' &&
    Array.isArray(place.people) &&
    Array.isArray(place.contacts) &&
    !('contactName' in place) &&
    !('phone' in place) &&
    !('email' in place)
  );
}

function clonePlaces(places) {
  return JSON.parse(JSON.stringify(places));
}

function readItem(key) {
  return localStorage.getItem(key);
}

function writeItem(key, value) {
  localStorage.setItem(key, value);
}

function removeItem(key) {
  localStorage.removeItem(key);
}

function mintPlaceId() {
  return `place_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function parseJsonOr(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function storageValuesEquivalent(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(JSON.parse(left)) === JSON.stringify(JSON.parse(right));
  } catch {
    return false;
  }
}

function namespaceKey(anonymous, ownerId, suffix) {
  return anonymous ? workingCopyKey(null, suffix) : authenticatedWorkingCopyKey(ownerId, suffix);
}

function namespaceIdFor(anonymous, ownerId) {
  return anonymous ? ANONYMOUS_OWNER_ID : `user:${ownerId}`;
}

function listStorageKeys() {
  const keys = [];
  if (typeof localStorage === 'undefined' || localStorage == null) return keys;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key != null) keys.push(key);
  }
  return keys;
}

export const ORPHAN_ENVELOPE_VERSION = 1;

function matchesCopiedValue(value, copied) {
  return value === copied || storageValuesEquivalent(value, copied);
}

function mintNonce() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function migrationInterleave(phase, detail) {
  try {
    return globalThis.__NG_MIGRATION_INTERLEAVE__?.(phase, detail);
  } catch {
    // Test hooks must not break fail-closed migration.
  }
  return undefined;
}

/**
 * Absent vs present-but-invalid vs valid. Invalid claims fail closed: do not
 * copy or delete the leftover, and do not overwrite the claim.
 */
function inspectMigrationClaim(suffix) {
  const raw = readItem(legacyMigrationClaimKey(suffix));
  if (raw == null) return { kind: 'absent' };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'invalid' };
    if (typeof parsed.namespaceId !== 'string' || parsed.namespaceId.length === 0) return { kind: 'invalid' };
    if (typeof parsed.nonce !== 'string' || parsed.nonce.length === 0) return { kind: 'invalid' };
    return { kind: 'valid', claim: parsed };
  } catch {
    return { kind: 'invalid' };
  }
}

function writeMigrationClaim(suffix, claim) {
  writeItem(legacyMigrationClaimKey(suffix), JSON.stringify(claim));
}

function claimStillHeld(suffix, nonce, namespaceId) {
  const inspected = inspectMigrationClaim(suffix);
  return inspected.kind === 'valid'
    && inspected.claim.nonce === nonce
    && inspected.claim.namespaceId === namespaceId;
}

function claimStatus(claim) {
  return typeof claim?.status === 'string' ? claim.status : '';
}

function isPendingMatchingClaim(claim, namespaceId, fingerprint) {
  return Boolean(claim)
    && claim.namespaceId === namespaceId
    && claimStatus(claim) === 'pending'
    && matchesCopiedValue(claim.fingerprint, fingerprint);
}

function claimOutcomeFromInspection(inspected, namespaceId, fingerprint) {
  if (inspected.kind === 'invalid') return { ok: false, reason: 'invalid' };
  if (inspected.kind === 'valid' && inspected.claim.namespaceId !== namespaceId) {
    return { ok: false, reason: 'foreign', claim: inspected.claim };
  }
  if (inspected.kind === 'valid') {
    if (!isPendingMatchingClaim(inspected.claim, namespaceId, fingerprint)) {
      return { ok: false, reason: claimStatus(inspected.claim) === 'pending' ? 'fingerprint-mismatch' : 'completed', claim: inspected.claim };
    }
    return { ok: true, nonce: inspected.claim.nonce, existing: true, claim: inspected.claim };
  }
  return null;
}

export function webMigrationLocksAvailable() {
  return typeof globalThis.navigator?.locks?.request === 'function';
}

/**
 * Compare-and-swap claim. Re-reads immediately before and after the write so
 * a last-writer-wins localStorage value cannot let two namespaces both copy.
 * Never overwrites a present claim (valid or invalid).
 */
function tryAcquireClaim(suffix, namespaceId, fingerprint) {
  const before = inspectMigrationClaim(suffix);
  const early = claimOutcomeFromInspection(before, namespaceId, fingerprint);
  if (early) return early;

  migrationInterleave('after-absent-claim-read', { suffix, namespaceId });
  const afterRead = inspectMigrationClaim(suffix);
  const afterReadOutcome = claimOutcomeFromInspection(afterRead, namespaceId, fingerprint);
  if (afterReadOutcome) return afterReadOutcome;

  const nonce = mintNonce();
  const claim = {
    nonce,
    namespaceId,
    fingerprint,
    status: 'pending',
    claimedAt: Date.now(),
  };
  migrationInterleave('before-claim-write', { suffix, namespaceId, nonce });
  const preWrite = inspectMigrationClaim(suffix);
  const preWriteOutcome = claimOutcomeFromInspection(preWrite, namespaceId, fingerprint);
  if (preWriteOutcome) return preWriteOutcome;
  if (preWrite.kind !== 'absent') return { ok: false, reason: 'invalid' };
  writeMigrationClaim(suffix, claim);
  migrationInterleave('after-claim-write', { suffix, namespaceId, nonce });
  if (!claimStillHeld(suffix, nonce, namespaceId)) {
    return { ok: false, reason: 'lost-race' };
  }
  return { ok: true, nonce, existing: false, claim };
}

function updateHeldClaim(suffix, nonce, namespaceId, patch) {
  if (!claimStillHeld(suffix, nonce, namespaceId)) return false;
  const inspected = inspectMigrationClaim(suffix);
  if (inspected.kind !== 'valid') return false;
  writeMigrationClaim(suffix, { ...inspected.claim, ...patch });
  return claimStillHeld(suffix, nonce, namespaceId);
}

function wrapOrphanEnvelope(suffix, raw, namespaceId, recoveredFrom = 'legacy-conflict') {
  return JSON.stringify({
    v: ORPHAN_ENVELOPE_VERSION,
    namespaceId: namespaceId ?? null,
    suffix,
    raw,
    recoveredFrom,
    quarantinedAt: Date.now(),
  });
}

function parseOrphanEnvelope(stored) {
  const parsed = parseJsonOr(stored, null);
  if (parsed && parsed.v === ORPHAN_ENVELOPE_VERSION && typeof parsed.raw === 'string') {
    return {
      envelope: true,
      namespaceId: typeof parsed.namespaceId === 'string' && parsed.namespaceId.length > 0
        ? parsed.namespaceId
        : null,
      suffix: typeof parsed.suffix === 'string' ? parsed.suffix : null,
      raw: parsed.raw,
      recoveredFrom: parsed.recoveredFrom || 'legacy-conflict',
    };
  }
  return {
    envelope: false,
    namespaceId: null,
    suffix: null,
    raw: stored,
    recoveredFrom: 'legacy-conflict',
  };
}

/**
 * Move a leftover off the adoptable unprefixed key. The envelope stamps the
 * claiming namespace so another account cannot preview/restore it.
 */
function writeItemVerified(key, value) {
  try {
    globalThis.__NG_STORAGE_WRITE_HOOK__?.({ key, value });
  } catch (err) {
    throw err;
  }
  writeItem(key, value);
  return readItem(key) === value;
}

function writeUniqueOrphanEnvelope(suffix, envelope) {
  for (let i = 0; i < 24; i += 1) {
    const candidate = orphanedWorkingCopyKey(suffix, `${mintNonce()}-${i}`);
    if (readItem(candidate) != null) continue;
    migrationInterleave('after-orphan-overflow-absent-read', { suffix, candidate });
    if (readItem(candidate) != null) continue;
    if (writeItemVerified(candidate, envelope)) return true;
  }
  return false;
}

function writeOrphanEnvelope(suffix, envelope, incomingRaw, incomingNamespaceId) {
  const primary = orphanedWorkingCopyKey(suffix);
  const existing = readItem(primary);
  migrationInterleave('after-orphan-absent-read', {
    suffix,
    primary,
    absent: existing == null,
  });
  const existingNow = readItem(primary);
  if (existingNow == null) {
    if (!writeItemVerified(primary, envelope)) return false;
    return true;
  }
  const existingParsed = parseOrphanEnvelope(existingNow);
  if (existingParsed.raw === incomingRaw && existingParsed.namespaceId === incomingNamespaceId) {
    return true;
  }
  return writeUniqueOrphanEnvelope(suffix, envelope);
}

async function commitImportedOrphan(orphan, envelope, namespaceId) {
  const preferred = orphan.preferredKey;
  const existing = readItem(preferred);
  await Promise.resolve(migrationInterleave('after-orphan-absent-read', {
    suffix: orphan.suffix,
    primary: preferred,
    absent: existing == null,
  }));
  const existingNow = readItem(preferred);
  if (existingNow != null) {
    const existingParsed = parseOrphanEnvelope(existingNow);
    if (existingParsed.raw === orphan.raw && existingParsed.namespaceId === namespaceId) {
      return;
    }
    if (!writeOrphanEnvelope(orphan.suffix, envelope, orphan.raw, namespaceId)) {
      throw new Error('orphan-write-failed');
    }
    return;
  }
  // Two tabs can both observe the preferred key absent. localStorage cannot
  // CAS, so never share that slot: mint a unique key inside this transaction.
  if (!writeUniqueOrphanEnvelope(orphan.suffix, envelope)) {
    throw new Error('orphan-write-failed');
  }
}

function quarantineLegacyValue(suffix, value, namespaceId = null) {
  const envelope = wrapOrphanEnvelope(suffix, value, namespaceId);
  return writeOrphanEnvelope(suffix, envelope, value, namespaceId ?? null);
}

function deviceQuarantineLegacyValue(suffix, value) {
  return quarantineLegacyValue(suffix, value, null);
}

/**
 * True when leftover exists for a suffix whose destination is still empty.
 * After exclusive copy the unprefixed key is retained, but dest is populated
 * so demos may seed and the recovery banner should not nag restore.
 */
function leftoverUnappliedForOwner(anonymous, ownerId) {
  for (const [suffix, legacyKey] of Object.entries(LEGACY_WORKING_COPY_KEYS)) {
    const leftover = readItem(legacyKey);
    if (leftover == null) continue;
    const dest = readItem(namespaceKey(anonymous, ownerId, suffix));
    if (dest == null) return true;
  }
  return false;
}

/**
 * Leftover unprefixed keys are retained while older writers may still exist.
 * Claim provenance blocks cross-owner adoption. A newer leftover value is
 * copied into orphan recovery, but the unprefixed key is never deleted here.
 */
function retainLegacyIfClaimHeld(legacyKey, expected, suffix, namespaceId, nonce) {
  migrationInterleave('before-remove', { suffix, namespaceId, nonce, expected });
  if (nonce && !claimStillHeld(suffix, nonce, namespaceId)) return false;
  const latest = readItem(legacyKey);
  if (latest != null && !matchesCopiedValue(latest, expected)) {
    quarantineLegacyValue(suffix, latest, namespaceId);
  }
  return !nonce || claimStillHeld(suffix, nonce, namespaceId);
}

let exclusiveMigrationDepth = 0;
let mutationLockDepth = 0;

function runFailClosedLegacyMigration(_anonymous, _ownerId) {
  // Unlocked / synchronous path: never copy into a namespace, never delete
  // leftover, never hide it in device recovery. Exclusive adoption requires
  // a held Web Lock. Existing users keep the unprefixed record.
  void _anonymous;
  void _ownerId;
}

/**
 * Owner flipped between scheduling migration and receiving the Web Lock.
 * Do not copy into the live owner. Leftover stays on the unprefixed key.
 */
function runOwnerMismatchFailClosed() {
  // Intentionally empty: deleting or device-quarantining leftover can hide
  // a newer uncoordinated write and reset existing users.
}

function runExclusiveLegacyMigration(anonymous, ownerId) {
  const namespaceId = namespaceIdFor(anonymous, ownerId);
  exclusiveMigrationDepth += 1;
  try {
    for (const [suffix, legacyKey] of Object.entries(LEGACY_WORKING_COPY_KEYS)) {
      try {
        const copied = readItem(legacyKey);
        const inspected = inspectMigrationClaim(suffix);

        if (inspected.kind === 'invalid') {
          continue;
        }

        if (copied == null) {
          continue;
        }

        if (inspected.kind === 'valid' && inspected.claim.namespaceId !== namespaceId) {
          continue;
        }

        if (inspected.kind === 'valid' && !isPendingMatchingClaim(inspected.claim, namespaceId, copied)) {
          continue;
        }

        const acquired = tryAcquireClaim(suffix, namespaceId, copied);
        if (!acquired.ok) {
          continue;
        }

        const { nonce } = acquired;
        migrationInterleave('before-copy', { suffix, namespaceId, nonce });
        if (!claimStillHeld(suffix, nonce, namespaceId)) continue;

        const sourceNow = readItem(legacyKey);
        if (sourceNow == null) {
          updateHeldClaim(suffix, nonce, namespaceId, { status: 'migrated' });
          continue;
        }
        if (!claimStillHeld(suffix, nonce, namespaceId)) continue;

        if (!matchesCopiedValue(sourceNow, copied)) {
          if (deviceQuarantineLegacyValue(suffix, sourceNow)
            && retainLegacyIfClaimHeld(legacyKey, sourceNow, suffix, namespaceId, nonce)) {
            updateHeldClaim(suffix, nonce, namespaceId, { status: 'orphaned', fingerprint: copied });
          }
          continue;
        }

        const destKey = namespaceKey(anonymous, ownerId, suffix);
        const dest = readItem(destKey);
        if (dest == null) {
          if (!claimStillHeld(suffix, nonce, namespaceId)) continue;
          writeItem(destKey, sourceNow);
        }

        const destNow = readItem(destKey);
        if (!claimStillHeld(suffix, nonce, namespaceId)) continue;

        const destMatches = destNow != null && matchesCopiedValue(destNow, sourceNow);
        if (destMatches) {
          if (retainLegacyIfClaimHeld(legacyKey, sourceNow, suffix, namespaceId, nonce)) {
            updateHeldClaim(suffix, nonce, namespaceId, { status: 'migrated', fingerprint: sourceNow });
          }
          continue;
        }

        if (destNow == null) continue;

        if (!claimStillHeld(suffix, nonce, namespaceId)) continue;
        if (quarantineLegacyValue(suffix, sourceNow, namespaceId)
          && retainLegacyIfClaimHeld(legacyKey, sourceNow, suffix, namespaceId, nonce)) {
          updateHeldClaim(suffix, nonce, namespaceId, { status: 'orphaned', fingerprint: sourceNow });
        }
      } catch {
        // Claim, if held, still binds this leftover. Other namespaces must not adopt.
      }
    }
  } finally {
    exclusiveMigrationDepth -= 1;
  }
}

/**
 * One-time local bootstrap of unprefixed keys. Exclusive adoption runs only
 * while holding `navigator.locks`. The synchronous path never copies into the
 * active namespace and never deletes leftover.
 */
function migrateLegacyWorkingCopy(anonymous, ownerId) {
  if (exclusiveMigrationDepth > 0) {
    return;
  }
  runFailClosedLegacyMigration(anonymous, ownerId);
}

export async function withLegacyMigrationWebLock(fn) {
  const locks = globalThis.navigator?.locks;
  if (locks && typeof locks.request === 'function') {
    try {
      return await Promise.resolve(
        locks.request(LEGACY_MIGRATION_LOCK_NAME, { mode: 'exclusive' }, () => fn()),
      );
    } catch {
      return { lockRejected: true };
    }
  }
  return { lockUnavailable: true };
}

async function withMutationWebLock(fn) {
  if (mutationLockDepth > 0 || exclusiveMigrationDepth > 0) {
    return await Promise.resolve(fn());
  }
  if (!webMigrationLocksAvailable()) {
    const error = new Error('mutation-lock-unavailable');
    error.code = 'mutation-lock-unavailable';
    throw error;
  }
  const result = await withLegacyMigrationWebLock(async () => {
    mutationLockDepth += 1;
    try {
      return await Promise.resolve(fn());
    } finally {
      mutationLockDepth -= 1;
    }
  });
  if (result && (result.lockRejected || result.lockUnavailable)) {
    const error = new Error(result.lockRejected ? 'mutation-lock-rejected' : 'mutation-lock-unavailable');
    error.code = result.lockRejected ? 'mutation-lock-rejected' : 'mutation-lock-unavailable';
    throw error;
  }
  return result;
}

function snapshotAllStorage() {
  const snap = {};
  for (const key of listStorageKeys()) {
    snap[key] = readItem(key);
  }
  return snap;
}

function restoreAllStorage(snap) {
  for (const key of listStorageKeys()) {
    if (!Object.prototype.hasOwnProperty.call(snap, key)) {
      try {
        removeItem(key);
      } catch {
        // Best-effort rollback.
      }
    }
  }
  for (const [key, value] of Object.entries(snap)) {
    try {
      if (value == null) removeItem(key);
      else writeItem(key, value);
    } catch {
      // Best-effort rollback.
    }
  }
}

function storageMatchesSnapshot(snap) {
  const now = snapshotAllStorage();
  const keys = new Set([...Object.keys(now), ...Object.keys(snap)]);
  for (const key of keys) {
    if (now[key] !== snap[key]) return false;
  }
  return true;
}

function leftoverPreview(suffix, raw) {
  if (suffix === WORKING_COPY_KEYS.HOME_ADDRESS) {
    const parsed = parseJsonOr(raw, null);
    const home = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    return {
      homeAddress: home,
      savedPlaces: null,
      preview: { homeName: home?.name ?? null, placeNames: [], placeCount: 0 },
    };
  }
  if (suffix === WORKING_COPY_KEYS.SAVED_PLACES) {
    const parsed = parseJsonOr(raw, null);
    const places = Array.isArray(parsed) ? parsed : null;
    return {
      homeAddress: null,
      savedPlaces: places,
      preview: {
        homeName: null,
        placeNames: Array.isArray(places) ? places.map((place) => place?.name).filter(Boolean) : [],
        placeCount: Array.isArray(places) ? places.length : 0,
      },
    };
  }
  return {
    homeAddress: null,
    savedPlaces: null,
    preview: { homeName: null, placeNames: [], placeCount: 0 },
  };
}

function listUnprefixedLeftovers() {
  return Object.entries(LEGACY_WORKING_COPY_KEYS).map(([suffix, legacyKey]) => {
    const raw = readItem(legacyKey);
    if (raw == null) return null;
    const inspected = inspectMigrationClaim(suffix);
    return {
      key: legacyKey,
      suffix,
      raw,
      claimKind: inspected.kind,
      claim: inspected.kind === 'valid' ? inspected.claim : null,
      ...leftoverPreview(suffix, raw),
    };
  }).filter(Boolean);
}

function orphanSuffixFromKey(key) {
  const rest = key.slice(ORPHANED_WORKING_COPY_PREFIX.length);
  const suffixes = Object.values(WORKING_COPY_KEYS).slice().sort((a, b) => b.length - a.length);
  for (const suffix of suffixes) {
    if (rest === suffix) return { suffix, token: '' };
    if (rest.startsWith(`${suffix}:`)) return { suffix, token: rest.slice(suffix.length + 1) };
  }
  return { suffix: rest, token: '' };
}

function decodeOrphanedRecord(key, stored) {
  const { suffix: keySuffix, token } = orphanSuffixFromKey(key);
  const envelope = parseOrphanEnvelope(stored);
  const suffix = envelope.suffix || keySuffix;
  const raw = envelope.raw;
  const record = {
    key,
    suffix,
    token,
    status: 'orphaned',
    recoveredFrom: envelope.recoveredFrom || 'legacy-conflict',
    namespaceId: envelope.namespaceId,
    deviceLevel: envelope.namespaceId == null,
    raw,
    homeAddress: null,
    savedPlaces: null,
  };
  if (suffix === WORKING_COPY_KEYS.HOME_ADDRESS) {
    const parsed = parseJsonOr(raw, null);
    record.homeAddress = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } else if (suffix === WORKING_COPY_KEYS.SAVED_PLACES) {
    const parsed = parseJsonOr(raw, null);
    record.savedPlaces = Array.isArray(parsed) ? parsed : null;
  }
  record.preview = {
    homeName: record.homeAddress?.name ?? null,
    placeNames: Array.isArray(record.savedPlaces)
      ? record.savedPlaces.map((place) => place?.name).filter(Boolean)
      : [],
    placeCount: Array.isArray(record.savedPlaces) ? record.savedPlaces.length : 0,
  };
  record.valid = suffix === WORKING_COPY_KEYS.HOME_ADDRESS
    ? record.homeAddress != null
    : suffix === WORKING_COPY_KEYS.SAVED_PLACES
      ? Array.isArray(record.savedPlaces)
      : false;
  return record;
}

function orphanBelongsToNamespace(record, namespaceId) {
  return Boolean(record && !record.deviceLevel && record.namespaceId === namespaceId);
}

function mergePlaceLists(current, incoming) {
  const merged = Array.isArray(current) ? [...current] : [];
  const seen = new Set(merged.map((place) => String(place?.id || '')).filter(Boolean));
  for (const place of Array.isArray(incoming) ? incoming : []) {
    if (!place || typeof place !== 'object') continue;
    const id = place.id != null ? String(place.id) : '';
    if (id && seen.has(id)) continue;
    merged.push(place);
    if (id) seen.add(id);
  }
  return merged;
}

function promoteEditedDemoPlaces(places) {
  let changed = false;
  const next = places.map((place) => {
    if (!isDemoPlace(place) || isUntouchedDemoSeed(place)) return place;
    changed = true;
    const promoted = { ...place, id: mintPlaceId(), updatedAt: Date.now() };
    delete promoted.source;
    return promoted;
  });
  return { places: next, changed };
}

function readWorkingCopy(anonymous, ownerId, suffix) {
  migrateLegacyWorkingCopy(anonymous, ownerId);
  return readItem(namespaceKey(anonymous, ownerId, suffix));
}

function writeWorkingCopy(anonymous, ownerId, suffix, value) {
  migrateLegacyWorkingCopy(anonymous, ownerId);
  writeItem(namespaceKey(anonymous, ownerId, suffix), value);
}

function removeWorkingCopy(anonymous, ownerId, suffix) {
  migrateLegacyWorkingCopy(anonymous, ownerId);
  removeItem(namespaceKey(anonymous, ownerId, suffix));
}

export const StorageService = {
  _ownerId: ANONYMOUS_OWNER_ID,
  _anonymous: true,

  getOwnerId() {
    return this._anonymous ? ANONYMOUS_OWNER_ID : this._ownerId;
  },

  getNamespaceId() {
    return this._anonymous ? ANONYMOUS_OWNER_ID : `user:${this._ownerId}`;
  },

  /**
   * Switch the working copy. Does not copy values between namespaces.
   * `null` selects the unsigned-in anonymous namespace. An authenticated
   * user.id of `"anonymous"` is stored under the distinct `user:` tag.
   *
   * Identity is applied before any localStorage I/O. Pass `{ migrate: false }`
   * to flip the owner without touching storage so callers can clear UI first.
   */
  setOwner(ownerId, { migrate = true } = {}) {
    if (ownerId == null || (typeof ownerId === 'string' && ownerId.trim().length === 0)) {
      this._anonymous = true;
      this._ownerId = ANONYMOUS_OWNER_ID;
    } else if (typeof ownerId !== 'string') {
      throw new TypeError('Owner id must be a string or null');
    } else {
      this._anonymous = false;
      this._ownerId = ownerId;
    }
    if (migrate) {
      runFailClosedLegacyMigration(this._anonymous, this._ownerId);
    }
    return this.getOwnerId();
  },

  ensureLegacyMigrated() {
    runFailClosedLegacyMigration(this._anonymous, this._ownerId);
  },

  async ensureLegacyMigratedAsync() {
    const anonymous = this._anonymous;
    const ownerId = this._ownerId;
    const namespaceId = namespaceIdFor(anonymous, ownerId);
    if (webMigrationLocksAvailable()) {
      await withLegacyMigrationWebLock(() => {
        const liveNamespaceId = namespaceIdFor(this._anonymous, this._ownerId);
        if (liveNamespaceId !== namespaceId) {
          runOwnerMismatchFailClosed();
          return { ok: true };
        }
        runExclusiveLegacyMigration(anonymous, ownerId);
        return { ok: true };
      });
      return;
    }
    runFailClosedLegacyMigration(anonymous, ownerId);
  },

  listPendingLegacyWorkingCopies() {
    return listUnprefixedLeftovers();
  },

  legacyMigrationStatus() {
    const leftovers = listUnprefixedLeftovers();
    const leftoverUnapplied = leftoverUnappliedForOwner(this._anonymous, this._ownerId);
    return {
      leftoverPresent: leftovers.length > 0,
      leftoverUnapplied,
      locksAvailable: webMigrationLocksAvailable(),
      leftovers,
      ownerOrphans: this.listOrphanedWorkingCopies(),
      deviceOrphans: this.listDeviceOrphanedWorkingCopies(),
    };
  },

  /**
   * Test-only nested exclusive helper for claim-race interleaving.
   * Production must use `ensureLegacyMigratedAsync`. Without an exclusive
   * lock already held, leftovers are fail-closed (no unlocked copy).
   */
  migrateLegacyForOwner(ownerId) {
    const anonymous = ownerId == null
      || ownerId === ANONYMOUS_OWNER_ID
      || (typeof ownerId === 'string' && ownerId.trim().length === 0);
    const resolvedOwnerId = anonymous ? ANONYMOUS_OWNER_ID : ownerId;
    if (exclusiveMigrationDepth > 0) {
      runExclusiveLegacyMigration(anonymous, resolvedOwnerId);
      return;
    }
    runFailClosedLegacyMigration(anonymous, resolvedOwnerId);
  },

  workingCopyKey(suffix) {
    return namespaceKey(this._anonymous, this._ownerId, suffix);
  },

  /**
   * Mapbox Access Token (device-level — not namespaced)
   */
  getMapboxToken() {
    return readItem(DEVICE_STORAGE_KEYS.MAPBOX_TOKEN) || import.meta.env.VITE_MAPBOX_TOKEN || '';
  },

  setMapboxToken(token) {
    writeItem(DEVICE_STORAGE_KEYS.MAPBOX_TOKEN, token.trim());
  },

  /**
   * JamBase API Key / Token (device-level — not namespaced)
   */
  getJambaseToken() {
    return readItem(DEVICE_STORAGE_KEYS.JAMBASE_TOKEN) || import.meta.env.VITE_JAMBASE_TOKEN || '';
  },

  setJambaseToken(token) {
    writeItem(DEVICE_STORAGE_KEYS.JAMBASE_TOKEN, token.trim());
  },

  /**
   * Home Address Object { name, lat, lng, formattedAddress }
   */
  getHomeAddress() {
    const raw = readWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.HOME_ADDRESS);
    const parsed = parseJsonOr(raw, null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  },

  setHomeAddress(addressObj) {
    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.HOME_ADDRESS, JSON.stringify(addressObj));
  },

  clearHomeAddress() {
    removeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.HOME_ADDRESS);
  },

  /**
   * Saved Places Array
   */
  getSavedPlaces() {
    const raw = readWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES);
    if (!raw) {
      if (leftoverUnappliedForOwner(this._anonymous, this._ownerId)) return [];
      const seeded = clonePlaces(DEMO_PLACES);
      writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(seeded));
      return seeded;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      const validModern = parsed.filter(isModernPlace);
      if (validModern.length === 0 && parsed.length !== 0) {
        const seeded = clonePlaces(DEMO_PLACES);
        writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(seeded));
        return seeded;
      }

      const { places: promoted, changed } = promoteEditedDemoPlaces(validModern);
      if (validModern.length !== parsed.length || changed) {
        writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(promoted));
      }
      return promoted;
    } catch (e) {
      return [];
    }
  },

  savePlace(place) {
    const places = this.getSavedPlaces();
    const targetId = place.id && String(place.id).trim() !== '' ? String(place.id) : null;
    const existingIndex = targetId ? places.findIndex(p => String(p.id) === targetId) : -1;

    if (existingIndex >= 0) {
      const previous = places[existingIndex];
      const merged = { ...previous, ...place, updatedAt: Date.now() };
      if (isDemoPlace(previous)) {
        delete merged.source;
        merged.id = mintPlaceId();
      } else {
        merged.id = targetId;
      }
      places[existingIndex] = merged;
    } else {
      places.push({
        ...place,
        id: mintPlaceId(),
        createdAt: Date.now(),
      });
    }

    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(places));
    return places;
  },

  deletePlace(id) {
    const places = this.getSavedPlaces().filter(p => p.id !== id);
    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(places));
    return places;
  },

  /**
   * Per-namespace sync metadata. Login / session restore must not read or
   * write a remote NeighborhoodStore; these keys stay local.
   */
  getSyncConsent() {
    const raw = readWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SYNC_CONSENT);
    if (raw == null) return false;
    try {
      return JSON.parse(raw) === true;
    } catch {
      return raw === 'true';
    }
  },

  setSyncConsent(enabled) {
    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SYNC_CONSENT, JSON.stringify(Boolean(enabled)));
  },

  isDirty() {
    const raw = readWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.DIRTY);
    return raw === '1' || raw === 'true';
  },

  setDirty(dirty) {
    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.DIRTY, dirty ? '1' : '0');
  },

  getLastEtag() {
    return readWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.LAST_ETAG);
  },

  setLastEtag(etag) {
    if (etag == null || etag === '') {
      removeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.LAST_ETAG);
      return;
    }
    writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.LAST_ETAG, String(etag));
  },

  /**
   * Map Style Preference (device-level — not namespaced)
   */
  getPreferredStyle() {
    return readItem(DEVICE_STORAGE_KEYS.MAP_STYLE) || 'streets';
  },

  setPreferredStyle(styleName) {
    writeItem(DEVICE_STORAGE_KEYS.MAP_STYLE, styleName);
  },

  /**
   * Backup Export & Import — current namespace plus clearly marked orphaned leftovers.
   * Orphans are never auto-merged into the working copy; restore/merge is explicit.
   */
  listOrphanedWorkingCopies() {
    const namespaceId = this.getNamespaceId();
    return listStorageKeys()
      .filter(isOrphanedWorkingCopyKey)
      .map((key) => {
        const stored = readItem(key);
        if (stored == null) return null;
        return decodeOrphanedRecord(key, stored);
      })
      .filter((record) => record && orphanBelongsToNamespace(record, namespaceId));
  },

  listDeviceOrphanedWorkingCopies() {
    return listStorageKeys()
      .filter(isOrphanedWorkingCopyKey)
      .map((key) => {
        const stored = readItem(key);
        if (stored == null) return null;
        return decodeOrphanedRecord(key, stored);
      })
      .filter((record) => record && record.deviceLevel);
  },

  previewOrphanedWorkingCopy(key) {
    if (!isOrphanedWorkingCopyKey(key)) return null;
    const stored = readItem(key);
    if (stored == null) return null;
    const record = decodeOrphanedRecord(key, stored);
    if (!orphanBelongsToNamespace(record, this.getNamespaceId())) return null;
    return record;
  },

  previewDeviceOrphanedWorkingCopy(key) {
    if (!isOrphanedWorkingCopyKey(key)) return null;
    const stored = readItem(key);
    if (stored == null) return null;
    const record = decodeOrphanedRecord(key, stored);
    return record.deviceLevel ? record : null;
  },

  previewOrphanedWorkingCopies() {
    return this.listOrphanedWorkingCopies();
  },

  /**
   * Copy a quarantined leftover into the *current* namespace after preview.
   * Only orphans stamped with this namespace are eligible. Device-level
   * historical values must use exportDeviceOrphanedWorkingCopy.
   */
  restoreOrphanedWorkingCopy(key, { mode = 'replace' } = {}) {
    const preview = this.previewOrphanedWorkingCopy(key);
    if (!preview) {
      const stored = isOrphanedWorkingCopyKey(key) ? readItem(key) : null;
      if (stored == null) return { ok: false, reason: 'not-found', preview: null };
      const record = decodeOrphanedRecord(key, stored);
      if (record.deviceLevel) return { ok: false, reason: 'device-level', preview: null };
      return { ok: false, reason: 'wrong-owner', preview: null };
    }

    if (!preview.valid) {
      return { ok: false, reason: 'invalid', preview };
    }

    if (preview.suffix === WORKING_COPY_KEYS.HOME_ADDRESS) {
      const currentHome = this.getHomeAddress();
      if (mode === 'merge' && currentHome) {
        return { ok: false, reason: 'conflict', preview, currentHome };
      }
      const parsed = parseJsonOr(preview.raw, null);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'invalid', preview };
      }
      this.setHomeAddress(parsed);
      return { ok: true, mode, preview };
    }

    if (preview.suffix === WORKING_COPY_KEYS.SAVED_PLACES) {
      const parsed = parseJsonOr(preview.raw, null);
      if (!Array.isArray(parsed)) {
        return { ok: false, reason: 'invalid', preview };
      }
      const next = mode === 'merge'
        ? mergePlaceLists(this.getSavedPlaces(), parsed)
        : parsed;
      writeWorkingCopy(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES, JSON.stringify(next));
      return { ok: true, mode, preview };
    }

    return { ok: false, reason: 'unsupported-suffix', preview };
  },

  /**
   * Device-level recovery does not bind ambiguous leftovers to the active
   * account. Callers can download/export the exact raw payload.
   */
  exportDeviceOrphanedWorkingCopy(key) {
    const preview = this.previewDeviceOrphanedWorkingCopy(key);
    if (!preview) return { ok: false, reason: 'not-found' };
    return {
      ok: true,
      key: preview.key,
      raw: preview.raw,
      recoveredFrom: preview.recoveredFrom,
    };
  },

  exportDataJSON() {
    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      homeAddress: this.getHomeAddress(),
      savedPlaces: this.getSavedPlaces(),
      orphanedWorkingCopies: this.listOrphanedWorkingCopies(),
    };
    return JSON.stringify(backup, null, 2);
  },

  /**
   * Explicit device-level recovery. Ambiguous historical leftovers are not
   * attached to the active account; callers must show provenance warnings.
   */
  exportDeviceRecoveryJSON() {
    return JSON.stringify({
      version: 1,
      kind: 'device-recovery',
      exportedAt: new Date().toISOString(),
      warning: 'These records are not bound to the signed-in account. Review before restoring.',
      pendingLegacyWorkingCopies: this.listPendingLegacyWorkingCopies(),
      deviceOrphanedWorkingCopies: this.listDeviceOrphanedWorkingCopies(),
    }, null, 2);
  },

  async importDataJSON(jsonStr) {
    let data;
    try {
      data = JSON.parse(jsonStr);
    } catch (e) {
      console.error('Failed to parse import JSON', e);
      return false;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (data.homeAddress != null && (typeof data.homeAddress !== 'object' || Array.isArray(data.homeAddress))) {
      return false;
    }
    if (data.savedPlaces != null && !Array.isArray(data.savedPlaces)) return false;

    const preparedOrphans = [];
    const orphans = Array.isArray(data.orphanedWorkingCopies) ? data.orphanedWorkingCopies : [];
    for (const orphan of orphans) {
      if (!orphan || typeof orphan !== 'object') continue;
      let raw = null;
      if (typeof orphan.raw === 'string') {
        raw = orphan.raw;
      } else if (orphan.homeAddress && typeof orphan.homeAddress === 'object' && !Array.isArray(orphan.homeAddress)) {
        raw = JSON.stringify(orphan.homeAddress);
      } else if (Array.isArray(orphan.savedPlaces)) {
        raw = JSON.stringify(orphan.savedPlaces);
      }
      if (raw == null) continue;
      const suffix = typeof orphan.suffix === 'string'
        ? orphan.suffix
        : (typeof orphan.key === 'string' && isOrphanedWorkingCopyKey(orphan.key)
          ? orphanSuffixFromKey(orphan.key).suffix
          : null);
      if (!suffix) continue;
      const preferredKey = typeof orphan.key === 'string' && isOrphanedWorkingCopyKey(orphan.key)
        ? orphan.key
        : orphanedWorkingCopyKey(suffix);
      preparedOrphans.push({
        suffix,
        raw,
        preferredKey,
        recoveredFrom: orphan.recoveredFrom || 'legacy-conflict',
      });
    }

    try {
      return await withMutationWebLock(async () => {
        const snapshot = snapshotAllStorage();
        try {
          const namespaceId = this.getNamespaceId();
          if (data.homeAddress) {
            const raw = JSON.stringify(data.homeAddress);
            if (!writeItemVerified(namespaceKey(this._anonymous, this._ownerId, WORKING_COPY_KEYS.HOME_ADDRESS), raw)) {
              throw new Error('home-write-failed');
            }
          }
          if (Array.isArray(data.savedPlaces)) {
            const raw = JSON.stringify(data.savedPlaces);
            if (!writeItemVerified(namespaceKey(this._anonymous, this._ownerId, WORKING_COPY_KEYS.SAVED_PLACES), raw)) {
              throw new Error('places-write-failed');
            }
          }
          for (const orphan of preparedOrphans) {
            const envelope = wrapOrphanEnvelope(
              orphan.suffix,
              orphan.raw,
              namespaceId,
              orphan.recoveredFrom,
            );
            await commitImportedOrphan(orphan, envelope, namespaceId);
          }
          return true;
        } catch (e) {
          restoreAllStorage(snapshot);
          return false;
        }
      });
    } catch (e) {
      if (e?.code !== 'mutation-lock-unavailable' && e?.code !== 'mutation-lock-rejected') {
        console.error('Failed to import JSON', e);
      }
      return false;
    }
  }
};

/** Independent working-copy owner for two-tab / two-module tests. Shares localStorage. */
export function createStorageService() {
  const service = Object.create(StorageService);
  service._ownerId = ANONYMOUS_OWNER_ID;
  service._anonymous = true;
  return service;
}
