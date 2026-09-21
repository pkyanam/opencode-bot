# Control Worker MCP endpoint

Connect an external agent to your bots, conversations, files, and Computer.
**Codex works today. ChatGPT’s custom-app connection needs OAuth support that
this server does not yet implement.**

## Codex desktop: fill in the connection form

Open Codex’s custom MCP connection form and enter:

| Field | What to enter |
| --- | --- |
| Name | `OpenCode Bot` |
| Type | **Streamable HTTP** |
| URL | Your app URL followed by `/api/mcp`, for example `https://YOUR-WORKER.workers.dev/api/mcp` |
| Bearer token env var | **Leave blank** for this setup |
| Headers → Key | `Authorization` |
| Headers → Value | `Bearer YOUR_APP_TOKEN` — replace `YOUR_APP_TOKEN` with your actual app token, keeping `Bearer` and the space |
| Headers from environment variables | **Leave blank** |

Click **Save**, then start a new conversation and ask:

> Use OpenCode Bot to list my bots. Do not create or change anything.

### Where do I get the token?

For your own Codex installation, the **application token** saved by the installer
works. This is the credential used to connect to your workspace. It is **not** the
Cloudflare “Deployment token” used by the updater, a node token, or a one-time
pairing code.

On the Mac where you ran the default installer, this command copies the complete
header value to your clipboard. Paste it directly into **Headers → Value**:

```bash
node -e 'const fs=require("node:fs");const os=require("node:os");const s=JSON.parse(fs.readFileSync(os.homedir()+"/.local/share/opencode-bot/.opencode-bot/secrets.json","utf8"));if(!s.APP_TOKEN)throw new Error("No application token found");process.stdout.write("Bearer "+s.APP_TOKEN)' | pbcopy
```

If you installed to a custom directory, adjust that path. The command reads your
local installer secrets; it does not contact Cloudflare or generate a new token.
Codex saves the static header in its configuration, so treat that configuration
as containing a credential. Do not paste the token into chat or commit it.

For an integration you want to revoke independently, use a paired device token
instead; see **Separate credentials for each agent** below. It goes in the same
header value: `Bearer DEVICE_TOKEN`.

### Optional: use an environment variable instead

**Bearer token env var takes a variable name, not a secret.** For example, enter
`OPENCODE_BOT_TOKEN` only if that variable is already available to the Codex
process. Its value must be the token alone, without `Bearer `. Leave the static
Authorization header blank when using this option.

For Codex CLI, set the variable in the terminal that launches Codex and add this
to `~/.codex/config.toml`:

```toml
[mcp_servers.opencode_bot]
url = "https://YOUR-WORKER.workers.dev/api/mcp"
bearer_token_env_var = "OPENCODE_BOT_TOKEN"
```

