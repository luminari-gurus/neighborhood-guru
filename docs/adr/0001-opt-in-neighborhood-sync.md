# ADR 0001: Opt-in neighborhood-data sync with a pluggable store

- **Status:** Proposed
- **Date:** 2026-09-08
- **Issue:** [luminari-gurus/neighborhood-guru#7](https://github.com/luminari-gurus/neighborhood-guru/issues/7)
- **Related:** [#1](https://github.com/luminari-gurus/neighborhood-guru/issues/1) (AuthClient), [#2](https://github.com/luminari-gurus/neighborhood-guru/issues/2) (auth backend), [#3](https://github.com/luminari-gurus/neighborhood-guru/issues/3) (OIDC), [#6](https://github.com/luminari-gurus/neighborhood-guru/issues/6) (account linking)

This document decides how optional, **opt-in** neighborhood-data synchronization can exist next to Neighborhood Guru's local-first model without making login an upload, and without locking open-source deployers to one database vendor.

It is a design record only. It does not implement sync, storage adapters, schema migrations for places, or API routes.

---

## Context

Neighborhood Guru today is a static, local-first SPA. Home address and saved places live in browser `localStorage` via `src/js/storage.js`. The export file is a snapshot:

```json
{
  "version": 1,
  "exportedAt": "2026-09-08T12:00:00.000Z",
  "homeAddress": { "name": "…", "lat": 0, "lng": 0, "formattedAddress": "…" },
  "savedPlaces": []
}
```

API tokens are stored under separate keys and are **intentionally excluded** from export. `StorageService.getSavedPlaces()` seeds built-in demo places when the places key is empty.

Authentication ([#1](https://github.com/luminari-gurus/neighborhood-guru/issues/1)–[#3](https://github.com/luminari-gurus/neighborhood-guru/issues/3)) is a separate track: an optional Bun backend, SQLite for users / identities / sessions / login transactions, and a provider-neutral `AuthClient`. Auth PRs must not upload neighborhood data. The auth schema has no tables for places or home address.

Issue [#7](https://github.com/luminari-gurus/neighborhood-guru/issues/7) asks for a design that keeps anonymous/local-only usage, makes login upload-free, requires explicit consent before any keep / upload / replace / merge, namespaces data across account changes, and specifies conflicts, offline behavior, deletion, export, account removal, and a threat/privacy analysis. Secrets must not sync by default.

Open-source deployers may run the app behind Cloudflare Access (or similar). That is an edge gate, not a substitute for per-user namespacing inside the app when sync is enabled. Deployers also need a **modular persistence layer** so Turso (libsql), on-box SQLite, Postgres, or local-only can be chosen without rewriting application code.

---

## Decision drivers

1. **Login is not consent.** Signing in (or restoring a session) must cause zero neighborhood-data upload.
2. **Local-first remains the default**, including for authenticated users who never enable sync.
3. **One store interface, several adapters.** App and API code talk to `NeighborhoodStore`; vendor SDKs stay inside adapters.
4. **Auth data plane ≠ neighborhood data plane.** Separate databases, migrations, configuration, and failure domains even when both happen to use SQLite or libsql.
5. **Honest v1.** Prefer a small, reviewable sync model over CRDTs, field-level merge, or client-side encryption theater.
6. **Reuse the export snapshot** as the interchange document. The working set is already a snapshot; places are a modest personal directory, not a high-churn collaborative graph.
7. **Shared-browser safety.** Account changes must not expose another user's addresses, contacts, or notes.
8. **No secrets on the wire.** Mapbox and JamBase tokens, `AUTH_SECRET`, OIDC client secrets, and store credentials never belong in a neighborhood snapshot.

---

## Decision

### 1. Three modes

| Mode | Auth session | Neighborhood working copy | Remote replica |
| --- | --- | --- | --- |
| **Anonymous local-only** | None (`AuthClient` anonymous / `AUTH_MODE=disabled`) | Browser storage, anonymous namespace | None |
| **Authenticated local-only** | `AuthClient` session present | Browser storage, namespaced by `user.id` | None. Default after login. |
| **Authenticated sync-enabled** | Session present **and** explicit per-user sync consent | Same namespaced working copy | Optional `NeighborhoodStore` replica, chosen at deploy time |

Mode is **not** inferred from `AUTH_MODE`. `AUTH_MODE=required` can still be authenticated local-only. Sync also requires a non-`local` store driver on the server **and** the user's consent flag.

The working copy always lives in the browser. Sync, when enabled, is a replica of that working copy — not a replacement for `StorageService`.

### 2. Login never uploads; consent lives on sync enablement

Issue #7 lists first-login keep / upload / replace / merge choices. This ADR keeps those actions, but **not as a side effect of login**.

**On sign-in or session restore**

- Perform no `NeighborhoodStore` reads or writes.
- Switch the working copy to the namespaced local keys for `session.user.id` (see [Namespacing](#6-record-identity-namespacing-versioning-conflicts-offline-deletion)).
- If the anonymous namespace still holds **user-authored** data (not demo-only) and this account's namespace is empty, show a **device-only** prompt:
  - **Use this browser's places with this account** — copy anonymous → account namespace. Nothing leaves the device.
  - **Leave them in the unsigned-in bucket** — account namespace stays empty; anonymous keys are untouched.
  - **Start empty** — account namespace stays empty; do not copy.
- Demo-only content (`demo-1`, `demo-2`, or a future `source: 'demo'` flag) is not treated as user-authored and is not copied or uploaded.

**On first sync enablement** (Settings: “Sync neighborhood data across devices”), after the remote snapshot is fetched **only because the user turned the control on**:

| Local | Remote | Choices (preview required) |
| --- | --- | --- |
| User-authored | Empty / none | **Upload** (create replica) or **Cancel** (sync stays off) |
| Empty / demo-only | Present | **Replace from server** or **Cancel** |
| User-authored | Present | **Keep local (don’t sync)**, **Upload local** (overwrite server), **Replace from server** (overwrite local), **Merge** |
| Empty / demo-only | Empty / none | Enable sync with an empty replica, or cancel |

Every destructive choice shows a preview (home address summary + place names, categories, and counts). Confirm is explicit. Cancel leaves sync off and writes nothing remotely.

**Keep local (don’t sync)** means sync remains disabled. It does not “enable sync but skip the first push,” which would later overwrite the server by accident.

Disabling sync later is a separate confirmation: stop replicating (leave server copy) vs stop and **delete the remote snapshot**.

### 3. Pluggable `NeighborhoodStore`

Application and HTTP layers depend on one interface. Adapters implement it. Vendor lock-in does not leak into `src/js/storage.js`, UI, or auth code.

#### Snapshot document

The store's unit of work is a **neighborhood snapshot**, aligned with today's export JSON and extended with sync metadata:

```json
{
  "version": 1,
  "exportedAt": "2026-09-08T12:00:00.000Z",
  "revision": 12,
  "etag": "ng-12-9f2c…",
  "homeAddress": {},
  "savedPlaces": [],
  "tombstones": [{ "id": "place_…", "deletedAt": "2026-09-08T12:00:00.000Z" }]
}
```

- `version` / `exportedAt` / `homeAddress` / `savedPlaces` are the interchange fields already used by export/import.
- `revision` is a server-monotonic integer (`0` means never stored).
- `etag` is an opaque validator derived from revision (and optionally a payload hash). Clients send it as `If-Match` on write.
- `tombstones` exist so **merge** can honor deletions. Snapshot replace does not need them to delete a place (omission from `savedPlaces` is enough). User-facing export **omits** `revision`, `etag`, and `tombstones` unless we later add an advanced “sync debug” export.

Forbidden in any snapshot, API body, or adapter log: Mapbox tokens, JamBase tokens, `AUTH_SECRET`, OIDC secrets, session cookies, store credentials, JamBase show caches (`guru_jb_shows_*`).

#### Interface (normative sketch)

Names may be refined in implementation. Semantics must not.

```js
/**
 * ownerId is AuthClient session.user.id for remote replicas,
 * or `anonymous` / that same user.id for local namespacing.
 *
 * getSnapshot returns null when no replica exists.
 * putSnapshot MUST fail with a conflict when ifMatch is present and does not match.
 * deleteSnapshot removes that owner's replica (account removal / wipe).
 */
export const NeighborhoodStore = {
  async getSnapshot(ownerId) {},
  async putSnapshot(ownerId, snapshot, { ifMatch } = {}) {},
  async deleteSnapshot(ownerId) {},
};
```

v1 does **not** require record-level CRUD on the interface. Adapters may store a JSON blob per owner or explode the snapshot into rows internally. App code always reads and writes snapshots so a later record-level API can be added without changing consent UX.

Optional later methods (`listPlaces`, `putPlace`, `deletePlace`) are non-goals for the first implementation issues.

#### Adapters

| Driver | Role | v1 intent |
| --- | --- | --- |
| `local` | Browser `localStorage` / the existing `StorageService` working copy. No `/api/neighborhood`. | **Required.** Default. Sync UI hidden or disabled. |
| `sqlite` | On-box file, Bun `sqlite`, **separate path from** `AUTH_DATABASE_PATH`. | First server adapter. |
| `libsql` | Turso / libsql replica. | First hosted adapter; same SQL shape as `sqlite` where practical. |
| `postgres` | Connection-string adapter. | Stub/skeleton: driver wiring, interface conformance, “not implemented” until a follow-up. |

Suggested deployment configuration (server-only, never `VITE_`-prefixed, never injected into `__NG_RUNTIME_CONFIG__` beyond a boolean like `neighborhoodSyncAvailable`):

```env
# local | sqlite | libsql | postgres
NEIGHBORHOOD_STORE=local

# sqlite only — MUST be a different file from AUTH_DATABASE_PATH
NEIGHBORHOOD_DATABASE_PATH=

# libsql / Turso
NEIGHBORHOOD_LIBSQL_URL=
NEIGHBORHOOD_LIBSQL_AUTH_TOKEN=

# postgres (future)
NEIGHBORHOOD_DATABASE_URL=
```

Runtime selection is a factory (`createNeighborhoodStore(config)`), analogous to `createServer({ providers, providerRegistry })`. Adding a driver must not require edits to map, UI, or auth modules.

The browser is told only `{ authMode, neighborhoodSyncAvailable }`. Database URLs, tokens, and driver names stay on the server.

#### Suggested SQL shape (sqlite / libsql)

Illustrative, not a migration in this PR:

```sql
CREATE TABLE neighborhood_snapshots (
  owner_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  etag TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`owner_id` is the auth user id **string**, copied at write time. There is **no foreign key** to the auth `users` table (different database, different adapter, local-only deployments have no auth DB).

### 4. Separation from the auth database

| Concern | Auth store | Neighborhood store |
| --- | --- | --- |
| Config | `AUTH_DATABASE_PATH`, `AUTH_SECRET`, OIDC | `NEIGHBORHOOD_STORE`, `NEIGHBORHOOD_DATABASE_PATH` / libsql / Postgres URL |
| Schema | `users`, `external_identities`, `sessions`, `login_transactions` | `neighborhood_snapshots` (or future place rows) |
| Migrations | `applyAuthMigrations` / `PRAGMA user_version` | Separate migrator and version pragma or table |
| Process | `/api/auth/*` | Future `/api/neighborhood/*` |
| Failure | Auth down does not delete places | Store down does not sign anyone out |

Even when both drivers are SQLite, they are **two files**. Never add place columns to the auth schema. Never open the auth DB from neighborhood adapters or the reverse.

Account linking ([#6](https://github.com/luminari-gurus/neighborhood-guru/issues/6)) attaches another `(issuer, subject)` to the same internal `user.id`. Neighborhood data follows `user.id`, not email and not provider subject. Linking does not merge two neighborhood namespaces. Syncing records **between** different internal users stays out of scope (as in #6).

Cloudflare Access (or any reverse-proxy SSO) may gate who can load the SPA. Access identity is not `AuthClient` `user.id`. Sync namespacing always uses the application user id. One Access policy covering a household still requires distinct app accounts if those people should not share a neighborhood replica.

### 5. HTTP sketch (implementation follow-up)

Same-origin, session cookie, CSRF on mutating routes — same bar as `/api/auth`.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/neighborhood/snapshot` | 401 if unauthenticated; 404 if no replica; else snapshot JSON |
| `PUT` | `/api/neighborhood/snapshot` | 401/403 without consent+session; `If-Match` required after the first write; 409 on mismatch |
| `DELETE` | `/api/neighborhood/snapshot` | Deletes that user's replica |

These routes are unregistered when `NEIGHBORHOOD_STORE=local`. They must not be mounted on the auth backend module; a distinct router keeps the data planes reviewable.

### 6. Record identity, namespacing, versioning, conflicts, offline, deletion

#### Record identity

- **Home address:** singleton per owner. No id today; sync treats it as one record. Merge of two homes is **not** automatic: preview both, user picks one (or cancel).
- **Places:** `id` is the stable key (`place_${Date.now()}_${random}` today; demo ids `demo-1` / `demo-2`). Implementation should keep ids as opaque strings. New places minted independently on two devices can collide only by chance; v1 accepts that rarity. A later issue may switch new ids to `crypto.randomUUID()`.
- **Owner:** `AuthClient` `user.id` (internal user primary key), never email.

#### Browser namespacing

Logical key layout (implementation may prefix with a helper):

| Data | Anonymous | Authenticated |
| --- | --- | --- |
| Home / places / sync consent / dirty / last etag | `neighborhood_guru:anonymous:…` | `neighborhood_guru:user:${encodeURIComponent(userId)}:…` |
| Map style | Device preference; not namespaced in v1; **not synced** | Same |
| Mapbox / JamBase tokens | Device-level; **not synced** | Same. Optional later namespacing is a separate hardening issue. |
| JamBase show cache | Device cache; **not synced** | Same |

Existing unprefixed keys (`neighborhood_guru_home_address`, `neighborhood_guru_saved_places`) migrate **once** into the anonymous namespace, or into the sole restored `user.id` namespace when that session is already active, so current users are not reset. That migration is local and is not an upload. Authenticated keys use a distinct `user:` tag so a `user.id` of `anonymous` cannot collide with the unsigned-in bucket; opaque ids are encoded rather than interpolated raw.

**Legacy key retention.** `localStorage` cannot compare-and-remove, so unprefixed leftover keys are **retained indefinitely** after a successful copy. A durable `neighborhood_guru:legacy-claim:${suffix}` record binds leftover to the namespace that started migration (`nonce`, `namespaceId`, `fingerprint`, `status: pending | migrated | orphaned`). Other accounts must not adopt a claimed leftover. A completed claim is current only while its fingerprint still matches the retained value; a later older-tab edit becomes an ambiguous device-level recovery item (never auto-adopted, exported only through the warned device-recovery flow). Exclusive adoption runs only while holding a Web Lock. Cleanup of leftover keys is deferred until every writer participates in the same lock/version protocol or an explicit compatibility boundary ships.

Divergent leftover that cannot be copied into an occupied destination is quarantined under owner-stamped `neighborhood_guru:orphaned:…` envelopes. Owner-bound orphans are previewable/mergeable/replaceable in the current account. Device-level and fingerprint-mismatched leftovers use a separately warned download.

JSON import journals (`neighborhood_guru:import-journal:${namespaceId}`) are owner-private. A verified `pending` journal is written before the first destructive import write; success is acknowledged only after a verified terminal `committed` status. Startup recovery rolls `pending` / `rollback-incomplete` journals back to their snapshot and re-applies `committed` intended values. Ordinary device-recovery download includes only the active namespace’s journal; exposing another account’s journal requires `exportPrivilegedDeviceRecoveryJSON()`.

**Sign-out** switches the working copy to the anonymous namespace. It must not copy authenticated places into anonymous keys.

**Switching accounts** on a shared browser switches namespaces. The previous user's working copy stays in their keys, unread.

#### Versioning and conflict policy (v1)

**Ongoing sync is snapshot last-write-wins, guarded by `etag` / `revision`.**

Justification:

- The product already treats the directory as one document (export/import, `localStorage` arrays).
- The dataset is a personal neighborhood list, not concurrent field-level collaboration.
- Record-level automatic merge would need tombstones, per-field winners, and id-collision policy for every write — too much for a first shipping slice.
- LWW is easy to explain in the UI: “This device” vs “the copy on the server”.

Rules:

1. Local edits set a dirty flag and update `exportedAt` (ISO timestamp of last local change).
2. Push sends the full snapshot with `If-Match: <lastSeenEtag>`. Success stores the new `revision`/`etag` and clears dirty.
3. Pull replaces the working copy only if local is not dirty **or** the user confirmed replace/merge.
4. If local is dirty **and** `If-Match` fails (409), **stop**. Show the same previewed choices as first enablement: keep local (retry by pulling server aside and then uploading — still confirmed), take server, merge, or cancel (remain dirty, retry later). Never silent LWW across a 409.

`exportedAt` is informational and used in previews (“Local copy from …”). It is **not** the conflict winner by itself; the server `revision`/`etag` is. Clocks lie; etags do not.

#### Merge (explicit action only)

Used at first enablement or after a 409, never as a background algorithm.

1. **Places:** union by `id`.
   - Id only on one side → keep it, unless the other side lists that id in `tombstones` with `deletedAt` newer than the place's `updatedAt` / `createdAt`.
   - Id on both sides and payloads differ → winner is newer `updatedAt`, then `createdAt`, then local (stable, disclosed in the preview).
2. **Home address:** if both present and differ, user picks; no silent pick.
3. **Tombstones:** union, then drop tombstones whose id is still present because the surviving place is newer than `deletedAt`.
4. Result is previewed, then written locally and, if sync stays enabled, pushed as a new snapshot.

#### Offline

- Local reads/writes always succeed against the namespaced working copy.
- Offline + sync enabled: dirty flag accumulates; no retry storms.
- Back online: attempt pull then push with `If-Match`. Network errors surface a toast and remain dirty. 409 opens the conflict preview.
- There is no offline write queue of individual patches in v1 — the snapshot **is** the queue.

#### Deletion semantics

| Action | Local | Remote replica |
| --- | --- | --- |
| Delete a place (sync off) | Remove from array | Unchanged |
| Delete a place (sync on) | Remove from array; add tombstone; dirty | Omitted on next successful push (LWW snapshot) |
| Clear home | `homeAddress: null` | Same on next push |
| Disable sync, keep server copy | Consent off; working copy stays | Replica remains until a later wipe |
| Disable sync and wipe | Consent off | `deleteSnapshot(ownerId)` |
| Account removal | Clear that userId namespace after confirm | `deleteSnapshot(ownerId)` **and** whatever auth-account deletion [#6](https://github.com/luminari-gurus/neighborhood-guru/issues/6)/future account-deletion work defines. Neighborhood wipe must not depend on auth CASCADE (separate DBs). |

Tombstones can be garbage-collected after a successful push that omitted those ids, or retained for a bounded window (implementation issue). v1 may retain them on the snapshot until a later compaction.

### 7. Privacy, threats, encryption, retention

Neighborhood snapshots are **sensitive personal data**: home coordinates, street addresses, household names, phone numbers, emails, free-text notes (keys, schedules, “spare house key”), and social graph of neighbors.

#### What v1 promises

- Sync is off until the user enables it. Login is not enablement.
- Anonymous/local-only deployments (`NEIGHBORHOOD_STORE=local`, default) never grow a neighborhood API.
- Tokens and third-party API keys are excluded from snapshots.
- Export remains available on-device whether or not sync is on.
- Account/namespace wipe is possible without rewriting app code (store `deleteSnapshot`).
- Shared-browser account switches do not display another namespace.

#### Threat notes

| Threat | Mitigation in this design | Residual risk |
| --- | --- | --- |
| Silent upload on login | No neighborhood I/O in auth success paths; consent flag required | Implementation bugs — tests must assert zero store writes on `signIn` / `loadSession` |
| Shared browser, leftover places | Per-`user.id` keys; sign-out does not copy into anonymous | Tokens and map style remain device-global in v1 |
| Shared browser, shoulder / DevTools | localStorage is readable by any script on the origin | Same as today; sync does not make this worse locally |
| XSS exfiltrates replica | Existing XSS surface; sync adds an authenticated API | Keep CSP / cookie flags; CSRF on PUT/DELETE; do not put snapshots in logs |
| Deployer or DB host reads places | **Accepted in v1** if sync is enabled | Users who cannot trust the deployer stay local-only |
| Cloudflare Access ≠ app user | Access is a gate only; namespace by `AuthClient` id | Misconfigured Access still exposes the SPA to everyone inside the policy |
| Confused deputy (auth user A writes user B's snapshot) | `ownerId` taken from the session, never from the client body | Tests for IDOR |
| Demo data uploaded as if real | Demo ids / flag excluded from “user-authored” | Custom data that resembles demo still uploads (correct) |
| Token sync | Omitted from snapshot and export | User might paste keys into **notes**; treat notes as PII |
| Backup JSON emailed / copied | Export is plaintext by design (user-held backup) | Document in UI that export contains addresses and contacts |

#### Encryption and retention

- **In transit:** HTTPS / same-origin only. No neighborhood payload on `http://` in production.
- **At rest:** deployer responsibility (disk encryption, Turso at-rest encryption, Postgres TDE). v1 does **not** add application-level envelope encryption or E2E keys. E2E would fight OIDC-based account recovery and every adapter equally; it needs its own ADR if we want it.
- **Retention:** replica exists until the user wipes it or the deployer deletes the store. No hidden analytics copy. Server logs must not print `payload_json`.
- **Export:** user can always download the interchange JSON from the working copy (tokens still excluded).
- **Account removal:** neighborhood `deleteSnapshot` plus namespaced local clear; auth row deletion remains an auth-track concern.

### 8. Relationship to export / import

| | Export / import today | Sync snapshot |
| --- | --- | --- |
| Core fields | `version`, `exportedAt`, `homeAddress`, `savedPlaces` | Same |
| Tokens | Excluded | Excluded |
| `revision` / `etag` / `tombstones` | Absent | Server/sync metadata |
| User action | File download / file open | Network replica |

Rules:

- `exportDataJSON()` remains a local backup. It must not start syncing.
- `importDataJSON()` writes the working copy (today: replace home + places). After namespacing, import writes the **current** namespace only. If sync is enabled, import marks dirty and requires the usual push/`If-Match` (409 → conflict preview). Import does not skip consent.
- A file that includes `revision`/`etag` from another device is treated as **content only**; etags are not imported (they belong to a replica, not a file).
- Bump `version` only when the interchange shape breaks. Adding ignored fields is not a bump.

### 9. Out of scope

**This ADR / docs PR**

- Runtime sync, HTTP routes, SQL migrations, adapter packages, UI for consent.
- New npm/Bun dependencies.
- Changing `AUTH_MODE` behavior.
- Client-side E2E encryption.
- Record-level live collaboration, CRDTs, presence.
- Syncing map style, JamBase caches, or API tokens.
- Automatic merge of two internal user accounts (see #6).
- Treating Cloudflare Access (or any edge SSO) as the neighborhood owner id.

**Follow-up after approval (suggested child issues)**

Do not open these until this ADR is accepted. Split so each is independently reviewable:

1. **Migrate and namespace browser storage** by `anonymous` vs `user.id`, including one-time migration of unprefixed keys, sign-out isolation, and tests that login performs zero neighborhood network I/O.
2. **Device-only post-login copy prompt** for user-authored anonymous data (no upload).
3. **`NeighborhoodStore` interface + `local` adapter** wrapping/evolving `StorageService`; factory and unit tests.
4. **SQLite adapter** on `NEIGHBORHOOD_DATABASE_PATH` with its own migrations — explicitly not `AUTH_DATABASE_PATH`.
5. **libsql / Turso adapter** sharing the sqlite snapshot schema.
6. **Postgres adapter stub** (driver switch + clear “unimplemented” surface) and env documentation.
7. **`/api/neighborhood/snapshot` GET/PUT/DELETE** with session, CSRF, `If-Match`, IDOR tests, unregistered when driver is `local`.
8. **Sync enablement UX** — preview, keep / upload / replace / merge, demo exclusion, disable+wipe.
9. **Offline dirty flag, 409 conflict preview, and import-while-sync-enabled behavior.**
10. **Account-removal / namespace wipe** coordinating local keys and `deleteSnapshot` (may wait on a dedicated auth account-deletion issue).

---

## Consequences

**Positive**

- Auth work can continue without carrying a data-sync design in the same PRs.
- Open-source deployers pick local, sqlite, Turso, or (later) Postgres behind one interface.
- The default product remains local-first; sync is a replica with named consent states.
- Export JSON stays the interchange format, so backup and sync do not diverge.

**Negative / accepted trade-offs**

- Snapshot LWW can overwrite a place another device edited if the user confirms upload after a conflict. Mitigated by preview, not by magic merge.
- Merge is a one-shot union, not continuous. Two devices editing the same place without syncing in between still need a human choice.
- The deployer of a non-local store can read neighborhood PII. E2E encryption is deferred.
- Two databases to operate when both auth and sync are enabled.
- Postgres is a stub until a child issue implements it.

**Compliance with #7 acceptance (design level)**

| Criterion | How this ADR addresses it |
| --- | --- |
| Login alone uploads nothing | Modes + consent on enablement, not on `signIn` / `loadSession` |
| Anonymous/local-only remains | Default driver `local`; authenticated local-only is the post-login default |
| Namespacing across sign-out / user change | Per-`user.id` keys; no copy on sign-out |
| Explicit consent and previews | Enablement matrix + 409 preview |
| Conflict, offline, deletion, export, account removal | §6 and §8 |
| Secrets excluded | Snapshot denylist; tokens stay in `StorageService` keys |
| Threat/privacy analysis | §7 |
| Child implementation issues after approval | §9 list — **not filed until Accepted** |

Runtime checkboxes on #7 stay open until those child issues land. This document **addresses** #7; it should not close it.

---

## Notes for implementers

- Prefer **Bun** for any new server scripts, tests (`bun test`), and dependency adds — but this ADR adds none.
- Match the AuthClient pattern: a small interface, a real local implementation, a fake for tests, vendor details behind adapters.
- Do not inject store URLs or tokens into the browser runtime marker.
- Do not commit deployment hostnames, Turso URLs, or credentials. `.env.example` should show empty placeholders only, in a later implementation PR.
