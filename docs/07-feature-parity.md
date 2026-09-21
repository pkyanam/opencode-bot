# OpenCode 2 and Grok Bot feature parity

This audit was checked against the current OpenCode 2 documentation and the
official SpaceXAI Grok Bot documentation on 2026-09-20. It separates server
capabilities from terminal UI affordances and records what this repository
currently implements.

## OpenCode 2 surface

This audit is against the pinned `@opencode/client` 2.0.11 surface in
`node_modules`, with the published V2 API reference as the operation and route
reference. The reference describes 136 operations and 245 schemas. The table
maps the complete operation families to the path currently available to a
user:

- **Web app** means a route and UI in this repository.
- **Native TUI/CLI** means the authenticated Native OpenCode terminal currently
  opened by `/api/terminal`, or the documented `opencode` CLI/API commands.
- **Runtime** means the app calls the operation internally, but does not offer
  a general-purpose UI for it.
- **Web gap** means the native capability exists, but this web app has no
  equivalent panel yet. It is not a claim that the OpenCode API is missing.

| Capability family | OpenCode 2.0.11 operations | Current exposure |
| --- | --- | --- |
| Server and location | `server.info`; `location.get`, `location.reload` | Runtime health uses `server.info`; the web workspace has a fixed location. Location inspection/reload remains Native TUI/CLI/API. |
| Agents and plugins | `agent.list`, `agent.get`; `plugin.list`, `plugin.check`, `plugin.update` | Agent metadata and selection are in the web catalog/settings. Plugin inspection and updates are Native CLI/TUI/API; no web plugin panel. |
| Session lifecycle | `session.list`, `stats`, `create`, `import`, `export`, `active`, `get`, `remove`, `fork`, `switchAgent`, `switchModel`, `update`, `move` | Web app creates, resumes, and runs sessions and switches model/agent. Session browser, stats, import/export, fork, move, and delete controls are Native TUI/CLI or Web gaps. |
| Session execution | `session.prompt`, `command`, `skill`, `synthetic`, `shell`, `compact`, `wait`, `interrupt`, `background`, `generate`, `log` | Prompt, command, wait, interrupt, compact, native undo/redo actions, run receipts, and log/message views have application paths. Shell is available through Native TUI under approval policy; synthetic/background/generate controls do not have dedicated web panels. |
| Transcript and state | `message.list`, `session.message.get`; `session.context`, `session.diff`, `session.environment`, `session.view`; `session.instructions.entry.list/put/remove` | Web chat and completed-run receipts expose projected messages. Context, diff, environment/view, and instruction-entry management are the first essential Web gaps; Native TUI/CLI/API remains available. |
| Revert and inbox | `session.revert.stage`, `session.revert.clear`, `session.revert.commit`; `session.inbox.list`, `session.inbox.cancel`, `session.inbox.update` | Native undo/redo actions and runtime revert methods exist. A reviewable context/diff/revert panel and inbox management are Web gaps. |
| Forms and permissions | `session.form.list/create/get/reply/cancel`; `form.list`; `permission.request.list`, `permission.saved.list/remove`, `permission.create/list/get/reply` | Approval requests and one-shot replies are in the web app with durable receipts. Forms and saved permission policy management are Web gaps; native approval behavior remains available. |
| Models and providers | `model.list`, `model.default`; `provider.list`, `provider.get`; `generate.text` | Model/provider catalog data and model selection are in the web app. Settings → OpenCode → Provider connections now supports key and OAuth connections, credential management, and custom OpenAI-compatible provider configuration; `generate.text` remains a runtime/native API path. An isolated CLI qualification verifies catalog discovery and completion against a fake endpoint. |
| Integrations and credentials | `integration.list`, `integration.get`, `integration.wellknown.add`, `integration.connect.key`, `integration.oauth.connect/status/complete/cancel`, `integration.command.connect/status/cancel`; `credential.update/activate/remove` | Settings → OpenCode → Provider connections uses an allowlisted server proxy for key, OAuth, command, label, activation, and removal flows. Keys are not returned in catalog/status payloads or error messages. Native `/connect` and CLI/config remain valid alternatives. |
| MCP | `mcp.list`, `mcp.add`, `mcp.remove`, `mcp.connect`, `mcp.disconnect`, `mcp.resource.catalog` | Settings → MCP services and `/mcps`/`/mcp` expose installed-service status plus supported connect/disconnect and metadata-driven OAuth sign-in. Add/remove and resource browsing remain Native OpenCode/CLI paths unless the server exposes them. |
| Files and artifacts | `file.read`, `file.list`, `file.find`, `file.write` | Native OpenCode file tools remain inside the computer. The app has authenticated artifact transport and previews, not a general OpenCode file browser/editor. Native TUI/CLI/API is the current path. |
| Commands and skills | `command.list`; `skill.list` | The app has a command palette and persisted skill library/assignment flow. Native command/skill discovery and editing remain Native TUI/CLI/API or Web gaps. |
| Events and messages | native event stream; `message.list`, `session.message.get`; `session.log` | Cloudflare runs watch live events and reconcile assistant messages after `wait`; application events and completed owned-node results are durable receipts. Reconnect logic reads projected messages/logs because live events are not replay storage. |
| Shell and PTY | `shell.list/create/get/output/remove`; `pty.list/create/get/update/remove/connect.token`; `experimental.persistentPty.read/list/create/shutdown/handoff/get/update/snapshot/remove/connectToken` | The authenticated Native OpenCode terminal has responsive polling. Persistent PTY management is Native TUI/CLI/API; owned-node terminal relay remains unavailable. |
| Projects and worktrees | `project.list`, `project.update`; `worktree.list/create/remove/refresh` | No corresponding web project/worktree panel. Native TUI/CLI/API remains available; add a web surface with multi-project support rather than implying that a Bot thread is a worktree. |
| VCS and references | `vcs.get`, `vcs.base`, `vcs.status`, `vcs.branch.list`, `vcs.diff`; `reference.list` | No web review/diff panel yet. Native TUI/CLI/API remains available; this is part of the context/diff work above. |
| Diagnostics and migration | `debug.location.list`, `debug.location.evict`; `migration.v1.status` | Native diagnostic/API paths only; no web diagnostics panel. |
| Search and configuration | `websearch.providers`, `websearch.query`; `config.get`, `config.shells`, `config.update` | Runtime configuration is generated for the app's controlled workspace. Web search and general config editing are not exposed by this app; use the Native CLI/TUI/API where appropriate. |

