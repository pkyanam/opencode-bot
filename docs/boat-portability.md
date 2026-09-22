# Boat optional hosting architecture

This document describes the minimum production-shaped Boat deployment that can
run the application without Cloudflare. Cloudflare remains the preferred
provider. The goal is feature parity: Boat must expose the same HTTP API,
pairing/auth rules, run state, computer control, terminal, files, memory,
transfers, checkpoints, scheduled routines, and update/recovery semantics.

## Boundary to preserve

`apps/control-worker/src/index.ts` currently combines the public Worker router,
the `Workspace` Durable Object, SQLite-backed domain state, alarms, and the
Cloudflare computer adapter. The portability seam should be the already-clear
domain/provider boundary, not a second implementation of every route:

* Keep route/domain logic in a runtime-neutral `WorkspaceService` extracted from
  `Workspace.fetch`, `init`, `alarm`, and its private route helpers.
* Keep `worker.fetch` as a thin Cloudflare adapter: authenticate, select the
  `owner` DO, dispatch, retry transient DO failures, and serve `ASSETS`.
* Add a Boat HTTP adapter that authenticates the same bearer/pairing credentials
  and dispatches to one process-local `WorkspaceService` instance (or a
  single-owner workspace registry if multi-workspace is later enabled).
* Make storage, scheduler, object store, and computer provider interfaces
  explicit. `DurableObjectCheckpointStore` and `CloudflareComputerProvider`
  become Cloudflare implementations of those interfaces; Boat supplies local
  implementations.

Do not import `@cloudflare/sandbox`, Workers types, `env.ASSETS`, R2 types, or
Durable Object types from the shared service. Cloudflare-only files can remain
in `apps/control-worker` until the extraction is complete, but the Boat entry
point must not load that module transitively.

### Lowest-risk extraction order

The first Boat implementation can avoid a large route rewrite. `Workspace` is
already a normal class (it does not extend `DurableObject`), so a temporary
Node host can instantiate it with a compatibility `DurableObjectState` and an
environment object. The shim should be deliberately small and tested:

* back `state.storage.sql.exec` with `node:sqlite` `DatabaseSync`, translating
  the Workers `exec(sql, ...args).toArray()/rowsWritten` shape;
* implement `get/put/delete`, `setAlarm`, `transactionSync`, and `waitUntil`
  over the same database and a persistent `kv`/`alarms` schema;
* provide an `ARTIFACTS` object implementing the subset of the R2 API used by
  checkpoint, attachment, transfer, and retention code, backed by the local
  ObjectStore; and
* provide `ASSETS.fetch` through the Node static asset handler.

Then inject a `ComputerProvider` factory so `Workspace.provider()` selects the
local runner adapter when `HOSTING_PROVIDER=boat` and the Cloudflare adapter
only in the Worker build. This phase keeps route behavior and schema identical;
the follow-up extraction can move the service to a package after parity tests
pass. It is acceptable to use a build alias or conditional module boundary for
the Cloudflare provider during this phase, but the resulting Boat bundle must
not resolve `@cloudflare/sandbox` at runtime. A real WebSocket bridge (for
clients that require one) belongs in the Node host and should forward to the
same service/runner streams; the current desktop preview can continue as
backpressured multipart HTTP.

## Boat process topology

Run one supervised Node process containing:

1. An HTTP server serving the built `apps/web` assets and the existing `/api/*`
   and `/internal/*` routes.
2. A `WorkspaceService` with a real SQLite database (`node:sqlite` is already
   used by tests; use WAL mode, foreign keys, busy timeout, and transactions).
3. A `LocalComputerProvider` that starts `runner/server.mjs` as a child process
   in the same VM and talks to it over loopback HTTP using the existing runner
   token lease.
4. A durable alarm loop. Persist due work and next wake times in SQLite, wake
   on the nearest deadline, and run a bounded reconciliation pass. Use a
   monotonic timer only as a wakeup; after restart, derive work from durable
   rows. This replaces DO `setAlarm` and the Worker cron `scheduled` hook.
5. A local object store rooted outside the database for checkpoints, chat
   attachments, artifacts, and node transfers. Store each object by its exact
   key with atomic temp-file-then-rename writes, fsync before commit, size and
   SHA-256 metadata, and a startup orphan scan. This is the R2 replacement.

