# Cloudflare setup and operations design

This is the installer and operating contract. The repository currently ships
`setup.sh` and the Node entrypoint at `scripts/setup.mjs`; `doctor`, `plan`, and
the explicit `apply` flow are implemented. The broader `botctl status`, backup,
restore, upgrade, and destroy commands below remain proposed follow-up
interfaces. No Cloudflare resources have been created by this checkout.

## First-deployment experience

The finished project should support:

```sh
./setup.sh
```

The script runs a checked-in, versioned setup program. Its current default is a
read-only prerequisite check; `plan` prints the deployment contract and only
`apply --apply` performs mutations. Interactive collection of target account,
owner identity/domain, inference profile, and credentials remains a future
installer improvement. Rerunning an apply is designed to reconcile the existing
installation.

The current explicit automation path is:

```sh
./setup.sh doctor
./setup.sh plan > deployment-plan.json
./setup.sh apply --apply --install-missing
```

The following command names are proposed follow-up operations, not currently
shipped subcommands:

```sh
botctl doctor
botctl status
botctl backup
botctl restore --checkpoint CHECKPOINT_ID
botctl upgrade --version VERSION
botctl destroy --keep-data
```

`--apply` authorizes the declared cloud deployment. `--install-missing` authorizes supported local prerequisite installation. Never interpret either as permission to purchase a plan, accept account terms, or change unrelated account infrastructure.

## Prerequisites and automatic checks

| Requirement | Check | Installer behavior |
|---|---|---|
| macOS or Linux; Windows through supported WSL path initially | OS/architecture detection | Clear supported-path message |
| Supported Node LTS and package manager | Version against our release manifest | Install a pinned user-local runtime when authorized; leave system Node intact |
| Git | Binary/version check | Use existing package manager or explain missing manual step |
| Container build engine | Daemon reachable; Linux target build available | Offer Docker/compatible setup; detect unavailable daemon separately from missing CLI |
| Cloudflare CLI | Pinned local Wrangler package | Project-local install, no global overwrite |
| Cloudflare identity | OAuth login or scoped API token; inspect permitted account | Explicit account selection if ambiguous |
| Workers Paid and Containers eligibility | Read account capabilities and perform minimal deployment probe during apply | Explain required account action if not available |
| R2, D1, Queues, Durable Objects | API access and provisioning checks | Create only missing project-owned resources |
| Domain and application identity | DNS control + Access application/owner allowlist | Provision owner-only Access; refuse open access on failure |
| Model access | Required secret present and endpoint/model capability checks | Secure prompt; optional bounded inference smoke test |

Do not require OpenCode on the laptop for a Cloudflare deployment: it is installed in the computer image. The existing local 2.0.3 installation should remain untouched. Setup never copies its private credentials implicitly.

A custom domain on Cloudflare is the recommended initial prerequisite for Access and a stable origin. Do not assume a generic `workers.dev` endpoint automatically inherits Access protection. A no-domain profile needs separately tested application authentication and should ship only after that flow is implemented. Disable or protect every alternate hostname and preview route.

Account sign-up, billing enablement, ownership verification, OAuth consent, and OS privilege prompts cannot honestly be made zero-touch. The script should stop at the exact missing step, retain its journal, and continue on rerun.

## Resource plan

Use a configurable prefix such as `ocbot-personal`. Resource identity belongs in a deployment state file with Cloudflare account and environment; never adopt an arbitrary same-name resource without checking ownership.

| Resource | Initial purpose |
|---|---|
| App Worker with static assets | UI, authenticated API, websocket routing |
| Dispatch/broker Worker entrypoints | Queue consumer, connectors, model proxy, internal runner routes |
| Workspace DO class | Authoritative workspace state and alarms |
| Sandbox DO class + container image | Computer lifecycle and process access |
| D1 database | Searchable derived views |
| R2 data bucket | Artifacts, archives, computer checkpoints |
| Dispatch queue + dead-letter queue | Reliable wakeup and projection delivery |
| Cron trigger | Scheduler and stale-lease reconciliation |
| Access application and policy | Owner-only entrypoint |
| Worker secrets | Encryption key, model credentials, bootstrap/internal signing material |

