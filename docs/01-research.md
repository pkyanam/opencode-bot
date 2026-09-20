# Research dossier

**As of September 20, 2026.** Product behavior below is documented unless explicitly marked as locally observed, inferred, or proposed. Performance and reliability are not independently benchmarked.

## OpenCode 2: identity and current distribution

OpenCode 2 is a real official product line, not one of the unrelated GitHub repositories named `opencode2`. Its documentation lives under `/v2/docs`. Installation uses `@opencode/cli`, the V2 install URL, or the `opencode-v2` Homebrew formula. The canonical command remains `opencode`; current npm metadata also declares `opencode2`. Installation can replace a V1 binary, so a self-hosting installer should keep its own pinned runtime rather than altering the user's global installation. [V2 introduction](https://opencode.ai/v2/docs/), [migration guide](https://opencode.ai/v2/docs/migrate-v1).

| Evidence | Observation | Consequence |
|---|---|---|
| Official npm registry | CLI, client, SDK, plugin latest tags resolve to 2.0.11 | Pin and qualify a release set; do not deploy floating latest |
| Existing local CLI | `opencode2 --version` returns `opencode v2.0.3` | Help observations are for 2.0.3, not a 2.0.11 runtime test |
| Local CLI help | `serve`, `service`, `api`, `run`, `acp`, `auth`, `mcp`, `plugin`, `session` | Designed for headless and programmatic integration |
| V2 docs | New client and plugin contracts | Port integrations deliberately |
| Repository `dev` snapshot | Older/internal names and event routes differ from current published docs | Branch source is supporting evidence, not the release contract |

Registry URLs and exact integrity values are retained in `research/evidence/*-registry.json`. Source files are pinned to commit `d870e22c70f27103016dcd479edcfebf86136d93`. The published SDK and client declarations were fetched from their npm tarballs with SHA-512 integrity verification. That checks correspondence to registry metadata, not the security of the code.

### Three useful integration surfaces

| Surface | What it provides | Best use here |
|---|---|---|
| `opencode2 serve` + `@opencode/client` | OpenCode server on a real OS, HTTP API, native tools and processes | Initial full-computer implementation |
| `@opencode/sdk` | Embedded OpenCode host, in-process router, explicitly owned lifecycle | Future standalone Node host |
| `@opencode/sdk/workerd` | Embedded host in a SQLite-backed Durable Object; local services replaced or disabled | Future Cloudflare-native runtime with remote computer tools |