An `export` in a terminal does not automatically configure a desktop app launched
from the Dock. The static-header setup above avoids that extra environment setup.
See [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## ChatGPT: current limitation

ChatGPT’s developer-mode custom apps support OAuth, no authentication, and mixed
OAuth/no-auth. They do not provide the custom static Authorization-header field
shown in Codex. “Static credentials” in its OAuth setup means OAuth client
credentials, not an OpenCode Bot application token.

Our endpoint requires a bearer credential and does not yet provide an OAuth
sign-in flow, so **direct authenticated ChatGPT setup is not supported yet**.
Selecting “No Authentication” will fail. Do not put your token in the endpoint
URL or disable authentication to work around this. Use Codex or another MCP
client with bearer-header support for now.

Source: [ChatGPT developer mode](https://developers.openai.com/api/docs/guides/developer-mode).

## Troubleshooting

- **401 / unauthorized:** use the application token or a paired device token;
  check that the header value starts with `Bearer `, followed by the token.
- **Environment variable missing:** use the static-header setup or make the
  named variable available to the process that launches Codex.
- **404 / page HTML:** use `/api/mcp`, not the app’s root URL or a pairing link.
- **Tools missing:** save the connection and start a new conversation. Paired
  credentials intentionally have fewer tools than the owner credential.
- **Computer still starting:** the MCP catalog and workspace controls can connect
  before the Computer is ready. Computer-dependent tools still need it to boot.

## Separate credentials for each agent

Prefer a separate paired token for each agent:

1. Open **Settings → Devices → Pair a device** in the owner browser.
2. Give the agent that short-lived code and your workspace URL.
3. Exchange the code once with `POST /api/pairing/redeem`:

```json
{"code":"ONE-USE-CODE","deviceName":"My coding agent","clientType":"native"}
```

The response contains `deviceToken`. Store it in the client's secret store and
use it as the bearer token. Revoke it independently in **Settings → Devices**.
The owner token also works and exposes administrative tools; do not share it
when a paired token is sufficient.

Paired agents are trusted workspace clients: they can create bots, send and
cancel tasks, use files, and act through the shared computer. They cannot use
the provider, deployment, Telegram, node, or device administration endpoints.
This is not isolation for untrusted agents: bot tools share the computer's
files and credentials.

## Tools and attachments

Use `tools/list` to discover the current catalog for your credential. It covers
bots, conversations, native actions, runs and approvals, peer handoffs, memory,
routines, skills, files and uploads, computer readiness/checkpoints, extension
repositories/plugins, providers, Telegram, nodes, devices, and app updates.
Administrative tools are visible only to the owner.

`run_start` returns a durable run receipt. Poll `run_get`, `run_events`, and
`thread_messages` to follow it. Send another `run_start` to the same thread for
native mid-turn steering; use a fresh idempotency key for each intentional
message and reuse it when retrying that message.

`upload_file` accepts `name`, `mimeType`, and `contentBase64` (up to 10 MiB
decoded). Pass its returned ID in `run_start.attachments` as `[{"id":"att_…"}]`.
Eight files and 20 MiB total are allowed per message. `attachment_read` downloads
an upload; `file_read` reads a safe workspace artifact. Binary results use
`{contentBase64,mimeType}`. Larger artifact downloads use the authenticated HTTP
file API. A live desktop preview is a multipart JPEG HTTP stream, not an MCP
tool result; clients consume `/api/computer/preview` with the same credential.

All tools call the same authenticated control routes as the web UI, retaining
the original caller's bearer token. There is no elevated generic HTTP proxy.
Secrets, pairing codes, and returned credentials should stay out of chat logs,
telemetry, and committed configuration.

## Protocol behavior

The endpoint is POST-only and returns `application/json`. It supports:

- MCP `2026-07-28` stateless requests with `MCP-Protocol-Version`, `_meta`,
  `Mcp-Method`, and `Mcp-Name` validation, including the base64 sentinel form
  for non-ASCII `Mcp-Name` values.
- MCP `2025-11-25` and earlier-style `initialize` plus
  `notifications/initialized`, without server-side session state.
- `server/discover`, `tools/list`, `tools/call`, and `ping` compatibility.
- Legacy initialized notifications as HTTP 202 with no body; modern notifications are rejected.
- MCP tool errors as `result.isError: true`; protocol errors use JSON-RPC error
  responses and appropriate HTTP status codes.
- Unsupported versions return MCP `-32022`; mirrored modern header mismatches
  return `-32020`. Modern requests require protocol version, clientInfo, and
  clientCapabilities metadata.
- Origin validation (same-origin by default, or an explicit `allowOrigin`
  callback) and rejection of mutating `tools/call` notifications.

The latest MCP revision removed `initialize` and protocol sessions in favor of
per-request metadata. It also requires clients to advertise both
`application/json` and `text/event-stream` in `Accept`; this implementation
chooses a single JSON response and deliberately does not emit fake SSE. A
future streaming response can be added behind the same tool adapter without
changing route mappings.

The adapter is stateless and JSON-response only: it does not provide resumable
streams, server-sent events, subscriptions, or session state. Clients needing
live progress should poll `run_events`. Uploads and binary responses are each
bounded to 10 MiB.

References: [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
[MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
[MCP protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions),
and the [2026-07-28 release notes](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

## Security boundaries

- The catalog contains explicit CRUD and control operations; it has no generic
  URL, SQL, shell, or arbitrary proxy tool.
- `run_approve`, `run_cancel`, deletes, checkpoint restore, node revoke,
  plugin removal, and file writes are marked destructive. Hosts should present
  confirmation for these operations.
- Provider configuration is allowlisted by operation name. Provider keys are
  forwarded only to the existing authenticated provider route and are never
  returned by the MCP adapter or logged by it.
- Tool schemas do not mark credentials as `x-mcp-header`; sensitive arguments
  must stay in the JSON body and be protected by HTTPS and bearer policy.
- Modern requests must include the protocol version, client info, and client
  capabilities in `_meta`; mirrored header mismatches use JSON-RPC `-32020`.
- `tools/list` is deterministic and private to the authenticated caller. The
  catalog should be cached only per credential scope.
- MCP authentication is application policy. This adapter does not mint OAuth
  credentials, accept a node secret as a user token, or bypass paired-client
  workspace restrictions.
