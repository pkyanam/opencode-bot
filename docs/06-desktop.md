# Desktop application plan

This document is a packaging plan, not a shipping guide. There is no native
desktop shell in this repository today: `apps/desktop/` does not exist, and no
Tauri/Electron host, local control plane, bundled runtime, installer, updater,
or signed artifact has been built. The current supported interface is the web
client and the default computer is the Cloudflare Sandbox.

The additional owned-node direction is also still underway. The outbound
`scripts/node-agent.mjs` entrypoint now has a development registration/polling
protocol for a user's own macOS, Linux, or Windows runner, but its transport,
policy, recovery, and product integration still need qualification. It must not
be described as the default computer provider or as a finished desktop product.

The first desktop milestone should reuse the existing React/shadcn web
interface and add a native host that can run the same bot product against a
local computer or the Cloudflare deployment.

## Decision

Use **Tauri 2** as the desktop shell and package a small Rust supervisor plus
the web UI. Tauri's bundler supports `externalBin` sidecars and names each
binary with its target triple, which directly supports separate OpenCode 2
artifacts for Apple Silicon, Intel macOS, Linux, and Windows
([Tauri sidecars](https://v2.tauri.app/develop/sidecar/),
[Tauri bundle configuration](https://v2.tauri.app/reference/config/)). Tauri
keeps the installed shell smaller than Electron because it uses the operating
system webview; the tradeoff is a larger compatibility matrix and more Rust
IPC code.

Electron remains a fallback candidate if WebView2/WebKitGTK behavior blocks a
feature. Its `utilityProcess` API is a strong alternative for supervising a
Node server and provides exit, stdout, and message-port events
([Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)).
It is not the initial choice because shipping Chromium and Electron alongside
Node increases download and idle-memory cost, while the existing UI is already
browser-oriented.

## Proposed bundle

Once implemented, the app should work on a clean supported machine without
asking the user to install OpenCode, Node, Python, or a database. A release is
expected to contain:

| Component | Packaging decision |
| --- | --- |
| React/shadcn UI | Static assets in the Tauri webview; same routes and API client as web |
| OpenCode 2 CLI/server | Signed native sidecar, pinned to the qualified `2.0.x` release |
| Node runtime | Pinned Node 24 runtime sidecar for the supervisor and local control plane |
| Local control plane | Node process using SQLite and the shared domain/coordinator contracts |
| Browser | Playwright Chromium revision, installed in the app data directory on first use or shipped in a separate optional component |
| Credentials | OS keychain item; never a project file or command-line argument |
| Workspace | User-selected project folders, with an app-owned state directory separate from source trees |

OpenCode's current client is designed to connect to a server and has a native
service manager (`Service.ensure`, `Service.discover`, and `Service.stop`)
([OpenCode JavaScript client](https://opencode.ai/v2/docs/build/client)). The
desktop supervisor should call the bundled command directly with an explicit
service registration file and exact version predicate. It must not use an
unqualified system `opencode` executable. The local server remains the normal
OpenCode 2 HTTP server; the application uses an ephemeral loopback endpoint
and the typed `@opencode/client` package.

The OpenCode project also exposes an embedded SDK that routes requests in
memory without an HTTP listener ([OpenCode SDK](https://opencode.ai/v2/docs/build/sdk)).
That option is useful for a later reduced-footprint mode, but it does not
replace the local control plane: coordination, runs, approvals, checkpoints,
and recovery still need the product's SQLite adapter and event journal.

## Process and trust model (target)

The Tauri Rust process is the supervisor. It starts two children only when
local mode is selected:

1. `opencode serve --service --hostname 127.0.0.1 --port <ephemeral>` with a
   generated service file and server credential.
2. `node supervisor.mjs`, which owns SQLite migrations, run admission,
   checkpointing, connector policy, and the app IPC bridge.

The UI never receives a provider key or the OpenCode password. On startup,
Rust chooses an unused loopback port, generates 256 bits of random auth
material, passes it through inherited descriptors or a protected environment
block, and gives the UI a short-lived capability only through Tauri commands.
The supervisor validates an app instance nonce and request signature before
forwarding an operation. Bind servers to `127.0.0.1`, reject non-loopback
origins, and close both listeners on shutdown. Do not expose the local API on
LAN addresses, and do not use a fixed port as an access-control mechanism.

The cloud mode uses the same UI contracts but points to the authenticated
Cloudflare Worker. The desktop stores only the cloud endpoint and a refreshable
credential in the OS keychain. A cloud run continues when the laptop sleeps;
a local run reports an honest waiting or interrupted state when the machine is
off. The selection belongs to the workspace, not to an individual message,
so a run cannot silently jump from a local computer to a remote one.

## Local SQLite adapter

Cloudflare Durable Objects are authoritative in the hosted topology. They are
not available as a local standalone service, so the desktop needs a separate
adapter implementing the same domain interfaces:

```text
packages/domain              pure run/task/approval/event contracts
packages/storage-sqlite      SQLite schema, migrations, transactions
packages/coordinator-local   leases, alarms, outbox, replay and recovery
packages/runtime-opencode2   typed OpenCode client and event reconciliation
apps/desktop/supervisor       IPC, lifecycle, keychain and filesystem policy
```

SQLite stores the workspace, bots, tasks, runs, event journal, action ledger,
checkpoint manifests, and encrypted metadata. Large files and browser profiles
remain in the app data directory with content hashes; they are copied to R2
when the user enables cloud backup. A checkpoint is committed only after
quiescing writers, writing an immutable manifest, hashing files, and recording
the commit in SQLite. A crash during a checkpoint must leave the previous
manifest usable.

Use SQLite WAL mode, a busy timeout, one migration lock, and a schema version
that the supervisor checks before admission. Do not put a live SQLite database
on an R2 mount or sync folder. Export/import is an explicit archive operation
with checksums and a migration preview.

## Browser and computer capability

The initial desktop local computer is the user's machine, with explicit
workspace selection and a visible control indicator. Package Playwright's
Chromium download separately from the minimal app if size matters. On first
launch, show the exact revision and disk requirement, then download only after
the user enables browser automation. Keep the browser profile under the app
data directory; never reuse the user's personal Chrome profile or cookies.

Terminal, file, and browser actions go through the supervisor's policy layer.
The UI can request an action, but the supervisor checks workspace grants,
approval hashes, path boundaries, and the current run generation. A user
takeover pauses automated input and records the transition. The desktop does
not claim per-bot OS isolation; separate Cloudflare/VM computers remain the
hardened option for untrusted work.

## Owned-node work in progress

The first cross-platform step is the outbound agent at
`scripts/node-agent.mjs`. Its development flow is:

```sh
npm ci --prefix runner
node scripts/node-agent.mjs register --control-url https://YOUR-WORKER.example --pairing-token PAIRING_TOKEN --name "My Mac"
node scripts/node-agent.mjs start
```

The agent makes outbound HTTPS requests and does not require an inbound tunnel.
Registration creates a private node secret and local runner token in the
platform config directory. `start` launches the existing local runner on
loopback with agent-owned state/workspace directories; `run --config` can attach
to an already-running runner. The agent forwards only explicitly queued runner
jobs. The current Worker routes bot/thread-affined
runs to the selected node and forwards cancellation and approval commands;
completed results reconcile through durable receipts. Remote terminal/desktop
relay and live native transcript browsing are unavailable, and the agent
reports browser and desktop capabilities as unavailable until those adapters
are implemented. Before an owned node can be offered as a full product
computer, qualify authenticated outbound transport, registration/revocation,
lease generations, workspace path boundaries, checkpoint/recovery semantics,
and sleep/offline behavior on all three operating systems.

## Lifecycle and failure behavior

Startup is a state machine: acquire the app lock, open or migrate SQLite,
discover a compatible OpenCode service, start one if absent, verify the health
and version endpoints, then attach the UI. If a prior process has a live lock,
offer to reconnect or recover after checking its PID and nonce. Never kill an
unknown process solely because a port is occupied.

On window close, keep the supervisor alive only when background local work is
enabled and show it in the tray/menu bar. Otherwise checkpoint and stop the
OpenCode server. On sleep, stop new local admissions, flush the event journal,
and let active runs enter a recoverable waiting state. On wake, reconcile the
OpenCode session log before resuming. On crash, mark leased runs recovering;
an ambiguous external action remains `unknown` until reconciled and is never
blindly resent.

Quitting must be explicit when local runs are active. The confirmation should
offer “keep running in background”, “checkpoint and stop”, and “cancel runs”.
An OS termination event gets a bounded graceful-stop window, followed by
termination of only the child processes owned by the recorded supervisor
generation.

## Security and packaging

Use Keychain on macOS, Credential Manager/DPAPI on Windows, and Secret Service
on Linux when available. Store a key reference and provider identifier in
SQLite, not the secret. If no Linux keyring is available, require an explicit
encrypted vault password and explain the recovery tradeoff. Apply least
privilege to the Tauri capabilities file: filesystem access is limited to the
selected workspace and app data directory, and shell execution is available
only to the supervisor.

Sign every native executable, sidecar, installer, and update manifest. macOS
builds need Developer ID signing and notarization; Windows builds need an
Authenticode certificate and an installer that preserves the app data path;
Linux publishes a signed AppImage plus a distro package where practical. The
updater verifies signatures before replacing the app and keeps the prior
version until the new supervisor passes a health check. Never update an
OpenCode sidecar independently of its client contract and migration manifest.

Updates pause local admission, checkpoint, close the server, install the new
bundle, run migrations in a transaction, and restore the previous bundle on
failure. Cloud and local releases share the domain contract version but may
use different runtime adapters. Exportable encrypted checkpoints and a
separate key backup are required before calling an upgrade reversible.

## Build and CI plan

The future repository additions should be:

```text
apps/desktop/
  src-tauri/                 Rust supervisor and capabilities
  src/                       desktop shell routes and cloud/local picker
  binaries/                  target-specific OpenCode 2 and Node launchers
packages/storage-sqlite/
packages/coordinator-local/
packages/desktop-protocol/
scripts/desktop/fetch-runtime.mjs
```

Build native artifacts on native runners where signing is required. The
minimum CI matrix is:

| Runner | Artifact and checks |
| --- | --- |
| macOS 14 arm64 | Apple Silicon DMG, signed/notarized smoke test |
| macOS 14 x64 | Intel DMG, Rosetta or native sidecar check |
| Ubuntu 22.04 x64 | AppImage, sandboxed filesystem and SQLite recovery |
| Windows 2022 x64 | MSI/NSIS, Credential Manager, process cleanup |
| Windows arm64 (later) | ARM installer and native sidecar qualification |

Each build verifies sidecar hashes, OpenCode `/api/info` or health response,
client/server compatibility, SQLite migration/rollback, loopback rejection,
sleep/restart recovery, keychain round trips, and an offline local coding
scenario. Release promotion requires the same checkpoint restore probe used by
the Cloudflare deployment. Browser automation is an optional CI job because
the Chromium payload and platform sandbox behavior make it a separate release
component.

The first desktop milestone is a signed development bundle with local chat,
one selected workspace, one OpenCode 2 server, SQLite event persistence, and a
clean shutdown/restart test. Cloud selection, browser packaging, auto-update,
and multi-bot local concurrency should follow only after those recovery tests
pass.