Workers AI, Browser Run, AI Gateway, Vectorize, and Workflows are optional feature flags. Provision only the selected capabilities. Cloudflare-first means one hosting provider, not a requirement to activate every Cloudflare product.

Use narrow account-level deployment permissions for Workers, storage, containers, and relevant identity configuration. Zone/DNS permission is required only for the selected domain. Cloudflare permission group names and IDs can evolve; the installer resolves them from the current API rather than shipping an unchecked broad token template. Runtime code never receives the deployment token.

## Provisioning state machine

1. **Inspect:** collect tool versions, account capabilities, target domain, and existing installation state. No mutations.
2. **Plan:** calculate resource names, selected runtime versions, migration steps, and required secret names. Output a redacted machine-readable plan.
3. **Prepare:** fetch integrity-checked dependencies; build a Linux image with immutable version/digest labels. Keep credentials out of build arguments and image layers.
4. **Provision:** create storage, queue, DO migrations, Worker bindings, and the container application. Record each returned ID immediately.
5. **Initialize:** generate internal signing/encryption material, write secrets securely, and create owner identity records. Scope any bootstrap token, expire it, and disable it after use.
6. **Protect:** apply Access and application authorization. Verify that unauthenticated API, WebSocket, artifact, preview, desktop, and terminal requests fail.
7. **Deploy:** upload the matched Worker/image pair and apply database migrations. Use explicit compatibility dates and locked package versions.
8. **Verify:** create a temporary computer, run readiness checks, create/read a file, checkpoint, restart, restore, and verify its checksum. Test model access only with bounded consented cost.
9. **Finish:** print the app URL, deployment manifest location, doctor command, backup result, and configured cost limits. Stop smoke-test compute.

Every stage is resumable. Failure leaves a readable record of resources created by this installation. Cleanup never deletes preexisting resources or durable data just to make a retry simpler. A dry run must not create even a smoke-test container.

## Release and configuration pinning

Candidate OpenCode release set: **2.0.11**, observed in the official registry during research. This is a candidate for qualification, not a declaration that all workflows passed. Use a release manifest containing:

```json
{
  "schemaVersion": 1,
  "runtime": "opencode2-server",
  "opencodeVersion": "2.0.11",
  "clientVersion": "2.0.11",
  "computerProvider": "cloudflare-sandbox",
  "sandboxReleaseLine": "1.0-preview-or-qualified-stable",
  "sandboxVersion": "RESOLVED_BY_RELEASE_QUALIFICATION",
  "imageDigest": "RECORDED_AFTER_BUILD",
  "apiContractHash": "RECORDED_FROM_QUALIFIED_SERVER"
}
```

