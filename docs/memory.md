# Memory that follows your bots

Memory lives in the workspace control server, above every Computer and node. A bot on your Mac can share a memory with a bot on Cloudflare or another VM. No files need to be copied, and the recipient Computer does not need to be awake when you share.

Open **Memory registry** in the web sidebar, or **Workspace → Memory** on mobile. Search, write, edit, pin, share, inspect revisions, export, or delete memories there. The bot selector shows knowledge available to that bot, including memories other bots shared with it.

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

The built-in backend uses SQLite FTS5 search in the Cloudflare Workspace Durable Object. Title and tag matches carry extra weight. Before a task, the coordinator retrieves relevant memories and pinned context within a 6,000-character content budget. Bots can search for more during the task. Search previews are bounded; `memory_read` retrieves the complete selected record.

This adds no graph database, embedding API, or execution-container startup dependency. It is lexical retrieval, not semantic embedding search. It does not fix a model's full conversation context limit or replace OpenCode compaction.

Existing bot memories migrate once, retaining their IDs and becoming private, pinned entries to preserve their previous always-included behavior within the retrieval budget. Updates use revision checks; stale edits receive a conflict rather than silently overwriting newer information. The registry keeps the latest 20 versions per memory, caps individual entries at 16,000 characters, and limits the workspace to 10,000 entries and 20 million bytes of content plus retained revision snapshots. Index/database overhead is additional. Export results before removing unwanted data.

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

The external OpenCode Bot MCP server exposes registry search, read, creation, update, history, and deletion. Legacy per-bot memory endpoints remain compatible.

## Advanced providers

This release implements the central registry and indexed built-in backend. It does **not** install Hindsight, Mem0, Basic Memory, Graphiti, or Cognee.

Future provider adapters must preserve the registry as the authority for identity, grants, revisions, and deletion. External indexes must enforce the authorized scope before retrieval and reconcile revocations/deletions. Hindsight is the first advanced-provider candidate; a provider outage must not block basic chat or access to the authoritative memory record. Provider installation and inference costs should remain opt-in.
