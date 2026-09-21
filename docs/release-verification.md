# Release verification — September 21, 2026

The v0.1.11 code was checked against the Cloudflare test workspace, using the
v0.1.10 Computer image (unchanged by the Worker-only attachment forwarding fix).
The personal deployment was not modified.

- 194 Vitest tests and 59 Node tests passed, alongside type checking and a
  production web build.
- A real v0.1.9 → v0.1.10 update detected the replacement Computer, restored its
  checkpoint automatically, and preserved bots, conversations, and a known file.
- A temporary paired client used MCP to upload and download a 1 MiB binary file.
  Owner-only provider configuration was absent from its tool catalog.
- The same client uploaded a note and PNG, then submitted both to a new thread.
  OpenCode's free `mimo-v2.5-free` model read the note's verification marker and
  recognized the image attachment. Both canonical attachment IDs appeared in the
  native user-message transcript without embedding the files' raw bytes there.
- The browser displayed attachment cards, model commentary, file tool actions,
  and the final response in chronological order.
- Temporary client credentials were revoked and updater credentials removed.

The live checks exposed and fixed missing upload parent directories, omitted
attachments in Cloudflare run dispatch, and premature update completion before
the replacement Computer became visible. Regression coverage protects each path.

Provider behavior is separate from app transport: the Muse free provider returned
an upstream 504 during an earlier check; the Mimo free provider completed the
successful tests. Telegram attachment handling is covered by automated tests,
not by sending unsolicited test messages to a user's Telegram chat.

See [attachment limitations](attachments.md), [MCP](mcp.md), and the
[mobile client plan](mobile-client.md) for the current boundaries.
