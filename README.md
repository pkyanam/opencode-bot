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

Give your bots a name, a job, and a computer. Chat in the browser or Telegram,
watch them work, and let them ask each other for help. Powered by
[OpenCode 2](https://opencode.ai/v2/docs/), hosted on your own Cloudflare account.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/pkyanam/opencode-bot/main/install.sh | bash
```

The installer downloads the app, checks prerequisites, signs in to Cloudflare,
uploads the release’s prebuilt computer image to your account, creates the
Worker, database, Sandbox computer, and R2 bucket, then opens your workspace.
macOS and Linux are supported; on Windows, use WSL2. **Docker is not required
for installation.** You'll need a Cloudflare account with
Workers Paid, Containers access, and R2 enabled. Hosting and model usage are billed
by their providers. Account signup, billing activation, and login may need you.

The default checkout is `~/.local/share/opencode-bot`. Rerun the same command to
resume installation. Releases pin the app source and computer image together.
[Setup details and troubleshooting →](docs/getting-started.md)

### Or hand it to your agent

```text
Clone https://github.com/pkyanam/opencode-bot.git and set it up on my Cloudflare account. Read README.md and docs/getting-started.md, then run bash install.sh (or the documented setup apply flow from your checkout). Install missing prerequisites where possible, deploy the app, verify the authenticated API and computer, and open it connected in my browser. This authorizes the setup and deployment; handle routine steps yourself. Use existing credentials or ask only for login, account selection when ambiguous, billing activation, or secrets you cannot obtain. Keep tokens out of chat, logs, and Git. Report the URL and exactly what passed or remains blocked.
```

## A workspace that stays with you

- **Bots with their own identity.** Instructions, models, memory, and assigned
  skills carry into every new conversation. Rename or delete threads and bots.
- **See the work.** Markdown replies, live tool activity, approvals, and an
  expandable view of the browser your bots control.
- **Talk to the right bot.** Bots can ask peers for help and bring their replies
  back into your conversation.
- **OpenCode underneath.** Model and provider setup, API keys, native commands,
  and a built-in terminal. Browse skills and plugin resources under Skills.
- **Take it to Telegram.** Connect a BotFather bot, scan the pairing link, and
  receive formatted replies and progress. Local mode uses polling; Cloudflare
  uses HTTPS webhooks.
- **Bring another computer.** An outbound node agent can pair your Mac, Linux,
  or Windows machine. Cloudflare is the default computer.

## First public preview

This is a personal, single-owner app. Bots sharing a computer share its files,
browser, and credentials. Additional-node desktop streaming and deletion,
extension installation, and native desktop packaging are still in development.

Sandbox disk is ephemeral. Use **Computer → Checkpoint** while idle to preserve
it in R2; compressed checkpoints currently have a 32 MiB limit. Keep your owner
token private. See [operations](docs/05-operations.md) and [security](SECURITY.md).

## Develop

With Node.js 24+ and Docker running:

```bash
git clone https://github.com/pkyanam/opencode-bot.git
cd opencode-bot
npm ci
npm run build
npm run preview:worker -- --var APP_TOKEN:local-preview-token --var RUNNER_TOKEN:local-runner-token
# In another terminal, from the same directory:
npm run dev
```

Open [localhost:5173](http://localhost:5173), then use `local-preview-token` in
**Settings → Connection**. These example tokens are for local development only.
Run `npm run typecheck && npm test` to verify changes.

## Under the hood

React + shadcn/ui · Cloudflare Workers · SQLite Durable Objects · Sandbox · R2.

[Getting started](docs/getting-started.md) · [Architecture](docs/02-design.md) ·
[Research](docs/01-research.md) · [Skills & plugins](docs/10-extensions.md) ·
[Desktop plan](docs/06-desktop.md) · [Release pipeline](docs/releasing.md) · [Test evidence](tests/qualification/README.md)

[MIT licensed](LICENSE). Independent community project;
[acknowledgments and trademarks](NOTICE.md).
