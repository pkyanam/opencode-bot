# Boat hosting research (no Cloudflare)

Research and implementation notes, verified against Boat documentation and an
owned test VM in September 2026. Boat is an optional installation target;
Cloudflare remains the preferred default. See [setup](boat-setup.md) for release status.

## What Boat provides

Boat supplies a full Linux VM with a persistent filesystem, Docker, Node, Python,
Go, Rust, Chromium, OpenCode, and the `boat` CLI. Current machine choices are:

| Boat type | CPU/RAM | user disk | rate |
|---|---:|---:|---:|
| `small` | 2 vCPU / 4 GB | 12 GB | $0.018/hour |
| `default` | 4 vCPU / 8 GB | 50 GB | $0.036/hour |
| `large` | 8 vCPU / 16 GB | 125 GB | $0.072/hour |
| `xlarge` | 16 vCPU / 32 GB | 251 GB | $0.20/hour |

Stopped sandboxes do not accrue machine time. The default one-hour TTL can be
changed to a bounded TTL or disabled with `--no-auto-stop`; no-auto-stop and TTLs
over two hours require a paid account. A default VM running continuously is about
$26/month before model, egress, or other service costs. `boat limits`, `boat
usage <id>`, and `boat billing status` expose limits and actual spend.

Boat snapshots are incremental filesystem captures taken about every minute and
on clean stop. They include user files, installed packages, `/etc` and enabled
systemd units; hand-started processes, Docker build cache, and live network state
do not survive restore. `boat resume` restores the same sandbox ID on a fresh
machine; `boat snapshot <id> <name>` creates a retained named template; `boat
snapshot pull` downloads files. A failed final snapshot refuses a stop and pauses
the meter, protecting data. Deleting a sandbox is permanent, while stop is the
recoverable pause.

Stable HTTPS is provided by `boat host <sandbox-id> <port>` (or in-sandbox
`host <port>`). Services must bind `0.0.0.0`; routes are `https://<subdomain>-<port>.on.boat.dev`.
Routes are private/token-gated by default and can be made ungated with `--public`.
The token-bearing URL is a secret. Re-hosting the same port returns the same
route, so a systemd service can restore it after resume.

## Proposed Boat-only topology

Run the web/control server, SQLite state, OpenCode server, browser, and background
runner in one `default` sandbox initially. The existing Cloudflare deployment
continues to own the current Worker/Durable Object/R2 topology. In Boat mode:

* replace the Worker entrypoint with a normal Node HTTP server listening on
  `0.0.0.0:<app-port>` and serve the built web assets from the same process;
* keep authoritative workspace, bot, conversation, approval, pairing, and
  memory projections in SQLite on the Boat filesystem, with artifacts/checkpoints
  under a dedicated data directory;
* start the server and runner as enabled systemd services. Do not depend on
  `boat exec --detach` or a shell background process for durability: detached and
  hand-run processes disappear across stop/resume/fork;
* expose the app with `boat host <id> <app-port> --public` by default and require
  the app's own bearer token on every API route. Boat's private token-bearing URL
  breaks mobile/Telegram clients that cannot reliably preserve it; offer
  `--private` only as an explicit advanced option;
* use the same app authentication and pairing credentials as local mode, with
  secure permissions on the SQLite/data directory and no secrets in URLs or logs;
* use Boat's native computer/browser inside this sandbox. A later multi-VM design
  can make each Computer a separate Boat sandbox, but the first adapter should
  avoid introducing distributed coordination before the single-VM flow is proven.

Boat's own API is not a replacement for the app's control API. It is the lifecycle
control plane used by the installer/adapter; the app's Node server remains the
product API used by web/mobile/Telegram clients.

## Installer flow (proposed, read-only research contract)

Add an explicit target such as `./setup.sh --target boat` (exact syntax remains an
implementation choice). The default invocation must continue to select Cloudflare.
The Boat branch should:

1. Check `boat --version`, `boat status --json`, `boat limits --json`, and the
   selected billing scope (`--org` if requested). If no session exists, stop with
   `boat login`/`boat onboard` instructions; do not print or ask the user to paste
   a key into logs. For automation, accept `BOAT_API_KEY` through stdin using
   `boat login --key-stdin`.
2. Read a redacted plan: sandbox name/state, `small|default|large`, TTL policy,
   app port, data path, deployment release, and whether a private host route is
   needed. Never adopt an unrelated sandbox by name without an ownership marker
   (persist the Boat sandbox ID in the local deployment journal).
3. Create or resume the owned sandbox. First install can use
   `boat new --type default --ttl <seconds> --json`; continuous mode uses
   `boat new --no-auto-stop --json`. Parse JSONL and wait for `event=ready`.
   Creation through the API must send an account-unique `Idempotency-Key`.
