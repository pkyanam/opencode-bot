# Getting started

This guide covers the supported preview paths: a local Worker/Sandbox preview,
an agent-assisted Cloudflare deployment, and Telegram setup. For the detailed
deployment contract and cost model, see [Cloudflare setup](03-cloudflare-setup.md).

## One-command Cloudflare install

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/opencode-bot/main/install.sh | bash
```

Before running it, have Bash, `curl`, internet access, and Git available on
macOS or Linux; use WSL2 on Windows. Homebrew is the only Git installation the
installer performs automatically. Node.js 24+ and npm are optional because a
missing or older Node runtime is installed in the user-local runtime directory.
The pinned Wrangler package is installed by project `npm ci`; no global
Cloudflare CLI is replaced.

The installer downloads a release manifest and checks out its exact Git commit.
Schema 2 manifests pin the computer image by Docker Hub digest; Cloudflare
pulls that public image directly during deployment. The installer
uses `~/.local/share/opencode-bot` and installs Node 24 locally if
needed, leaving the system Node installation alone. An existing Homebrew can supply missing Git. On other systems, install Git
through the OS package manager when prompted. Windows users should run inside
WSL2. Installation does not need Docker, a local image build, a local image
download, or Docker Hub credentials. Docker Hub credentials are CI maintainer
secrets only.

It selects a sole Cloudflare account automatically; with several accounts it
asks which to use. For unattended setup, supply `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` through your agent's secret environment. A recorded
account cannot silently switch on a later run.

If Wrangler is not authenticated, the installer starts its browser login flow.
Because the command is piped through Bash, interactive login and ambiguous
account selection require `/dev/tty`; a noninteractive run should provide
`CLOUDFLARE_ACCOUNT_ID` and an existing Wrangler/API-token login. The Cloudflare
account must already have Workers Paid, Containers access, and R2 enabled.
Account creation, login consent, billing activation, and terms acceptance remain
manual steps.

The installer does not enable paid services or accept account terms. If R2
reports error `10042`, enable it in the Cloudflare dashboard and rerun the same
command. Workers Paid/Containers eligibility and initial workers.dev account
onboarding must also be available. A stopped install retains its deployment
journal for retry.

After deployment, `.opencode-bot/open.html` opens the app with its owner token
in a URL fragment; the app consumes and removes that fragment. The file and
`.opencode-bot/secrets.json` are private files—do not share them. If your terminal
cannot open a browser, open `open.html` yourself. The printed app URL contains
no token.

The first cloud computer can take a few minutes to boot. After it is ready, the
browser workspace exposes it and work continues while the browser is closed.

To choose a different checkout, download the script and set `OCBOT_INSTALL_DIR`
when invoking Bash. Existing dirty or unrelated checkouts are never overwritten.
Resource names live in `infra/deployment.json` and `wrangler.jsonc`; change both
before a manual setup apply if you need a separate deployment.

## Updates from Settings

Open **Settings → Updates** to check the installed release. Enable update access
once using a Cloudflare API token for the hosting account with Workers Scripts
Write and Containers Write permissions. The account and Worker name are filled
from your installation. This deployment token stays in the control server's
private storage; it is never supplied to bots or returned to the browser.
The owner token that signs you into the app is a separate credential.

When a newer compatible release is available, finish active tasks and click
**Update**. The app verifies the release bundle, saves and verifies an R2
checkpoint, updates Worker code and web assets, rolls out the pinned computer
image, restores its checkpoint, and checks readiness. Cloudflare performs a
deployment behind the scenes; no terminal or local Docker is needed. Reload
when Settings reports completion.

If an update pauses after activation, the app keeps its checkpoint and prevents
new work. Settings shows the failed step and a **Resume update** action. Correct
expired deployment access if needed, then resume. It does not claim an automatic
rollback or discard the checkpoint. Releases requiring a new infrastructure
binding or migration may require the documented manual setup path.

## Local preview

Use Node.js **24 or newer**, npm, and Docker Desktop (or another reachable
Docker daemon). From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Start the backend and frontend in separate terminals:

```sh
npm run preview:worker -- --var APP_TOKEN:local-preview-token --var RUNNER_TOKEN:local-runner-token
npm run dev
```

Open <http://localhost:5173> and enter `local-preview-token` under Settings →
Connection. The Worker listens on port **8789**. The first computer request
starts a local Sandbox container; Docker builds target Linux amd64, including on
Apple Silicon.

For real inference, copy `.dev.vars.example` to the gitignored `.dev.vars` and
add a supported provider key. Model IDs use `provider/model`. The project does
not modify a global OpenCode installation or copy global OpenCode credentials.

The stable preview snapshots the backend and assets while Vite keeps frontend
hot reloads. Restart `preview:worker` after backend changes. On a planned stop,
the wrapper checkpoints an authenticated idle computer and writes a restart
marker. It restores only when the marker and committed checkpoint agree;
uncertain cases require manual recovery.

## Cloudflare deployment

For a normal installation, use the release installer above. Its generated
`.opencode-bot/wrangler.deploy.json` refers to the pinned Docker Hub image. The tracked
`wrangler.jsonc` keeps the Dockerfile for local development only.

The checked-in setup program is conservative. `doctor` and `plan` are
read-only; only an explicit apply mutates cloud resources:

```sh
./setup.sh doctor
./setup.sh plan > deployment-plan.json
npm exec wrangler login
./setup.sh apply --apply --install-missing
```

Manual apply requires the matching `.opencode-bot/release-manifest.json` created
by the installer. It never falls back to a local Docker build.

`--install-missing` permits supported local dependency installation. It does
not purchase a Cloudflare plan, enable billing, accept account terms, or modify
unrelated resources. The account must already be eligible for Workers Paid,
Containers, and R2. Keep names in `infra/deployment.json` and
`wrangler.jsonc` aligned.

The deployment journal lives at `.opencode-bot/deployment-state.json` and
contains ownership metadata and token fingerprints, never token values. If an
apply stops part way through, fix the reported prerequisite and rerun it; do not
delete resources to make a retry appear clean. The setup flow is designed to
resume and protect pre-existing resources.

An agent can perform routine setup and deployment after your request. Human
action may be needed for interactive login, ambiguous account selection, billing
activation, or credentials that are not already available. The default deployment
uses workers.dev and does not require DNS changes.

The application token protects API and computer access on the default
workers.dev deployment. Cloudflare Access on a custom domain is an optional
additional layer; it is not automatically configured by the installer.

## Providers and secrets

Settings → OpenCode → Provider connections supports native key connections,
OAuth start/status/complete or cancel flows, credential labels and activation,
removal, and custom OpenAI-compatible endpoints. Provider keys are submitted
only for the connection operation and are not returned in catalog/status
responses, browser state, or error messages.

Deployment keys supplied through `OPENAI_API_KEY`, `XAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, or `OPENCODE_API_KEY` are uploaded as
Worker secrets. Keep local bundles mode 0600 and never pass provider keys as
Docker build arguments. See [operations](05-operations.md) for the secret
bundle and upgrade rules.

