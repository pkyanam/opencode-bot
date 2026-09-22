# Memory that follows your bots

Memory lives in the workspace control server, above every Computer and node. A bot on your Mac can share a memory with a bot on Cloudflare or another VM. No files need to be copied, and the recipient Computer does not need to be awake when you share.

Open **Memories** in the web sidebar, or **Workspace → Memory** on mobile. Use **New memory** to save something or **Ask memories** to ask a question about what a bot knows. Search and the bot filter help you find existing memories; expand a card to edit, share, pin, inspect its history, or delete it. The bot filter includes memories other bots shared with the selected bot.

The settings icon opens **Memory settings**. Hindsight indexes saved memories in the background; “Indexing memories” means they are saved but semantic retrieval is still catching up. Basic search remains available. Once indexing finishes, **Ask memories** returns a grounded answer with expandable evidence.

## Ask naturally

- “Remember that I prefer pnpm for new TypeScript projects.”
- “Remember the verified source for these wiring diagrams and share it with Llama.”
- “What do you remember about this deployment?”
- “Correct that memory: use the staging account, not production.”
- “Stop sharing this with Scout.”
- “Forget the old deployment decision.”

Bots receive instructions to retain durable decisions, lessons, preferences, and procedures, and can do so during a task. This is model-driven capture, not a guarantee that every message is automatically stored. Credentials, transient progress, and unverified guesses do not belong in memory.

## Sharing

| Visibility | Who can recall it |
| --- | --- |
| Private | Author bot |
| Shared | Author and selected bots, on any node |
| Workspace | All current and future bots in this workspace |

Recipients read the same record, not a stale copy. Corrections become available on their next read or recall. Recipients cannot modify or reshare another bot's memory. They can save a separate memory of their own when appropriate. The workspace owner and paired trusted clients administer all memories; “private” means private from other bots, not hidden from you or your devices.

Removing a share revokes future retrieval. It cannot erase content already seen in a conversation or copied by a recipient. Deleting a memory removes its registry record, grants, search index, and retained revisions; existing conversation history and backups are separate records.

Deleting a bot removes its private memories. Shared/workspace knowledge remains in the registry with an archived author, so other bots do not lose it. The owner can still edit or delete it.

## Retrieval and durability

The registry remains the authority for identity, grants, revisions, correction, and deletion. Its control-server database (a Cloudflare Durable Object by default, persistent SQLite on Boat) is authoritative and fail-closed: a provider or projection must never widen a bot's access. Before a task, the coordinator retrieves relevant memories and pinned context within a 6,000-character content budget. Search previews are bounded; `memory_read` retrieves the complete selected record.

The built-in Hindsight service runs as a dedicated Cloudflare service using Workers AI. It does not require an additional LLM API key. It can retain asynchronously, then use semantic graph and temporal retrieval for recall and reflection. Its supported workspace capabilities are retain, recall, reflect, observations, and mental models. Automatic capture is enabled on new built-in deployments and can be disabled in Memory settings; it starts with newly completed tasks, without silently importing old conversations. Retain and provider synchronization report `pending`, `failed`, and status states; a ready state is only reported after the upstream service is actually available.

On Boat, Hindsight and its embedded PostgreSQL run on the same VM as separate services. Supply an explicit compatible LLM provider using the [Boat installer](boat-setup.md); Boat mode does not use Workers AI or require a Cloudflare account. Without that configuration, the registry and lexical retrieval remain available.

Each bot has an ACL-scoped Hindsight bank. Shared memories are exposed through an authorized projection, while derived observations and mental models remain scoped to the requesting bot. Corrections and revocations are propagated to provider banks and projections; bank rotation is used when required, and failures fail closed. A disposable Postgres projection cache may accelerate retrieval, but it is rebuilt from the authoritative registry after a restart. This can add latency and inference cost, and cache contents never become the source of truth.

The registry's built-in fallback uses SQLite FTS5 lexical search and adds no graph database, embedding API, or execution-container startup dependency. When Hindsight is enabled, its semantic and temporal layer is used in addition to that fallback. Neither path fixes a model's full conversation context limit or replaces OpenCode compaction.

Existing manual bot records are migrated to the Hindsight backend automatically when the provider is enabled. The registry records remain intact and retain their IDs; migration and projection work can be delayed or fail and is surfaced through engine status. Updates use revision checks; stale edits receive a conflict rather than silently overwriting newer information. The registry keeps the latest 20 versions per memory, caps individual entries at 16,000 characters, and limits the workspace to 10,000 entries and 20 million bytes of content plus retained revision snapshots. Index/database overhead is additional. Export results before removing unwanted data.

Computer checkpoints do not own this registry. Sleeping, replacing, or restoring an execution Computer does not roll it back. Uninstalling the workspace control server and its durable data does remove it; export first if you want to retain the knowledge.

## Tools and API

Bots on every node receive these tools through their existing `bots` MCP service:

- `memory_search(query, limit?)`
- `memory_read(id)`
- `memory_remember(content, title?, kind?, tags?, visibility?, sharedBotIds?)`
- `memory_update(id, revision, ...)`
- `memory_share(id, revision, visibility?, sharedBotIds?)`
- `memory_forget(id, revision)`

A run-specific bearer capability grants only that run's bot access. The coordinator derives identity from the run, checks access on each request, and refuses the credential once the run terminates. Credentials stay out of tool responses and persisted runner snapshots. Execution nodes are trusted computers: an owner or process with access to a node's running processes remains inside that node's trust boundary.

Owner/paired-client REST endpoints:

- `GET /api/memory?botId=...&q=...&limit=100&offset=0`
- `POST /api/memory`
- `GET /api/memory/:id`
- `PATCH /api/memory/:id` with the current `revision`
- `DELETE /api/memory/:id?revision=...`
- `GET /api/memory/:id/history`
- `GET /api/memory/engine`
- `PATCH /api/memory/engine` with optional external `url` and write-only `apiKey`
- `POST /api/memory/engine/sync`
- `POST /api/memory/recall` and `POST /api/memory/reflect` with `{botId, query, budget}`
- `GET /api/memory/observations?botId=...`
- `GET /api/memory/mental-models?botId=...`
- `POST /api/memory/mental-models`, `POST /api/memory/mental-models/:id/refresh`, and
  `DELETE /api/memory/mental-models/:id?botId=...`

The external OpenCode Bot MCP server exposes registry search, read, creation, update, history, and deletion, plus Hindsight recall, reflection, observations, and mental-model creation, refresh, and deletion. Legacy per-bot memory endpoints remain compatible.

## Advanced providers

Hindsight is available as the built-in provider or as an optional external durable Hindsight service. The external option accepts a URL and write-only API key; a blank URL uses the configured built-in service for the deployment. External configuration and synchronization can take time and can report errors. Changing the external endpoint does not delete banks on the previous server; remove those through that server’s administration tools when they are no longer needed. There is no free-tier guarantee: Workers AI, Hindsight, Postgres projection storage, and local embedding resources can incur resource and inference costs.

Provider outages must not block basic chat or access to the authoritative memory record. Full upstream Hindsight knowledge pages and unrelated provider-specific UI are not part of this integration; the supported surface is the capability set documented above and the workspace memory registry.