The network client is browser compatible; local service management is a separate import. The embedded SDK avoids a network listener. The Workerd profile retains a host per object instance and persists execution state for eviction recovery. These are documented extension points, not speculative ports. [Client](https://opencode.ai/v2/docs/build/client/), [embedded SDK](https://opencode.ai/v2/docs/build/sdk/), [Cloudflare SDK](https://opencode.ai/v2/docs/build/sdk/cloudflare/).

For this project, use a supervised server, not one CLI process per chat message. The observed `run` flags include `--server`, `--standalone`, `--session`, `--fork`, `--model provider/model#variant`, and `--format json`. CLI JSON is useful for diagnostics; use the network client for normal application traffic.

### API and reliable event handling

The published V2 API covers sessions, prompts, active sessions, interruption, model selection, permissions, forms, files, integrations, MCP, PTYs, worktrees, and configuration. Particularly useful are explicit session identity, pending input, and the experimental durable session log. Native global event subscriptions are live-only: the client documentation explicitly disclaims replay and automatic reconnection. [API reference](https://opencode.ai/v2/docs/api), [client stream semantics](https://opencode.ai/v2/docs/build/client/).

**Design implication:** store application events independently. On disconnect, resubscribe and reconcile against the pinned release's session log/status/messages. Never infer that a missing streamed “done” event means the operation did not happen. The observed `dev` source uses session history/event endpoints, whereas current docs expose `session.log`; normalize this inside the adapter, not in the UI.

Authentication also requires release-specific handling. Inspected `dev` CLI source obtains a generated private password from its service state. The underlying auth implementation supports HTTP Basic, but assuming that `OPENCODE_SERVER_PASSWORD` controls every CLI startup path would be unsafe. The installer must verify the chosen release's service discovery/authentication behavior and prove that unauthenticated access fails. [Pinned daemon source](https://github.com/anomalyco/opencode/blob/d870e22c70f27103016dcd479edcfebf86136d93/packages/cli/src/services/daemon.ts).

### Agents, memory, tools, and extensions

An OpenCode agent is a named profile with a system prompt, model preference, permissions, and primary/subagent mode. Child sessions can execute in foreground or background; they have their own permission configuration. Changing a primary agent does not implicitly replace the model already selected for a session. This supports specialist roles, but is not a complete durable team product. [Agents](https://opencode.ai/v2/docs/agents/).

Skills provide reusable instructions and supporting resources; V2 prefers `.opencode/skills/<id>/SKILL.md`. `AGENTS.md` supplies persistent guidance. Session compaction creates a lossy checkpoint while preserving stored earlier messages. These are useful context mechanisms, but product memory still needs ownership, provenance, correction, deletion, and retrieval rules. [Skills](https://opencode.ai/v2/docs/skills/), [instructions](https://opencode.ai/v2/docs/instructions/), [compaction](https://opencode.ai/v2/docs/compaction/).

Native tools cover shell and file work, search, questions, skills, and delegation. MCP supplies external tool servers. V2 plugins use `@opencode/plugin`, with transforms, RPC, tool hooks, permission evaluation, and provider customization. A small first-party plugin can connect OpenCode to the product's approvals, memory, artifacts, and bot mailbox. Arbitrary third-party plugins execute trusted extension code and must not be treated as passive documents. [Tools](https://opencode.ai/v2/docs/tools/), [MCP](https://opencode.ai/v2/docs/mcp-servers/), [plugin API](https://opencode.ai/v2/docs/build/plugins/).

Permissions use ordered rules; the last match wins. Native V2 names include `permissions`, `shell`, and `subagent`. Agent rules can refine global rules. Therefore product-wide restrictions must also be enforced outside editable agent configuration. A global deny in an early rule is not by itself an immutable organizational policy. [Permissions](https://opencode.ai/v2/docs/permissions/).

One meaningful regression for coding tasks: V2 accepts LSP configuration but currently does not run language servers, expose LSP tools, or emit LSP diagnostics. Use compiler, lint, and typecheck commands. V1 plugins do not run unchanged, and terminal configuration now uses a global `cli.json`. [Migration guide](https://opencode.ai/v2/docs/migrate-v1).

OpenCode source snapshots/revert are not computer backups and cannot undo email, CRM updates, or other remote effects. Build recovery around separate application, filesystem, and external-action records. [Snapshots](https://opencode.ai/v2/docs/snapshots/).

### Models: what “OpenCode and its models” means

OpenCode is a harness with provider integrations, not a single model or a promise of bundled private inference. V2 uses a model catalog, supports custom provider endpoints, and exposes model capabilities and variants. It can discover local Ollama, LM Studio, and vLLM endpoints. Some inferred/default capability metadata is only a fallback, so test tool calls and images against the actual selected endpoint. [Providers](https://opencode.ai/v2/docs/providers/), [models](https://opencode.ai/v2/docs/models/).

OpenCode Zen is an optional gateway of curated models; the current catalog spans multiple vendors and protocols. OpenCode Go is a separate subscription offering. Do not route all providers through a chat-completions-only proxy: Responses, Messages, and other provider protocols have different tool, reasoning, and compaction semantics. [Zen](https://opencode.ai/docs/zen/), [V2 providers](https://opencode.ai/v2/docs/providers/).

Proposed model roles:

| Role | Required capability | Selection policy |
|---|---|---|
| Main worker | Reliable tool use, long context, recovery | User-selected model with a qualified workflow score |
| Computer operator | Image input or validated accessibility-based tools | Reject unsupported screenshot tasks before dispatch |
| Router/summarizer | Small structured output, low latency | Cheap qualified model, no authority to grant permissions |
| Reviewer | Structured assessment | Advisory reviewer, never sole enforcement layer |
| Strict Cloudflare mode | Workers AI compatible model and sufficient tools/vision | Explicitly narrower catalog, separate evaluations |

Never silently change vendors, inference region, or cost class on fallback. Save the resolved provider/model/variant per run. Use API credentials as the initial unattended deployment mechanism; subscription sign-in is a separate, explicitly configured integration.

## Grok Bot: product and operating model

SpaceXAI announced Grok Bot on August 11, 2026 as persistent agents that complete work across applications. The product combines named roles, continuity, cloud computers, and collaboration. SpaceXAI and Cursor documentation describe the same product ecosystem: Cursor handles accounts and hosted computers. This is distinct from merely calling a Grok inference API, and from Cursor's repository-focused Cloud Agents. [Launch announcement](https://x.ai/news/introducing-grok-bot), [SpaceXAI overview](https://docs.x.ai/grok-bot/overview), [Cursor overview](https://cursor.com/docs/grok-bot).

### Product mechanics worth reproducing

| Capability | Documented behavior | Proposed equivalent |
|---|---|---|
| Durable role | Name, description, avatar, persistent context | Bot record with versioned role and memory |
| Long-running work | Continues independently of the user's laptop | Durable run records and supervised remote runtime |
| Real tools | Connectors, browser, terminal, files | Connector broker, browser broker, computer adapter |
| Separate conversations | Per-bot history and learned context | Threads separate from shared computer state |
| Shared computer | Account-wide files, logins, cookies, CLI credentials | Explicit workspace trust boundary |
| Multiple bots | Concurrent work, asynchronous messages, groups | Mailboxes, ownership, bounded delegation |
| Reusable work | Skills, demonstrations, schedules/events | Versioned skills and routines |
| Human control | Approval cards and computer takeover | Durable approvals and exclusive human lease |

The account-level computer is the crucial detail. Separate bot screens are work surfaces, not security isolation. Grok Bot's shared workspace is `/workspace`; sign-ins and durable files are intended to survive recovery, but recent unsynced changes can be lost. Local-computer access is separately controlled. [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps).

Bot configuration can be duplicated and shared as templates without copying the creator's computer or logins. Hiding a bot does not stop routines; deleting a bot does not necessarily delete shared files or browser state. A self-hosted product should make those distinctions visible and offer separate pause, archive, delete, and credential-revoke actions. [Bot management](https://docs.x.ai/grok-bot/bots).

### Collaboration and attention

Grok Bot supports asynchronous bot-to-bot messages, groups of two to six bots, user steering while work is in progress, and visible handoffs. The conversation includes activity, files, questions, and approval requests. Group handoffs have attachment limitations in the current docs. [Messaging and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration).

**Design implication:** reproduce the task ownership and handoff semantics before copying the group-chat appearance. Each delegated job needs an owner, deadline, deliverable, and acknowledgement. A shared chat log alone cannot prevent duplicate work or endless bot exchanges. Direct user steering should outrank queued routine work, while cancellation must state that completed side effects remain.

### Skills, routines, and demonstrations

Skills capture methods; routines specify when an owning bot runs them. Grok Bot can draft a skill from a browser demonstration, currently up to ten minutes without microphone recording. Event integrations are distinct from ordinary connector installation. Documentation lists up to 50 routines per bot and the 20 latest records per routine; these are product limits, not proposed limits for this project. [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).

**Design implication:** learned skills are drafts requiring a trial. Prefer semantic steps and assertions over brittle coordinate recordings. Pin the skill version in a routine, record timezone and catch-up behavior, and make edits observable. One successful demonstration does not establish reliable unattended execution.

### Access, models, approvals, and hosting constraints

Current plan documentation includes paid individual Cursor plans and self-serve Teams, with Enterprise enablement handled separately. Linked SuperGrok/X grants do not stack with Cursor grants. Weekly included usage and Cursor-billed on-demand spending are distinct; a monthly limit is not necessarily an immediate mid-run stop. Treat current billing docs as more specific than the launch announcement. [Plans and billing](https://cursor.com/help/grok-bot/plans).

Cursor documents hosted-only Grok Bot computers, no customer model picker, and backend-held connector tokens. Enterprise adds network controls, enforced Auto Review, and audit/export controls; self-serve Teams do not expose the same controls. Auto Review is model-based. Browser access and connector access are separate paths, so disabling one does not disable the other. [Cursor security](https://cursor.com/docs/grok-bot/security), [Teams and Enterprise](https://cursor.com/docs/grok-bot/teams).

Approvals show the proposed action. Human takeover handles login and verification. Bot-level separation does not isolate shared credentials, and deletion does not automatically revoke service access. These semantics should inform our design, but our enforcement must live in code and the execution environment, not only in prompts. [Approvals and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy).

Documentation discrepancies remain: SpaceXAI's September 16 page describes account-synced personal review rules, while Cursor's security page describes desktop-specific rules; mobile platform lists also differ. We should not infer undocumented backend details or guarantee exact Grok Bot parity from either page. This research did not test its UI or private infrastructure.

## Cloudflare and alternative computers

Cloudflare Sandbox runs Linux workloads on Containers with process, file, terminal, and network APIs. Workers alone are not the native CLI's operating system. The current stable SDK is 0.12.9; Cloudflare recommends the 1.0 preview for new projects, with different process semantics. Pin a matched SDK/image release and keep its APIs behind the computer adapter. [Sandbox](https://developers.cloudflare.com/sandbox/), [1.0 preview](https://developers.cloudflare.com/sandbox/1-0-preview/).

An inspected `@cloudflare/sandbox@0.12.9/opencode` declaration imports `@opencode-ai/sdk/v2` and uses legacy configuration examples. It is not evidence of support for the new `@opencode/client` contract. Use explicit V2 process startup and a transport adapter until compatibility is demonstrated. The declaration is retained as local evidence.

| Computer backend | Verified foundation | Design assessment |
|---|---|---|
| Cloudflare Sandbox | Linux containers, processes, files, PTY, outbound controls, R2 backup | Initial backend; full desktop stack is our integration work |
| Cloudflare Browser Run | Managed browser, CDP/Playwright, live view and human intervention | Optional browser backend, not a replacement for shell/files |
| Boat / ASCII | Persistent Ubuntu VM, SSH, Docker, desktop, snapshot/fork | Strong second backend for desktop-heavy work |
| Daytona | Sandbox APIs, GUI input, screenshots, accessibility and VNC | Strong second backend with existing computer-use primitives |
| Own machine | Existing OS, tools, user network | Outbound runner, dedicated workspace/account preferred |
| Generic VM | Provider-specific Linux host | Same runner and image; persistence/egress capabilities declared |

`box.ascii.dev` redirects to `boat.dev`: treat them as one provider. Boat documents EU regions and a $20 account minimum, with stop/resume preserving disk state but requiring hand-run processes to restart. Daytona documents Linux and Windows computer use, with macOS referred to a separate service. These are vendor claims, not a benchmark. [Boat](https://boat.dev/), [Daytona](https://www.daytona.io/docs/en/computer-use/).

Browser Run now supports live human interaction; it would be incorrect to characterize it as screenshot-only. Its sessions can last while active, but inactivity and platform rollouts can close them. Saved browser authentication is a separate durability problem. [Browser limits](https://developers.cloudflare.com/browser-run/limits/), [Live View](https://developers.cloudflare.com/browser-run/features/live-view/), [human intervention](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/).

Cloudflare directory backups restore an overlay in production and require explicit stored handles; default expiry and local/production differences matter. They are not durable POSIX disks. Outbound policies can deny destinations and inject credentials from trusted Worker code. These features make the design feasible, but their combined behavior with Chromium, SQLite, and long agent runs needs a deployed spike. [Backups](https://developers.cloudflare.com/sandbox/guides/backup-restore/), [outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/).

## Research conclusion

The components exist to build this. OpenCode supplies the agent runtime and provider ecosystem. Cloudflare supplies the hosting primitives. The missing product is durable identity, coordination, computer recovery, controlled integrations, and an understandable user interface.

The highest-risk assumptions are browser/session recovery, release-specific V2 contracts, tool-policy bypass through unrestricted shell/browser access, and interruption/retry behavior around external mutations. Test those before investing in a broad marketplace or polished native clients.