4. Use a dedicated no-env environment or `--no-env` for any user-facing sandbox.
   Configure only required values with `boat env set-var`/`set-file`, never pass
   provider keys as prompts, command arguments, Docker build args, or URLs.
   `boat env set-file <name> <path> --from <local-file>` reads a secret file and
   shows no secret in the command output. Environment changes mint immutable
   versions; apply them with `boat env upgrade <name>` or at resume.
5. Copy the pinned application release into the VM (or clone the exact release),
   run an idempotent setup script via `boat exec <id> --cwd ...` or `boat ssh`,
   and install dependencies. For >10-minute work, use `boat exec --detach` and
   poll `boat exec --status <pid>`; synchronous command timeout is capped at 600s.
6. Install and enable a systemd unit for the app/runner, then start it. Poll
   `boat info --json` and perform an authenticated health/readiness check from the
   hosted URL. Run `boat host <id> <port> --public --json` by default and store
   only redacted route metadata. Offer `--private` only explicitly; the app bearer
   token remains required either way.
7. Persist a local state record containing provider=`boat`, sandbox ID, environment
   name/version, release digest, port, route label, TTL policy, and ownership
   marker. Keep this separate from secrets. On rerun, inspect that record and
   `boat info` before resuming or reconciling.
8. Verify restart behavior: write/read a probe file, restart the service, perform a
   clean `boat stop`/`boat resume`, wait for readiness/hydration, and recheck the
   authenticated app. Stop the smoke-test VM unless the user selected continuous
   mode. Do not use `--force` except after a failed stop and an explicit data-loss
   decision.

Suggested lifecycle operations are `boat stop` for idle cost control, `boat resume`
before a new request, and a short post-run grace period before stopping. `boat
delete --yes` belongs only behind an explicit uninstall confirmation because it
permanently deletes the sandbox and its snapshots. A scheduled external monitor
or app process should reconcile `boat info` and restart systemd services after
resume; a `sandbox.ready`, `sandbox.hydrated`, `sandbox.error`, or
`sandbox.archived` webhook can reduce polling.

## Exact bootstrap bundle contract

The release pipeline must publish `boat-bundle.tar.gz` and a sibling
`boat-bundle-manifest.json` from the trusted GitHub release. The manifest schema
is `{schemaVersion:1, version:"vX.Y.Z", commit:<40-hex>, archive:{file:"boat-bundle.tar.gz", size:<positive integer>, sha256:<64-hex>}}`.
The archive must contain `boat/setup.sh`. That script is invoked inside the VM as
`APP_PORT=<port> APP_TOKEN_FILE=/tmp/opencode-bot-app-token /opt/opencode-bot/boat/setup.sh`.
It must install the pinned app/control-server/runner bundle under
`/opt/opencode-bot`, read the token file without logging it, bind the app to
`0.0.0.0:$APP_PORT`, and install/enable a systemd service that restarts after
resume. It must fail nonzero unless the authenticated health endpoint is ready.
The script must not import Cloudflare-only runtime modules. The installer deletes
the temporary token file after setup and Boat's public route is protected by the
app bearer token.

## Exact programmatic API surface

Base URL: `https://boat.dev/api/v1`, with `Authorization: Bearer $BOAT_API_KEY`.
Use the TypeScript `@boatdev/sdk` or Python `boat-sdk` where practical.

| Need | API | CLI equivalent |
|---|---|---|
| readiness/lifecycle | `GET /sandboxes/{id}`, `POST /sandboxes/{id}/resume`, `POST /sandboxes/{id}/stop`, `POST /sandboxes/{id}/fork`, `PATCH /sandboxes/{id}`, `DELETE /sandboxes/{id}` | `boat info`, `resume`, `stop`, `fork`, `extend`, `delete` |
| create | `POST /sandboxes` with `ttlSeconds`, `type`, `noEnv`, `env`, `environment`; use `Idempotency-Key` | `boat new` |
| commands | `POST /sandboxes/{id}/commands` with `command`, `cwd`, `timeoutSeconds`, `detached`; poll `GET /sandboxes/{id}/commands/{pid}` | `boat exec`, `boat ssh` |
| app URL | `POST /sandboxes/{id}/host` with `{port,title,public}` | `boat host` |
| prompts/events | `POST /sandboxes/{id}/prompt`; `GET /sandboxes/{id}/events`; `GET /sandboxes/{id}/conversations`; `POST /sandboxes/{id}/interrupt` | `boat prompt`, `events`, `conversations`, `interrupt` |
| files | sandbox file read/write and artifact endpoints | `boat scp`, `boat ssh` |
| snapshots | `GET /sandboxes/{id}/snapshots`, latest/tree/download; named snapshot create/get/delete | `boat snapshots`, `snapshot`, `snapshot pull` |
| secrets/environment | `GET/PATCH /secrets`; environment CRUD and version/upgrade endpoints | `boat env list/info/set/set-var/set-file/upgrade` |
| usage/limits | `GET /limits`, `GET /sandboxes/{id}/usage` | `boat limits`, `boat usage` |
| lifecycle events | `POST/GET/PATCH/DELETE /webhooks`; `POST /webhooks/{id}/rotate` | `boat webhook create/list/rotate/remove` |

