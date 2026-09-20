# User owned nodes

`NodeRegistry` is a SQLite backed registry intended to live inside the existing
`Workspace` Durable Object. It does not create a listener or a new public
service. The node agent makes outbound HTTPS requests to the existing control
Worker, so a home computer never needs an inbound firewall rule.

## Workspace integration

Create one registry after the Workspace schema is initialized:

```ts
import { NodeRegistry } from "../../../packages/nodes/src/index";

private nodes(): NodeRegistry {
  return (this.nodeRegistry ??= new NodeRegistry(this.state.storage.sql));
}
```

Delegate `/api/nodes/*` from `Workspace.fetch` before the generic 404 branch:

```ts
if (url.pathname === "/api/nodes" || url.pathname.startsWith("/api/nodes/"))
  return this.nodes().handle(request, { adminAuthorized: this.ownerAuthorized(request) });
```

The Worker authentication gate must preserve the route's two credential
classes. `POST /api/nodes/register` has no owner credential; the one time
pairing token in its JSON body is the credential. Heartbeats, polls, and job
results use `Authorization: Bearer <nodeSecret>`. Pairing creation, listing,
revocation, and enqueueing remain owner authenticated. In the outer Worker,
route node requests to the Workspace and let `NodeRegistry.handle` enforce
these checks rather than treating every `/api` route as an APP_TOKEN route.

The registry exposes availability honestly: `list()` marks a node online only
when it has heartbeated within 90 seconds and never reports a node as a run
target by itself. Existing Workspace run dispatch must explicitly enqueue a
`runner.run` payload through `NodeRegistry.enqueue` before remote execution is
advertised. The node agent understands this payload and talks to the local
runner's existing `/runs` HTTP API; unknown payload kinds fail and are reported
as failed jobs. The payload's `run` object is passed through unchanged, so the
Workspace should include its durable `runId`, `threadId`, and `sessionId` for
session affinity. Keep the selected node id with the active run and enqueue
only to that node. If the agent lease expires, the registry moves the job to
`needs_review` and never replays an ambiguous external action automatically.

Workspace stores an optional `bots.node_id`, copies it into
`threads.node_id` when a conversation is created, and never changes that
thread affinity when the bot is edited later. `runs.node_job_id` and
`runs.node_command_job_id` are durable receipts used to reconcile a run after
a Durable Object restart.

## HTTP contract

| Method | Path | Credential | Purpose |
| --- | --- | --- | --- |
| POST | `/api/nodes/pairing` | owner | Create a short lived single use pairing token |
| POST | `/api/nodes/register` | pairing token in JSON | Redeem token and receive node id plus secret |
| GET | `/api/nodes` | owner | List nodes and truthful heartbeat availability |
| POST | `/api/nodes/:id/revoke` | owner | Revoke a node secret immediately |
| POST | `/api/nodes/:id/heartbeat` | node bearer | Update heartbeat and capabilities |
| GET | `/api/nodes/:id/jobs/poll` | node bearer | Lease one queued job |
| POST | `/api/nodes/:id/jobs/:jobId/progress` | node bearer | Refresh an active runner receipt, including approval state/events |
| POST | `/api/nodes/:id/jobs/:jobId/result` | node bearer | Complete a leased job |
| POST | `/api/nodes/jobs/:id` | owner | Enqueue a protocol job for an explicit node |

The secret and pairing token are returned only at creation time and only their
SHA-256 digests are persisted.

Workspace uses `runner.run` for an affinity thread and includes the exact
OpenCode runner input, including `runId`, `threadId`, `sessionId`, model,
agent, system prompt, native command, or native session action. Cancellation
and approval forwarding use priority 100 `runner.cancel` and
`runner.approval` jobs; ordinary runs use priority 50. The agent polls the
same queue with commands taking precedence while a run is active. Terminal,
desktop, and native message browsing remain unsupported for owned nodes and
return an explicit conflict instead of opening the Cloudflare computer.
