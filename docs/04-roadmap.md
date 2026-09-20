# Implementation roadmap and release gates

Build a narrow end-to-end product before broadening integrations. The plan assumes the Cloudflare/CLI architecture in the design document. These are proposed milestones, not completed implementation work or calendar commitments.

## Milestone 0 — qualify the foundations

Produce a small deployed compatibility harness, a locked release manifest, and a decision record. Resolve these questions before polishing the UI:

| Spike | Pass condition | Failure response |
|---|---|---|
| V2 server/client | 2.0.11 create/prompt/observe/interrupt/approve works against its own schema | Pin a working release or fix adapter; never silently switch to V1 |
| Authentication | Service discovery yields usable auth; unauthenticated access rejected | Fix supervisor/auth integration before exposure |
| Cloudflare image | CLI, Chromium, Python, Git, terminal, desktop all start in selected instance size | Reduce image or increase size within verified limits |
| Checkpoint/restore | SQLite session and browser profile reopen after computer replacement | Change snapshot strategy; disclose re-login requirement if unavoidable |
| Backup after long idle | Last-known-good state restores beyond default SDK backup TTL | Application-owned archive or explicit supported expiry management |
| Egress | Required traffic succeeds; forbidden HTTP, raw socket and alternate paths fail | Do not claim confinement for that profile |
| Event recovery | Disconnect/restart produces reconciled transcript without duplicate work | Persist richer relay receipts or restrict support to qualified log API |
| Action interruption | Crash after simulated send becomes `unknown`, not automatic resend | Fix action ledger and reconciliation |
| Workerd SDK | Bundles and runs a tool loop in DO, survives eviction, uses remote tool | Keep optional until parity tests pass |
| Deployment | New account prerequisites and partial retry paths are exercised | Improve setup before calling it one-command |

The CLI-first design remains the default unless the Workerd spike demonstrates equivalent tool semantics and a meaningfully simpler operating model. Both paths use the same product contracts.

## Milestone 1 — one bot, one durable computer

Deliver authenticated web chat, bot creation, model selection, file upload/download, background work, a run timeline, terminal/desktop access, stop, approvals, and checkpoint recovery. Add the setup script and status/doctor commands.

Use one starter bot that can inspect a sample repository, make a small change, run validation, and return artifacts. A second sample performs a browser-only task against a controlled test site. Neither needs private third-party accounts.

Acceptance:

- Closing the browser does not cancel the job.
- Repeated message submission creates one task.
- A disconnected event stream reconnects without losing the final result.
- A container restart restores the last committed files and mapped session.
- A user takeover stops automated input until control is returned.
- An approval applies only to the displayed operation and cannot be replayed.
- Unauthenticated terminal, desktop, API, file, and preview access fail.
- A bounded model run reports usage, and exhausted budgets prevent new admission.

## Milestone 2 — persistent roles and useful integrations

Add curated memory, inspect/edit/delete memory, skill bundles, scheduled routines, timezone handling, run history, in-app/web-push notifications, and one GitHub connector. Keep mutations behind configured grants and exact-action approvals.

Demonstration workflow: a Research bot gathers public sources, writes a linked memo, and saves a reusable skill. A routine reruns it on schedule and reports only meaningful differences. A coding bot opens a draft PR only when that action is authorized.

Acceptance includes duplicate alarms, daylight-saving transitions, missed-run coalescing, overlapping schedule suppression, revoked OAuth tokens, expired credentials, and stale source data. A memory correction must affect the next run; deleting memory must remove it from retrieval and queued context packets.

## Milestone 3 — multiple bots and collaboration

Add asynchronous mailboxes, task ownership transfer, group conversation views, bounded delegation, shared artifacts, per-project write locks/worktrees, and workspace-wide usage accounting.

Demonstration: Researcher sends a source packet to Writer; Reviewer checks the result; one owner produces the final response. Bots can reason concurrently but serialize use of the initial shared GUI.

Acceptance: duplicate handoff delivery, sender crash, recipient offline, competing ownership claims, delegation loops, exhausted shared budget, cancellation cascading, and simultaneous edits to one file. A subordinate task cannot acquire stronger credentials or override the parent/workspace policy.

## Milestone 4 — portable computers and hardened execution

The first owned-node slice now includes outbound registration, heartbeat,
revocation, bot/thread affinity, explicit runner jobs, cancellation and
approval forwarding, and durable completion receipts. Complete the owned-node
transport and recovery qualification, then add one alternative provider
adapter, preferably Boat or Daytona based on hands-on evaluation. Introduce a
split topology for workflows requiring strong confinement: credential-free
code execution, separately controlled authenticated browser, and trusted
connector/model brokers.

Acceptance: provider replacement does not change bot identity; unplugged laptops produce an honest waiting state; revoked runners cannot reconnect; old-generation messages cannot mutate new-generation state; encrypted snapshots restore only with the correct key; no local home directory is mounted by default.

A fully local control plane and multi-user SaaS deployment are separate release tracks. Do not infer SaaS readiness from a single-owner self-hosted deployment.

## Milestone 5 — convenience and cost optimization

Qualify the Workerd runtime as a selectable mode, add Browser Run as a managed browser backend, teach-by-demonstration, more connectors, and optional semantic memory search. Optimize only with measurements: real tasks completed, cost per successful task, recovery rate, and human-intervention frequency.

## Proposed repository layout

```text
apps/web/                         responsive UI
apps/control-worker/              authenticated API and assets
apps/broker-worker/               model/connectors/internal runner routes
packages/domain/                  tasks, runs, grants, events, policies
packages/coordinator-cloudflare/  Workspace DO and scheduler
packages/runtime-opencode2/       published V2 client adapter
packages/runtime-workerd/         optional embedded SDK adapter
packages/computer-cloudflare/     Sandbox lifecycle and transport
packages/computer-local/          outbound runner transport
packages/computer-boat/           optional provider
packages/computer-daytona/        optional provider
packages/browser/                 common browser/control contract
packages/connectors/              API/OAuth/MCP integrations
packages/storage-cloudflare/      R2 and D1 projection adapters
packages/opencode-plugin/         trusted product tools and event hooks
runner/                           supervisor, browser/desktop broker
images/computer/                  Dockerfile and immutable tool manifests
infra/                            Wrangler config templates and migrations
scripts/setup/                    doctor, plan, apply, journal, teardown
tests/contracts/                  release and provider conformance
tests/scenarios/                  restart/replay/approval end-to-end tests
```

## Key decision records to retain

1. CLI runtime first; embedded Workerd runtime supported by a separate adapter.
2. Workspace DO owns coordination; D1 is a rebuildable projection.
3. One shared trust domain per initial computer; no false per-bot isolation claim.
4. Working disk is disposable; committed checkpoints define durability.
5. Native session streaming is not the application event journal.
6. Action receipts and reconciliation precede retry of ambiguous external writes.
7. Cloudflare infrastructure does not imply Cloudflare-only model inference.
8. Exact release/image pairs and restore tests are deployment prerequisites.
9. Browser automation and connector authorization are separate access paths.
10. Setup repairs missing prerequisites only within explicit installation scope.

## Definition of a usable first release

An owner can deploy from a clean supported laptop, create a bot, connect a qualified model, assign work, close the laptop, return to an evidence-backed result, approve a concrete operation, recover from a destroyed computer, and understand the cost and durability limits. They can export their data and stop compute without depending on the application's developer.

The first implementation task should be Milestone 0's deployed compatibility harness, followed immediately by one durable bot end to end. The design should be revised from those measured results before a marketplace or large integration catalog is built.