The runner remains a separate process even though it is colocated. Isolation is
still needed for OpenCode, Chromium, PTY, and crash recovery. Bind its port to
`127.0.0.1`, require `RUNNER_TOKEN`, and use a distinct internal token for
memory/Hindsight where applicable. Never expose the runner port directly.

## Durable state mapping

| Cloudflare primitive | Boat implementation | Required behavior |
| --- | --- | --- |
| Workspace Durable Object SQLite | One SQLite file per workspace, normally `data/workspace.sqlite` | Preserve every schema/table and transaction boundary from `Workspace.init`; migrations run before admission. |
| DO key `owner` | Explicit workspace ID `owner` in config/database path | No implicit process-global mutable state for authoritative records. |
| DO `storage.get/put/delete` | `kv` table (`key TEXT PRIMARY KEY, value BLOB/JSON`) | Used for generation, sleep markers, checkpoint pointers, backup policy, update jobs, OAuth pending state, and origins. |
| `storage.sql` | Same SQLite connection exposed to service/repositories | Keep SQL schema and query semantics; serialise writes. |
| `storage.transactionSync` | SQLite transaction (`BEGIN IMMEDIATE`) | Atomic run transitions, idempotency receipts, leases, and projection updates. |
| `state.storage.setAlarm` / `alarm()` | `alarms` table plus scheduler loop | Durable, retryable, bounded passes; schedule the earliest of run reconciliation, transfers, memory tick, backup, update, and routine deadlines. |
| R2 `ARTIFACTS` | ObjectStore backed by local filesystem | Streaming put/get/range/head/list/delete; no whole-archive memory requirement; retain protected checkpoint keys. |
| Worker static `ASSETS` | Node static file handler or reverse proxy to built `apps/web/dist` | Same SPA fallback and cache behavior. |
| DO reset/transient retry | Child runner restart/reconnect and service retry policy | GET retries remain safe; mutating requests rely on durable idempotency keys and return a reconnecting/503 response when ownership is uncertain. |

The local database is the recovery authority. D1-like rebuildable projections
are unnecessary for a single Boat process; if search projections are added,
mark them derived and rebuildable exactly as Hindsight's registry comments
require. Do not treat filesystem checkpoint archives as committed until the
pointer row and manifest have been committed in SQLite.

## Local computer provider

Add a provider implementing the existing `ComputerProvider` interface in a new
package such as `packages/computer-local/src/index.ts`:

* `ensure(spec, key)` creates/returns one managed runner for `computerId`.
  Spawn `node runner/server.mjs` with a private workspace directory, stable
  `instanceId` file, `RUNNER_TOKEN`, `RUNNER_PORT`, and startup nonce. Use a
  per-computer lock and a pending-operation map so concurrent wake/readiness
  calls cannot spawn two runners.
* `connect(id, lease)` returns the same `RunnerTransport` contract as the
  Cloudflare provider. Every request carries the lease token and validates
  generation/fence. Reject stale generations after restart.
* `inspect` checks child liveness and `/health`; distinguish stopped, starting,
  runner unavailable, and error. `stop` first quiesces the runner and waits for
  active runtime operations to drain, then terminates the child gracefully and
  escalates after a timeout. `destroy` removes only the provider-owned runtime
  directory after the durable pointer is handled.
* `capabilities` must report Linux shell, desktop, browser, and durable local
  disk accurately. Snapshot support is true only when archive + restore is
  configured and verified; egress enforcement is false unless Boat is running
  behind a real policy.
* `checkpoint` calls `/checkpoint/quiesce`, archives configured paths with the
  same excludes and SHA-256 manifest rules as the Cloudflare adapter, streams
  into ObjectStore, and calls `/checkpoint/resume` on success or failure.
  `restore` verifies bytes and checksum before replacing files, then resumes
  the runner and establishes the new runner instance lineage.

The existing `runner/server.mjs` already provides the needed authenticated
health, checkpoint/quiesce/resume/state, run, terminal, desktop control and
multipart desktop preview routes. Boat should reuse them unchanged. Preserve
the `RunStore` idle barrier, manual-control lease, terminal exclusivity,
quiesce fencing, stable instance ID, and persisted run files; these are part of
the correctness contract, not Cloudflare-specific details.

## HTTP, streaming, and authentication parity

