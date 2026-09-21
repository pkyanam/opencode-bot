# Control Worker MCP endpoint

`apps/control-worker/src/mcp.ts` exposes the control API as an explicit MCP
tool catalog. It is a route adapter, not a second backend: every `tools/call`
maps to a reviewed `/api/...` path and the caller’s bearer credential must be
checked again by the existing Worker route.

## Connect an agent

The endpoint is **`https://YOUR-WORKER.workers.dev/api/mcp`**. Use Streamable HTTP
and an `Authorization: Bearer <token>` header in your client's MCP configuration.
Client configuration file formats vary; use its documented remote-server format.

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