For production automation use a scoped, expiring key: `boat api-key create
opencode-bot --ttl 90d --preset ci` (or an explicit action set). The secret is
shown once; `boat api-key list` never returns it. Prefer a separate key per
deployment and rotate by creating a replacement, updating the secret store, then
revoking the old key. Keys and desktop/viewer URLs must never enter logs.

## Requirements and security constraints

Boat mode needs a signed/pinned release bundle, Node/npm or an equivalent runtime
inside the VM, a persistent SQLite migration/backup plan, a systemd unit, and a
server health endpoint that validates the app credential. The adapter must handle
`provisioning`, `ready`/`idle`, `running`, `archiving`, `archived`, and `error`, plus
retryable `boat_starting`, `boat_restoring`, rate limits, and exhausted billing.

For any sandbox driven by an end user, use `--no-env` (or an environment marked
`safe-for-third-parties`) so no owner GitHub token, model credential, secret file,
Boat credential, or agent login is injected. Pass only explicitly scoped values.
The account-wide zero-data-retention setting is exposed by `GET/PATCH
/account/data-retention`; enabling it changes deletion behavior and must be an
explicit account choice. Boat webhooks are at-least-once, require raw-body HMAC
verification, and should be deduplicated by delivery ID.

Backups need two layers: Boat's automatic/named snapshots for rapid resume, plus an
export of SQLite/artifacts and separately recoverable encryption keys. Snapshot
data is not an independent off-provider backup; `boat snapshot pull` is the
documented export mechanism. Test restore into a new sandbox before claiming a
backup is usable.

## Open questions before implementation

* Can the existing Node control server run fully without Workers bindings, Durable
  Object alarms, R2, Queues, and Cloudflare-specific browser/Telegram paths? Map
  each import and provide SQLite/filesystem replacements before changing setup.
* Should Boat host only the app/control server, or create one sandbox per Computer?
  The single-VM adapter is simpler; per-Computer isolation changes routing,
  pairing, scheduling, and cost substantially.
* What is the supported release transfer mechanism and integrity proof (Git commit,
  signed archive, or release manifest)? It must be resumable and ownership-scoped.
* Should app data use SQLite WAL and fsync settings tuned for snapshot capture, and
  which directories belong in `.boxignore`? Validate crash consistency under stop.
* Where should exports live when Boat is the only hosting provider? A local export
  is useful but not an offsite backup; adding an external store would be an explicit
  product dependency.
* Does Telegram require a public Boat route or can polling remain the default? If a
  webhook is needed, define a dedicated public endpoint and keep the app itself
  private/authenticated.
* Which lifecycle owns stop/resume (app scheduler, installer monitor, or user)?
  Define leases so a user request cannot race an idle stop.
* What Boat plan, per-user concurrency, TTL, and budget defaults are acceptable?
  Expose `small/default/large`, bounded TTL, no-auto-stop, and a monthly estimate
  before creation; never enable auto-refill implicitly.
* Which Boat API key actions are actually required by the adapter, and can a
  sandbox-scoped key replace account scope after provisioning? Confirm key expiry
  and rotation UX without putting a secret in the deployment journal.

## Sources

Official Boat documentation, fetched 2026-09-22:

* [Documentation index](https://docs.boat.dev/llms.txt)
* [Quickstart](https://docs.boat.dev/quickstart), [pricing](https://docs.boat.dev/pricing),
  [machines](https://docs.boat.dev/machines), [platform guide](https://docs.boat.dev/platform-guide)
* [Environments and secrets](https://docs.boat.dev/environments), [setup and scripts](https://docs.boat.dev/setup)
* [Snapshots and copies](https://docs.boat.dev/snapshots), [long-running tasks](https://docs.boat.dev/long-running-tasks),
  [hosting](https://docs.boat.dev/hosting)
* [API keys](https://docs.boat.dev/api-keys), [webhooks](https://docs.boat.dev/webhooks),
  [accounts](https://docs.boat.dev/account), [billing](https://docs.boat.dev/billing)
* [Public API v1](https://docs.boat.dev/api/v1), [use in code](https://docs.boat.dev/use-in-code),
  [CLI reference](https://docs.boat.dev/cli-reference)

The local authenticated CLI was inspected read-only with `boat --help`, command
help for lifecycle/environment/API-key/webhook commands, and `boat prompt --help`.
No command that provisions, mutates, or reveals account data was run.
