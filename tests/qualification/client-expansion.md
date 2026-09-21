# Client expansion qualification — 2026-09-21

- Browser UI: paired a second origin/browser identity using a code from Settings,
  verified QR rendering, paired-device owner controls hidden, then revoked it and
  verified authenticated requests were rejected. All tests used local dummy credentials.
- Local Wrangler HTTP smoke: modern MCP owner/client catalogs, bot/thread CRUD,
  numeric/boolean routine arguments, and revoked-device rejection.
- In-process Worker/real SQLite integration tests cover the same MCP routing and
  authorization boundary, plus upload canonicalization and mid-turn attachments.
- Real OpenCode 2.0.11 with an isolated local fake provider: PNG and arbitrary binary
  files submitted through RunStore attachments; provider received image input;
  completion and native steering passed. No live provider keys were used. This
  verifies transport, not the visual reasoning quality of a model.
- Telegram photo/document ingestion and oversized-file handling use a mocked Bot
  API. No unsolicited Telegram test messages were sent to the owner's account.

Performance changes: catalog startup polls only models before loading other
registries (three hydration attempts: 7 API calls rather than 15). Hidden browser
tabs pause preview/transcript/state/handoff network polling; state and handoff
polls cannot overlap. Transcript responses strip uploaded binary data and retain
metadata, avoiding repeated image payloads in each refresh.
