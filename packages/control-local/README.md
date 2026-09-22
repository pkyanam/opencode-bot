# control-local

Standalone Node 24 entrypoint for running the control worker on a Boat host.
The default command starts the real control worker, SQLite-backed workspace state,
the local computer provider, and the pinned runner process. Cloudflare Sandbox is
bundled as an explicit unavailable adapter; local startup always uses
`COMPUTER_PROVIDER`.

Build and run from the repository root:

```sh
node packages/control-local/src/build.mjs
APP_TOKEN='change-me' node packages/control-local/dist/control-local.js
```

Useful environment variables are `APP_HOST` and `APP_PORT`, `OPENCODE_STATE` (SQLite path), `OPENCODE_OBJECTS`
(checkpoint/object directory), `OPENCODE_COMPUTERS` (computer runtime directory),
`OPENCODE_RUNNER_SCRIPT` (runner entrypoint), `OPENCODE_ASSETS`, `APP_TOKEN` or
`APP_TOKEN_FILE`, and `RUNNER_TOKEN` or `RUNNER_TOKEN_FILE`. `APP_TOKEN` is required;
if `RUNNER_TOKEN` is omitted, the app token is used for the local runner.

For the local Hindsight supervisor, set `HINDSIGHT_TOKEN` and optionally
`HINDSIGHT_BASE_URL`, `HINDSIGHT_LLM_BASE_URL`, `HINDSIGHT_LLM_API_KEY`, and
`HINDSIGHT_LLM_MODEL`. The LLM settings must be supplied together.

The entrypoint accepts `startLocalControl` for embedding and tests. Its `close()`
method drains the HTTP listener, gracefully stops managed local runners, and closes
SQLite state. Token files can be supplied through `appTokenFile` and
`runnerTokenFile`; they must be mode `0600`.