The unresolved fields are intentionally not executable deployment values. During implementation, choose one exact Sandbox release line. Cloudflare recommends the 1.0 preview for new projects; qualify it first. If required persistence/egress functions fail qualification, use stable 0.12.9 with its matching image and a documented migration plan. Do not mix preview argv/process APIs with stable `exec(string)` semantics. [Preview guidance](https://developers.cloudflare.com/sandbox/1-0-preview/).

Store non-secret deployment settings separately from rendered OpenCode configuration. Suggested product settings:

```yaml
schemaVersion: 1
workspace:
  mode: single-owner
computer:
  provider: cloudflare-sandbox
  sharing: workspace
  instanceType: standard-2
  idleGraceMinutes: 10
  maxConcurrentRuns: 2
  maxGuiControllers: 1
runtime:
  provider: opencode2-server
  version: 2.0.11
models:
  profile: opencode-providers
  main: SELECT_FROM_QUALIFIED_CATALOG
  fallback: explicit-only
storage:
  keepLastKnownGood: true
  dailyCheckpointRetentionDays: 30
notifications:
  meaningfulChangesOnly: true
```

These are our proposed fields, not OpenCode's schema. Render native V2 agent/provider/MCP settings from them and validate against the chosen release. Require explicit provider/model selection rather than relying on an upstream fallback to the newest model.

The installer can provide two presets:

- **OpenCode models:** infrastructure on Cloudflare, user-selected providers or OpenCode gateway for inference. Recommended for initial full-computer capability.
- **Cloudflare-only inference:** compatible Workers AI endpoint with verified model IDs and tool/vision capabilities. No assertion that every OpenCode model is available here. [Workers AI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/).

## Cost model

Rates observed September 20, 2026: Workers Paid starts at $5/month. Containers charge additional memory at $0.0000025/GiB-second, actual CPU at $0.000020/vCPU-second, and provisioned disk at $0.00000007/GB-second. Included allowances and other service charges apply separately. [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).

The `standard-2` candidate has 1 vCPU capacity, 6 GiB RAM, and 12 GB disk. The estimates below assume **average actual CPU usage of 0.25 vCPU while awake**, no subtraction for included allowances, and exclude models, storage operations, Workers/DO duration, logs, and egress. They are compute scenarios, not quotes or measurements. [Instance types](https://developers.cloudflare.com/containers/platform/limits/).

| Scenario | Awake time/month | Container resource subtotal |
|---|---:|---:|
| Intermittent personal work | 60 hours | $4.50 |
| Frequent daily work | 240 hours | $18.01 |
| Continuously awake, 30-day month | 720 hours | $54.02 |

At the same assumptions, `standard-2` costs about $0.0750 per awake hour; even zero CPU activity still has about $0.0570/hour in provisioned memory/disk charges. A `standard-3` with average 0.5 active vCPU is about $0.1120/hour. Calculations used agentcalc; inputs are retained in the cost evidence file.

The complete bill is:

```text
Workers plan + Worker requests/CPU
+ Durable Object requests/duration/storage
+ Container CPU + awake memory/disk + applicable egress
+ R2 storage/operations + D1 + Queues
+ logs + optional Browser Run/AI Gateway services
+ model input/output/cache/tool usage
```

Do not assume scale-to-zero container compute makes an open event relay free. Long-lived DO activity/streams, desktop viewing, and browser keepalives can keep services billable. Measure at least one idle, one interactive, and one overnight workload before publishing a total monthly estimate.

Model cost is workload dependent. Record uncached input, cache reads/writes where billable, output, and provider tool charges against the price schedule used. Separate estimates from provider-reported usage and invoice reconciliation. Large screenshot histories and repeated long-context calls may dominate hosting costs.

Budgets reserve capacity before starting a run and before approved expensive operations. Apply per-run duration/token/action caps plus per-day/month owner budgets. Provider cancellation can leave in-flight charges; disclose a bounded overshoot allowance rather than promising an exact instantaneous financial cutoff. A stopped routine should not wake a computer merely to report that nothing changed.

## Operations and upgrades

`doctor` checks identity, upstream contract, selected model availability, image health, checkpoint age, storage readability, runner lease, queue/dead-letter depth, and notification delivery. Output contains redacted diagnostics; never print tokens, browser cookies, signed view URLs, or provider request bodies by default.

Upgrade sequence: pause admission, finish or explicitly interrupt active work, checkpoint all writers, stage new Worker/image/runtime, run compatibility and restore probes, migrate, then resume. Keep the prior image and pre-migration backup. Rollback restores the old database snapshot with the old binary; simply starting an older binary on a migrated database is not an adequate rollback plan.

Track metrics for cold start, restore time, run admission latency, browser reconnects, lost event gaps, approval duration, unknown actions, checkpoint age, model cost, and queue retries. Correlate logs by workspace, task, run, computer generation, and action ID. Capture sensitive screenshots only according to retention settings.

Backups include coordination state, encrypted secrets, skill bundles, artifact manifests, runtime state, and computer files. Wrapping/signing keys need a separate recoverable export; ciphertext without the key is not a backup. D1 projections can be rebuilt and need not be the recovery authority. Test full restore into a new deployment with outbound writes disabled until verification completes.

Destroy defaults to stopping compute and removing routing while retaining data. Purging retained buckets, keys, and backups is a separate explicit command. Revoking external OAuth grants is distinct from deleting local encrypted records, and cleanup should report any grant it could not revoke.