## Telegram

Open **Settings → Telegram**, select the OpenCode bot, and create a Telegram
bot with [BotFather](https://t.me/BotFather). Paste its token and connect. Local
installations use outbound polling by default, so they do not need a public URL,
tunnel, or port forwarding. Cloudflare installations can use webhooks over the
deployed HTTPS URL.

Select **Link my Telegram account**, scan the expiring QR or open its link, and
press Start. The QR links a Telegram chat to the workspace; it is not an account
login QR. Only paired chat/user combinations are accepted. Text delivery works
in this preview; voice/files and inline approval buttons remain extensions.

## Owned computers and recovery

An owned macOS, Linux, or Windows computer can be paired through the outbound
node agent. This is a development path, not the default provider and not a
native desktop app:

```sh
npm ci --prefix runner
node scripts/node-agent.mjs register --control-url https://YOUR-WORKER.example --pairing-token PAIRING_TOKEN --name "My computer"
node scripts/node-agent.mjs start
```

Registration creates a private node secret and local runner token in the
platform config directory. Remote terminal/desktop access is not currently
available for owned nodes; completed runs reconcile through durable receipts.

Sandbox working disk is ephemeral. While idle, use **Computer → Checkpoint** to
preserve workspace, runtime state, and browser profile. Only committed archives
can be restored, and the initial buffered checkpoint limit is **32 MiB
compressed**. Interrupted or ambiguous runs become `needs_review` rather than
being replayed automatically.

## Before a paid deployment

Cloudflare hosting, model inference, storage, logs, browser services, and egress
can each contribute to cost. The estimates in [Cloudflare setup](03-cloudflare-setup.md)
are scenarios, not quotes. Measure an idle, interactive, and overnight workload
with the models and features you intend to use, then set per-run and owner
budgets. A local test or qualification result does not establish production
readiness or guarantee a provider model is available on your account.

## Upgrading early previews

If you installed v0.1.5 or earlier, save a Computer checkpoint while idle and
rerun the README install command once. Those early updater builds omitted the
installation-specific container link from Worker uploads; v0.1.6 repairs the
bundle and upload path. Keep the existing installation directory and project
name to preserve the deployment's identity. If the Computer asks for recovery
after replacement, restore the saved checkpoint in **Computer & checkpoints**.
Subsequent updates can use **Settings → Updates** after deployment access is set.