The Boat adapter must retain the route paths used by `apps/web/src/api.ts`,
mobile clients, MCP, and transfer clients. In particular this includes
`/api/runs`, `/api/runs/:id/events`, `/api/computer/{readiness,status,wake,sleep,
checkpoint,restore,preview,control}`, `/api/terminal/*`, `/api/files/*`,
`/api/uploads/*`, `/api/storage/*`, `/api/memory/*`, `/api/nodes/*`, and
`/internal/*` runner/update routes.

Use Node's HTTP upgrade/server streaming support only where the client contract
requires it. The current desktop preview is authenticated multipart MJPEG, not
WebRTC; proxy `/api/computer/preview` as a backpressured stream and disconnect
the upstream runner stream when the client closes. Run event polling and
transcript event persistence remain authoritative; if a WebSocket is added for
latency, it is a derived notification channel and must replay from SQLite by
sequence after reconnect.

Reuse `safeEqual`, bearer parsing, `PairingService`, `clientRouteAllowed`, and
the owner/client distinction. Boat may add TLS/reverse-proxy integration, but
must not weaken pairing or make the runner token a client credential. Bind
loopback-only by default and require explicit configuration to listen on a
network interface.

## Scheduling and failure recovery

Replace every direct `setAlarm` call with `scheduler.schedule(key, dueAt)`;
deduplicate by key and persist payload/version. The scheduler invokes bounded
service methods equivalent to `Workspace.alarm`: update jobs, run/runner
reconciliation, delegation and transfer receipts, stale leases, routine
execution, Hindsight ticks, checkpoint retention, and automatic backups. On
failure, retain the row, increment attempts, and apply capped exponential
backoff. On startup, mark in-flight dispatches as recoverable and reconcile the
runner before admitting new work.

Checkpoint and sleep ordering must remain:

1. Stop admission and wait for `RunStore`/runner active operations to drain.
2. Quiesce the runner and obtain a durable manifest.
3. Verify object size and checksum.
4. Commit the checkpoint pointer, fence, and runner lineage in one SQLite
   transaction.
5. Stop the child and persist the stopped marker.

If any stage fails, retain the previous pointer and report `restore_required` or
`state_unknown` rather than silently starting with an empty workspace. Upgrade
and restore paths must use the same `ComputerManager` semantics already tested
in `packages/coordinator-cloudflare/test`.

## Recommended file boundaries

The implementation can be incremental:

* `packages/platform/src/contracts.ts`: `StateStore`, `ObjectStore`,
  `AlarmScheduler`, `AssetServer`, and provider contracts.
* `packages/platform-local/src/sqlite-state.ts`, `object-store.ts`,
  `scheduler.ts`, `local-computer.ts`.
* `apps/control-service/src/workspace-service.ts`: extracted route/domain
  service with injected platform contracts.
* `apps/control-server/src/server.ts`: Boat auth, assets, HTTP/stream proxy,
  lifecycle and graceful shutdown.
* `apps/control-worker/src/index.ts`: Cloudflare entrypoint/adapters only after
  extraction; preserve Wrangler exports (`worker`, `Workspace`, `Sandbox`).
* `scripts/boat.mjs` and `docs/boat-setup.md`: explicit data directory,
  binding, backup, TLS/reverse-proxy, and runner prerequisites.

Avoid a compile-time Cloudflare dependency in the local package graph. Keep
`@cloudflare/sandbox`, Wrangler, and Workers ambient types in the Cloudflare
app/package only; shared contracts must use ordinary TypeScript types.

## Qualification checklist

Boat is ready only after the same parity tests pass against both adapters:

* fresh start, restart, schema migration, and graceful shutdown;
* pair/revoke client and owner authorization matrix;
* run creation, idempotent retry, event sequence replay, approval, cancel,
  steering, delegation, transfer receipts, and stale-lease recovery;
* runner crash during a run, startup reconnect, manual desktop lease expiry,
  terminal exclusivity, preview backpressure, files/artifacts and uploads;
* checkpoint while idle, refusal while active, interrupted archive, checksum
  mismatch, restore after process restart, and old-pointer retention;
* alarm recovery after kill/restart, routines, memory/Hindsight sync, update
  pause/resume, and retention cleanup;
* static app fallback and API/mobile contract tests.

Do not claim “no Cloudflare dependency” if the Boat entrypoint still imports
the Worker module or if an unconfigured checkpoint silently becomes ephemeral.
