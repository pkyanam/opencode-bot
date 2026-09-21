# OpenCode 2 qualification

`opencode2.mjs` runs a real OpenCode 2 service and the pinned
`@opencode/client` against a local fake OpenAI-compatible model. It creates
isolated `HOME`, XDG config/data/state directories, and a temporary workspace;
the user's service, credentials, and model provider are never read.

The harness requires OpenCode CLI `2.0.11`. Point it at a locally installed
binary with `OPENCODE2_BIN=/path/to/opencode2`:

```sh
tmp=$(mktemp -d)
npm install --prefix "$tmp" @opencode/cli@2.0.11
OPENCODE2_BIN="$tmp/node_modules/.bin/opencode2" node tests/qualification/opencode2.mjs
```

It verifies `/api/info`, creates a session with a configured
`@opencode/ai/providers/openai-compatible` provider, completes two prompts,
and checks that the second prompt continues the same session. It also sends a
message while a turn is active and verifies native steering admission, its stable
message ID, and completion of the follow-up. The fake model
only listens on loopback and returns deterministic SSE responses.

The separate [credential-free model record](free-model.md) captures an app-level
Cloudflare-local wrapped run using native OpenCode CLI 2.0.11 and
`opencode/muse-spark-1.3-contributor-free`. It also records a scoped isolated
Big Pickle/Zen 403 observation; the two results qualify different request paths.
