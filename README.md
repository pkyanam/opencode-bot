<p align="center">
  <img src="apps/web/public/brand/opencode-bot-wordmark.png" alt="opencode bot" width="640">
</p>

<p align="center">
  <a href="https://github.com/pkyanam/opencode-bot/actions/workflows/ci.yml"><img src="https://github.com/pkyanam/opencode-bot/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node.js 24 or newer">
  <img src="https://img.shields.io/badge/OpenCode-2.0.11-6c47ff" alt="OpenCode 2.0.11">
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Sandbox-f38020?logo=cloudflare&logoColor=white" alt="Cloudflare Sandbox runtime">
</p>

# OpenCode Bot

An early, private self-hosted workspace for persistent bots powered by
[OpenCode 2](https://opencode.ai/v2/docs/), Cloudflare Workers, SQLite Durable
Objects, Sandbox computers, and R2. The web client is a React/shadcn interface
with OpenCode-inspired surfaces. It is useful for a personal development
environment, but it is not a production SaaS release.

## Get a private checkout

The repository is private. Authenticate GitHub CLI once, then use this working
clone-and-install command:

```sh
gh auth status && gh repo clone pkyanam/opencode-bot && cd opencode-bot && npm ci && ./setup.sh plan
```

The command intentionally uses `gh repo clone`; a raw unauthenticated download
URL will fail for this repository and can make it easy to paste credentials into
shell history.

If you are using a coding agent, paste this prompt after cloning:

```text
Set up opencode bot for me from this repository. Read README.md, run the prerequisite doctor and setup plan, and help install missing local prerequisites. Start the local web preview and verify it. Show me the exact Cloudflare resources and costs before deployment. Keep credentials in the documented secret stores. Help me connect a BotFather bot and pair my other computers once the server is deployed. Do not put tokens in git or logs.
```

## Current execution modes

The default product path is the Cloudflare-hosted mode: a Worker serves the API
and web assets, a SQLite Durable Object coordinates bots and runs, and a
Cloudflare Sandbox provides the Linux computer and OpenCode 2 runner. Provider
inference normally leaves Cloudflare and uses the provider configured by the
operator.

An additional owned-node path for a user's macOS, Linux, or Windows machine is
under active development around the outbound `scripts/node-agent.mjs` protocol.
It registers through a one-time owner pairing token, polls the existing Worker,
and forwards explicitly queued runner jobs to a local runner. The protocol is
still a development path, not the default computer provider, and this
repository does not currently ship a native desktop shell.

The current development flow is:

```sh
npm ci --prefix runner
node scripts/node-agent.mjs register --control-url https://YOUR-WORKER.example --pairing-token PAIRING_TOKEN --name "My Mac"
node scripts/node-agent.mjs start
```

The pairing token is single-use. Registration generates a private node secret
and a local runner token in the platform config directory. `start` launches the
runner on loopback with a separate state/workspace directory and connects the
outbound agent; `run` connects to an already-running runner. Node registration
and explicit protocol jobs work;
bot/thread affinity now routes normal
conversations to the selected node and forwards cancellation and approval
commands. Remote terminal/desktop access and a live native transcript for owned
nodes are unavailable; completed remote runs reconcile through durable receipts.

## Local development

Use Node.js **24 or newer**, npm, and Docker Desktop (or another reachable
Docker daemon). From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Start the Worker and web client in separate terminals:

```sh
# Example tokens for local development only.
npm run preview:worker -- --var APP_TOKEN:local-preview-token --var RUNNER_TOKEN:local-runner-token
npm run dev
```

The stable preview snapshots the backend and assets while Vite keeps frontend
hot reloads. Restart `preview:worker` after backend changes. For ordinary
backend development, `dev:worker` watches source directly; local container
egress may need a restart after a Worker reload.

The stable preview wrapper treats a planned stop as a computer lifecycle
operation: it requests an authenticated idle checkpoint, writes a restart
marker, stops only containers owned by this preview task, and then stops the
Worker process. On the next start it restores only when the marker matches the
committed checkpoint and the computer reports that restore is required. A
missing, mismatched, or uncertain marker requires manual recovery.

Open <http://localhost:5173> and enter `local-preview-token` in Connection
under Settings → Connection. The Worker listens on port **8789**. The first computer request starts
a local Sandbox container; Docker builds target Linux amd64, including on Apple
Silicon. For real inference, put a supported provider key in the gitignored
`.dev.vars` file described by `.dev.vars.example`. Model IDs use
`provider/model`. The project does not modify a global OpenCode installation or
copy global OpenCode credentials.

## Cloudflare setup

The checked-in setup program has read-only `doctor` and `plan` commands. Only an
explicit `--apply` performs deployment mutations:

```sh
./setup.sh doctor
./setup.sh plan > deployment-plan.json
npm exec wrangler login                 # if Wrangler is not authenticated
./setup.sh apply --apply --install-missing
```

`--install-missing` permits local dependency installation; it does not purchase
a Cloudflare plan, enable billing, accept account terms, or modify unrelated
resources. The account must already be eligible for Workers Paid, Containers,
and R2. Keep names in `infra/deployment.json` and `wrangler.jsonc` aligned.
Provider keys supplied through `OPENAI_API_KEY`, `XAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, or `OPENCODE_API_KEY` are uploaded as
Worker secrets. Generated owner/runner tokens stay in the gitignored,
mode-0600 `.opencode-bot/secrets.json`; read the owner token locally before
connecting the web client. See [operations](docs/05-operations.md) and the
[Cloudflare setup design](docs/03-cloudflare-setup.md).

## What works today

The current vertical slice includes:

- bot, thread, task, run, and event records in SQLite Durable Objects;
- conversation deletion in its three-dot menu and bot deletion inside Bot settings, with active-work protection and native OpenCode session cleanup (owned-node deletion is not yet supported);
- Skills → Discover for community directories, OpenCode 2 plugin documentation, and editable repository review requests;
- idempotent prompt submission, cancellation, event reconciliation, and native
  OpenCode permission replies;
- bot instructions, memory/skills, interval routines with overlap suppression,
  and missed-tick coalescing;
- authenticated artifact upload/download and a headed Playwright MCP browser visible in a live desktop pane; click its preview to expand it to the app window;
- native OpenCode terminal with responsive sizing and the full native command UI;
- searchable live model catalog, named conversations, chronological transcripts, and provider error details;
- Settings → OpenCode → Provider connections key, OAuth, credential label/activation/removal, and
  custom OpenAI-compatible endpoint configuration;
- callable bot messaging through the runner MCP tools `list_bots`,
  `send_message`, and `get_replies`; these address independent persistent
  workspace Bots, not OpenCode subagents. A recipient is queued after the
  sender's current turn and its reply automatically continues the source
  conversation;
- secure GitHub-flavored Markdown rendering for user, assistant, and bot
  handoff messages, with raw HTML disabled and unsafe link protocols removed;
- Telegram configuration, expiring QR deep links, account pairing/revocation,
  and durable text reply receipts; live text delivery has been qualified with a
  user-created BotFather bot;
- owned-computer pairing, heartbeat, revocation, and explicit outbound runner jobs;
- an explicit idle computer checkpoint/restore flow backed by committed R2
  archives; and
- a dependency-free setup planner, prerequisite doctor, and retryable apply
  journal.

The initial computer is a trusted personal environment shared by all bots. It is
not a multi-user security boundary. Per-action external write receipts, enforced
egress, multi-user isolation, human browser takeover, additional connectors,
and remote terminal/desktop relay remain planned work. Provider credentials are
handled through the OpenCode provider flows and are not included in catalog
responses, persisted browser state, or error messages.

Sandbox working disk is ephemeral. Use **Computer → Checkpoint** while idle to
preserve workspace, runtime state, and browser profile. Only committed archives
can be restored; the initial buffered checkpoint limit is **32 MiB compressed**.
Larger workspaces need the planned streaming snapshot implementation.
Ambiguous interrupted runs become `needs_review` and are not automatically
replayed.

## Native desktop status

There is no native desktop application in this repository today: no Tauri or
Electron shell, bundled Node runtime, bundled OpenCode binary, local SQLite
control plane, installer, or signed artifact exists yet. The [desktop packaging
plan](docs/06-desktop.md) describes a possible Tauri 2 shell with
bundled OpenCode 2 and Node sidecars, OS keychain storage, and local/cloud mode
selection; those are design targets, not shipped features.

## Qualification and model access

The `computer_browser` MCP integration controls the same headed Chromium
instance displayed in the live preview. Its tools are directly available to
each Bot; it does not require the OpenCode desktop app or its experimental
browser connection. A live Scout request successfully navigated to
`https://opencode.ai/`, verified its title, and displayed that page in the
expanded computer stream.

The conversation displays native assistant updates and tool calls in their original
order. Tool rows show the action, target, execution state, and a short result;
expanding a row reveals bounded input and output. While a task runs, native
messages refresh every two seconds. Retry and approval notices appear alongside
messages, and raw reasoning/event payloads are excluded from the transcript.
A live free-Muse check displayed commentary, two shell calls, and a final reply;
a second check verified that a running shell call appeared before completion.
Dropped native wait connections are retried without resubmitting the prompt.
If the connection cannot recover, the runner stops native execution before
publishing a review state; checkpointing also waits for execution to unwind.

The current local suite reports **135 passing tests** covering real SQLite
coordination, provider contracts, artifact paths, owned-node routing/receipts,
setup simulation, and the [OpenCode CLI qualification harness](tests/qualification/README.md).
That harness runs isolated OpenCode CLI 2.0.11 against a local fake
OpenAI-compatible endpoint, verifies catalog discovery, and completes a
continuing session without reading the user's credentials or provider. A
Cloudflare-local wrapped app run completed from
`2026-09-20T23:13:41.264Z` to `2026-09-20T23:13:50.872Z` with native OpenCode
CLI 2.0.11 and `opencode/muse-spark-1.3-contributor-free`, returning `My name
is Scout.` at zero reported cost; see the [qualification record](tests/qualification/free-model.md).
An account deployment remains a separate validation step, and local checks do
not establish production readiness.

Telegram uses a quiet, edited activity message for current commentary and tool
actions, throttled to at most one edit every four seconds. Bot handoffs carry
that message into the continuation. The final reply contains the last assistant
answer rather than concatenated progress commentary, with Telegram HTML for
bold text, links, lists, and code. Long replies split into independently valid
messages. Activity excludes private reasoning and raw tool payloads.

Telegram live qualification paired a user-created BotFather bot and delivered
two real Muse replies. The durable `telegram_run_deliveries` records reached
`sent`; the first reply at approximately 23:17 UTC was “Going well. I’m Scout.”
and the second at approximately 23:18 UTC completed a computer-hardware tool
run. This qualifies text delivery and tool-backed completion for that run; live
command handling such as `/new` still needs its own qualification. Automated
Telegram tests continue to use a mocked Bot API.

Callable Bot messaging is implemented as a bounded handoff: `list_bots`
discovers independent persistent workspace Bots, `send_message` queues a
message for after the sender's current turn, and `get_replies` reads receipts
already available to the source conversation. A turn permits at most eight
requests; ancestry metadata prevents loops, and a continuation summary cannot
send another Bot message. The recipient's completed reply automatically
continues the source conversation. A live check on September 21, 2026 used Scout with Cloudflare Workers AI
(`glm-5.3-flash`) to message Llama using OpenCode’s free Muse model. Llama
answered under its own identity, then Scout automatically relayed that reply
in the original conversation. No OpenCode subagent or manual handoff button
was used. Nested handoffs and Telegram continuation routing have automated
coverage; a live nested/Telegram handoff check is still pending. The
qualification record also retains an isolated Big Pickle request that
received `403 FreeTierError` from the direct Zen path without an account
credential. That is a scoped observation about that model/request path, not a
blanket statement that every free model is unavailable.

## Research and design documents

The documents below describe the target architecture and record the evidence
behind the current scope. Some capabilities in them are future milestones.

1. [Research dossier](docs/01-research.md) — OpenCode 2, Grok Bot, platform
   evidence, and compatibility traps.
2. [System design](docs/02-design.md) — product behavior, storage, security,
   recovery, and portability.
3. [Cloudflare setup](docs/03-cloudflare-setup.md) — prerequisites,
   provisioning, upgrades, costs, and recovery.
4. [Implementation roadmap](docs/04-roadmap.md) — vertical slices, spikes, and
   release gates.
5. [Operations guide](docs/05-operations.md) — doctor, apply, secrets,
   checkpointing, and recovery.
6. [Desktop plan](docs/06-desktop.md) — proposed native packaging for
   macOS/Linux/Windows.
7. [Feature parity](docs/07-feature-parity.md) and [visual audit](docs/08-visual-audit.md).
8. [Source register](research/sources.md) — primary sources and evidence quality.

Research date: **September 20, 2026**. The repository has not undergone an
account Cloudflare deployment, paid inference run, or VM-provider qualification;
the local Worker/Sandbox qualification is recorded separately above.

See [comparative product decisions](docs/09-comparative-design.md) for the Grok Bot, Hermes, and OpenClaw research, implemented boundaries, and remaining acceptance gates.


## Telegram setup

Open **Settings → Telegram**, select your OpenCode bot, and create a Telegram
bot with [BotFather](https://t.me/BotFather). Paste its token and connect.
Local installations default to **polling**: the server makes outbound requests,
so no public URL, tunnel, or port forwarding is required. Keep the server running.
Cloudflare installations default to **webhooks** using the deployed app's HTTPS
URL. Telegram permits only one receiving mode per bot token. Use a separate
BotFather bot if another Hermes/OpenClaw instance still uses the existing one.

Select **Link my Telegram account**, scan the expiring QR or open its link,
and press Start. The QR encodes a bot deep link, not an account-login QR. The
server accepts messages only from paired chat/user combinations. Unlink accounts
from Settings. Polling offsets, update receipts, and reply delivery state survive
restarts. Text delivery is implemented; voice/file handling and inline approval
buttons remain channel extensions.

Automated Telegram tests use a mocked Bot API and real SQLite persistence. Local
installations use outbound polling by default and do not need HTTPS; Cloudflare
can use the HTTPS webhook option after a live token and reachable deployment are
supplied.

See [Skills and plugins](docs/10-extensions.md) for Agent Skills compatibility, OpenCode 2 plugin APIs, catalog discovery, and the planned installation workflow. Discovery currently browses sources and drafts reviews; it does not install extensions.