The reference is the source of truth for operation names and routes:
[OpenCode V2 API](https://opencode.ai/v2/docs/api/). The CLI also provides
the documented `opencode api` escape hatch for server operations and dedicated
commands such as `opencode mcp`, `opencode plugin`, `opencode auth`, and
`opencode session`; these are not web routes.

The runtime must preserve the distinction between a submitted input and an
execution result. `session.prompt` admits work; `session.wait` waits for an idle
agent loop; `message.list`, `session.message.get`, `session.context`, and `session.log`
read durable projected state; the event stream is live-only. A reconnecting
client must reconcile from those message/log APIs instead of assuming the event
stream can replay.

## TUI commands versus server APIs

The terminal interface is a client of the server. The authenticated Native TUI
path is valid for the OpenCode workflows that do not yet have a web panel; a
slash command is not itself a remote API method:

| TUI affordance | Meaning | Current path |
| --- | --- | --- |
| `/models` | interactive model selector | Native TUI; web catalog/model selection also exists through `/api/catalog` and session model selection |
| `/agents` | interactive agent selector | Native TUI; web catalog/agent selection also exists |
| `/sessions` | session picker | Native TUI; web threads cover the app's Bot sessions, while full native session import/export/fork remains native |
| `/undo`, `/redo` | snapshot/revert workflow | Native TUI; runtime exposes revert stage/clear/commit, with a reviewable web context/diff panel still needed |
| `@file` context | add file context to a composer | Native TUI; web context attachment is a priority Web gap |
| `/editor` | edit the current composer in `$EDITOR` | Native TUI/desktop convenience; no browser equivalent is required |
| `/btw <question>` | side question using context without adding a transcript message | Native TUI; no dedicated web equivalent |
| `/new` and leader-key actions | tabs, session creation, palette, settings, service actions | Native TUI; web app has its own Bot/thread and command-palette orchestration |
| `!command` | TUI shell mode | Native TUI; the server operation is `session.shell` and must use the same approval policy |
| `/review` and other commands | prompt templates discovered from Markdown/config | Native TUI/CLI; the server operation is `session.command` with the configured command name and text |
| `/connect` and provider setup | authenticate a provider and choose models | Native TUI/CLI/config; the web app now provides the same main key, OAuth, credential, and custom-provider setup flows in Settings → OpenCode → Provider connections |
| `opencode mcp`, `opencode plugin`, `opencode auth`, `opencode api` | manage integrations, plugins, credentials, or call server operations | Native CLI/API remains the full surface. The web app has a curated MCP status/connect/OAuth panel and provider credential setup, while unsupported native subcommands stay in Native OpenCode. |

The official TUI guide documents `@` file context, `!` shell mode, slash
command filtering, `/btw`, model/agent/session controls, tabs, undo/redo, and
editor integration: [OpenCode TUI](https://opencode.ai/v2/docs/cli/tui/).
The complete action/key binding catalog is in [OpenCode keybinds](https://opencode.ai/v2/docs/cli/keybinds/).
The CLI guide documents noninteractive `run`, session import/export, MCP,
plugins, service, pair, and `api`: [OpenCode CLI commands](https://opencode.ai/v2/docs/cli/commands/).

Commands are reusable prompt templates. Project commands live under
`.opencode/commands/`; V2 configuration uses `commands`, not the V1 singular
`command` map. A command can select an agent and model, but it is still
submitted as server work. See [Commands](https://opencode.ai/v2/docs/commands/).

## Native configuration constraints relevant to this app

The V2 MCP shape is `mcp.servers.<name>` with a local server's `type: "local"`
and an argument array in `command`. V2 uses `disabled`, not `enabled`.
OpenCode connects configured servers automatically. The browser helper emits a
pinned executable command and workspace profile paths; it does not use `npx` at
runtime. See [MCP servers](https://opencode.ai/v2/docs/mcp-servers/) and the
[V1 migration notes](https://opencode.ai/v2/docs/migrate-v1/).

V2 permissions are an ordered array of `{action, resource, effect}` rules;
last matching rule wins and unmatched actions ask by default. The V2 action
names are `shell`, `edit`, and `subagent` where V1 commonly used `bash`,
`write`/`patch`, and `task`. Our approval path must preserve the original
resource and action in the event ledger rather than converting every approval
to an undifferentiated boolean. See [Permissions](https://opencode.ai/v2/docs/permissions/).

V2 has snapshots around model steps and exposes session revert operations, but
the docs describe them as best-effort. They are useful for an interactive undo
feature and are not a substitute for the computer checkpoint protocol in
`docs/02-design.md`. [Snapshots](https://opencode.ai/v2/docs/snapshots/) and
[Compaction](https://opencode.ai/v2/docs/compaction/) are separate: compaction
reduces active context while retaining the stored transcript; a computer
checkpoint captures the runtime filesystem/browser state.

OpenCode V2 session sharing is explicitly unsupported. The self-hosted app
must implement its own authenticated workspace sharing and event authorization
if it later supports multiple users. [Sharing](https://opencode.ai/v2/docs/sharing/).

## Grok Bot product facts to carry into the design

The official product docs describe Grok Bot as named, persistent AI teammates.
Each Bot has a persistent cloud computer with browser, filesystem, and terminal;
work continues when the desktop or mobile client closes. Bots can use
connectors where available and computer use for sites without an API or MCP.
See [Grok Bot overview](https://docs.x.ai/grok-bot/overview) and
[SpaceXAI's launch announcement](https://x.ai/news/introducing-grok-bot).

The important boundary is shared-computer ownership. A user's Bots share one
cloud computer, including files, browser sessions, and app logins. The official
docs say each Bot gets its own screen and one computer-use task runs on that
screen at a time; Bots can still reason, use connectors, and coordinate in
parallel. Between users, isolation is strict. This maps to our initial
single-owner Cloudflare computer, but the app must show the shared trust
boundary clearly and serialize GUI ownership. [Overview, shared computer](https://docs.x.ai/grok-bot/overview).

The product interaction is chat-first rather than a workflow builder: create a
Bot, give it a job/context/access, let it work, then review or approve the
steps that need a person. The documented home/search model spans Messages,
Bots, Group Chats, Files, and Routines. A Bot profile exposes routines,
schedule, next run, instructions, active/paused state, and run history. The
mobile client is a thin client for starting work, answering questions,
approving steps, and reviewing results. [Mobile](https://docs.x.ai/grok-bot/mobile),
[Get started](https://docs.x.ai/grok-bot/get-started).

The documented attention states are `Needs attention` for a question,
approval, or handoff; unread activity; and working/typing status. A browser or
desktop takeover lets a person inspect the current screen and complete a
password, 2FA, CAPTCHA, or other human step. Secret requests are masked and
excluded from the transcript. Hardware security-key use is separately gated.
[Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy).

For teams, the official architecture uses one dedicated Firecracker microVM
per user, no access by default, human approval gates evaluated by an
independent Auto Review model, and administrative network/audit controls.
Cloud Agents can be delegated to separate computers. This is stronger than
our initial trusted personal Cloudflare Sandbox and should be represented as a
future hardened provider, not implied by the current implementation.
[Grok Bot for teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises).

## Product parity decisions

The current app has a useful first vertical slice: Bot and thread records,
chat prompt submission, background RunStore execution, live/reconciled run
events, approval replies, authenticated artifact upload/download, a headed
Chromium MJPEG desktop pane, a native OpenCode terminal, a provider setup
surface, and a Cloudflare computer adapter. Owned-node pairing, bot/thread
affinity, cancellation and approval forwarding, callable messaging between
independent persistent workspace Bots, and completed-run receipt reconciliation
are implemented; remote owned-node
terminal/desktop access and live native transcript browsing are unavailable.
The next parity work should be ordered as:

1. Extend the existing attention and approval surfaces with forms and saved
   policy management while preserving action, resource, request ID, expiry,
   and one-shot decision semantics.
2. Extend the existing computer/browser panel with a single GUI lease and
   human takeover. Headed Chromium MJPEG viewing and headless Playwright MCP
   are working in the current image; owned-node desktop relay is not.
3. Extend Bot profiles, routines, schedules/time zones, run history, search,
   and notifications with the remaining product behavior described by Grok
   Bot, rather than generic “agent settings.”
4. Keep callable Bot messaging bounded and explicit. The runner exposes
   `list_bots`, `send_message`, and `get_replies` for independent persistent
   workspace Bots; these are separate from OpenCode's `subagent` capability.
   `send_message` queues the recipient after the sender's current turn and
   automatically continues the source conversation when the reply completes.
   Limit each turn to eight requests, carry ancestry metadata to reject loops,
   and prevent a continuation summary from sending another Bot message.
   Group conversations and richer per-Bot memory remain future work while
   filesystem/browser credentials stay shared only within the chosen owner
   computer. A live Cloudflare Workers AI Scout → free Muse Llama → Scout
   handoff passed; nested and Telegram continuation routing have automated
   coverage. Fresh user turns start new chains, so a historical handoff does
   not prevent a later message back to its sender.
5. Render user, assistant, and handoff text with secure GitHub-flavored
   Markdown: raw HTML is disabled, unsafe URL protocols are dropped, and long
   code/table content remains readable on narrow screens.
6. Add OpenCode context/diff/revert, command/skill discovery, and MCP status
   as focused UI panels. Compact, native terminal actions, and provider setup
   already have application paths.
7. Add the hardened multi-user computer provider with separate microVM or
   equivalent isolation, independent policy review, network controls, and
   durable checkpoint replacement.

The visual target is therefore a chat workspace with a Bot roster and a
conversation detail view, plus clear attention/status indicators and an
inspect/takeover computer surface. It is not a claim that the private Grok Bot
desktop implementation or screenshots are available for reuse; the public
official sources above provide behavior and layout concepts, while our UI must
remain an independent implementation.
