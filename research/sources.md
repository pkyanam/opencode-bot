# Source register

Access date: **2026-09-20**. Primary product docs, official registries, and upstream source were used for technical conclusions. Search results from social media, third-party forks, and marketing comparisons were not used to establish implementation contracts.

## OpenCode 2

| Source | What it establishes |
|---|---|
| [V2 introduction](https://opencode.ai/v2/docs/) | Official distribution, platform choices, versioned Docker images |
| [Download](https://opencode.ai/download) | Current V2 installation commands |
| [V1 migration](https://opencode.ai/v2/docs/migrate-v1) | API/plugin breaks, configuration normalization, missing LSP runtime |
| [Build overview](https://opencode.ai/v2/docs/build/) | Extension, server, and embedding routes |
| [V2 client](https://opencode.ai/v2/docs/build/client/) | `@opencode/client`, service discovery, live-only stream semantics |
| [Embedded SDK](https://opencode.ai/v2/docs/build/sdk/) | In-process host and owned lifecycle |
| [Workerd SDK](https://opencode.ai/v2/docs/build/sdk/cloudflare/) | Durable Object SQLite profile and replaced local services |
| [API reference](https://opencode.ai/v2/docs/api) | Current published routes and experimental status |
| [Plugins](https://opencode.ai/v2/docs/build/plugins/) | V2 plugin context, tool hooks, permissions, provider customization |
| [Agents](https://opencode.ai/v2/docs/agents/) | Profiles, subagents, model and permission behavior |
| [Models](https://opencode.ai/v2/docs/models/) | Selection, capabilities, variants, local discovery |
| [Providers](https://opencode.ai/v2/docs/providers/) | Custom endpoints and protocol-specific packages |
| [Permissions](https://opencode.ai/v2/docs/permissions/) | Ordered rules and native action names |
| [Instructions](https://opencode.ai/v2/docs/instructions/) | AGENTS.md discovery |
| [Skills](https://opencode.ai/v2/docs/skills/) | Reusable skill bundles |
| [Tools](https://opencode.ai/v2/docs/tools/) | Built-in execution capabilities |
| [MCP](https://opencode.ai/v2/docs/mcp-servers/) | External tool server configuration |
| [Compaction](https://opencode.ai/v2/docs/compaction/) | Checkpoints, stored history, provider compatibility |
| [Snapshots](https://opencode.ai/v2/docs/snapshots/) | Source-level snapshot functionality |
| [Zen](https://opencode.ai/docs/zen/) | Optional curated model gateway and multiple protocols |
| [CLI registry](https://registry.npmjs.org/@opencode/cli/2.0.11) | Version, binary aliases, platform packages, integrity |
| [Client registry](https://registry.npmjs.org/@opencode/client/2.0.11) | Published client exports and version |
| [SDK registry](https://registry.npmjs.org/@opencode/sdk/2.0.11) | Workerd export in a published package |
| [Plugin registry](https://registry.npmjs.org/@opencode/plugin/2.0.11) | Published V2 plugin package |

Local CLI observations are retained in `evidence/local-opencode2-*.txt`. Only version/help commands were executed; no user model credentials, conversations, or private configuration were inspected. The user's OpenCode installation was not upgraded.

`evidence/source-manifest.json` records upstream repository URLs pinned to commit `d870e22c70f27103016dcd479edcfebf86136d93`. That development snapshot differs from current release documentation and is not used as an unqualified 2.0.11 contract. Published npm declaration files are separately identified by their filenames and corresponding registry metadata. Tarball bytes were checked against recorded SHA-512 integrity before extraction.

## Grok Bot

| Source | What it establishes |
|---|---|
| [SpaceXAI launch](https://x.ai/news/introducing-grok-bot) | August 11 launch and product motivation |
| [SpaceXAI overview](https://docs.x.ai/grok-bot/overview) | Persistent bots and shared computer model |
| [Cursor overview](https://cursor.com/docs/grok-bot) | Same product in Cursor's account/hosting ecosystem |
| [Bot management](https://docs.x.ai/grok-bot/bots) | Role lifecycle, duplicate/share/delete semantics |
| [Collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration) | Groups, asynchronous handoffs, user steering |
| [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) | Shared sessions/files, screens, human takeover, recovery |
| [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) | Demonstrations, schedules, triggers, operational limits |
| [Approvals and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy) | Review rules, credentials, local machine policy |
| [Cursor security](https://cursor.com/docs/grok-bot/security) | Hosting limits, model selection, connector token handling |
| [Teams and Enterprise](https://cursor.com/docs/grok-bot/teams) | Administrative rollout and plan-dependent controls |
| [Plans and billing](https://cursor.com/help/grok-bot/plans) | Weekly/on-demand usage, grants, non-stacking subscriptions |

The product was not tested through a signed-in account. No claim is made about its unpublished prompts, exact orchestration engine, VM provider, model mix, or internal code. Where docs conflict, the research document identifies the discrepancy instead of selecting an unsupported interpretation.

## Cloudflare

| Source | What it establishes |
|---|---|
| [Sandbox overview](https://developers.cloudflare.com/sandbox/) | Linux sandbox and container foundation |
| [Sandbox 1.0 preview](https://developers.cloudflare.com/sandbox/1-0-preview/) | Recommended new-project line and changed APIs |
| [Sandbox registry](https://registry.npmjs.org/@cloudflare/sandbox/0.12.9) | Stable package and OpenCode helper exports |
| [Backup/restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/) | Directory backup handles, expiry, production overlay |
| [Outbound controls](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/) | Filtering and trusted credential injection |
| [Sandbox limits](https://developers.cloudflare.com/sandbox/platform/limits/) | Dependency on Containers/Workers platform constraints |
| [Container limits](https://developers.cloudflare.com/containers/platform/limits/) | Instance sizing and platform limits |
| [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/) | CPU, memory, disk, egress and service billing |
| [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/) | Session inactivity and rollout behavior |
| [Live View](https://developers.cloudflare.com/browser-run/features/live-view/) | Human viewing/control and credential-bearing URLs |
| [Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/) | Managed browser intervention capability |
| [Queue delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) | At-least-once delivery |
| [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) | One alarm per object, retries, scheduler design |
| [Workflows sleep/retry](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) | Optional durable business-workflow primitive |
| [Workers AI compatible API](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/) | Possible strict-Cloudflare inference adapter |
| [Worker static assets](https://developers.cloudflare.com/workers/static-assets/) | App hosting capability |
| [Access HTTP apps](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/) | Authentication entrypoint foundation |

Some direct Markdown URLs returned HTTP 403; those failures remain recorded in the evidence manifest. The corresponding successful browser-retrieved documentation, not failed downloads, supports the findings. No Cloudflare account deployment or billing test was performed.

The stable Sandbox OpenCode helper declaration was retrieved from its integrity-checked npm package. Its `@opencode-ai/sdk/v2` import is the specific evidence for the compatibility warning; this is not a claim that every future Cloudflare helper version is incompatible.

## Alternative computers

| Source | What it establishes |
|---|---|
| [ASCII box](https://box.ascii.dev/) | Redirect to Boat |
| [Boat](https://boat.dev/) | VM/desktop/SSH/snapshots, regions, advertised billing |
| [Daytona computer use](https://www.daytona.io/docs/en/computer-use/) | GUI, accessibility, screenshots, VNC and platform support |

No provider benchmark, capacity purchase, machine creation, or independent reliability comparison was performed. The architecture treats these as candidate implementations of a common computer contract.

## Remaining validation work

- Execute the pinned V2 release against its published client and schema.
- Verify Cloudflare Sandbox preview/stable choice with the complete image.
- Measure desktop usability, browser login durability, checkpoint/recovery time, and actual costs.
- Validate Workerd tool replacement and crash/replay behavior.
- Test provider credential/protocol behavior, selected model tools/vision, and cancellation.
- Implement and test installer prerequisites, partial-failure recovery, identity protection, and export.

These are explicit implementation gates in the roadmap. They do not prevent selecting the architecture, but they prevent claiming production readiness.
