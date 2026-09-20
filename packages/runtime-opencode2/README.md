# OpenCode 2 runtime adapter

This package is pinned to the published `@opencode/client@2.0.11`. It uses the
new promise client (`OpenCode.make`) and `@opencode/client/service` for a
managed `opencode serve --service` process. It does not use the old
`@opencode-ai/sdk/v2` package.

`OpenCode2Runtime` accepts an injected client/service for contract tests. In a
real Linux computer, set `root` to `/workspace/state` and `directory` to the
working directory. The adapter sets XDG roots and `HOME` for the managed
service, so operator OpenCode state is not imported.

The event stream is live-only in OpenCode 2. The runner records its own
monotonic event sequence and can reconcile from `session.log` when needed.

## Catalog and commands

`OpenCode2Runtime.catalog()` queries the location-scoped v2 APIs for models,
providers, agents, native commands, and MCP connection status. OpenCode hydrates
these registries lazily, so the adapter polls for up to eight seconds after a
cold start rather than treating the first empty response as authoritative. The
runner serves this as authenticated `GET /catalog`; an optional `directory`
query parameter is constrained by the caller's workspace authorization in the
control plane.

Commands returned by OpenCode are marked `execution: "native-session-command"`
and can be submitted as `{ command: { name, text } }` to `POST /runs`. The
runner maps this to `session.command`; it does not emulate command behavior.
CLI-only commands (`help`, `version`, `doctor`, `auth`, `serve`, `service`,
`mcp`, `plugin`, `models`, `session`, and `api`) are reported in
`cliOnlyCommands`; they are not session/TUI commands and are not sent to an
agent session. The `actions` array describes operations backed by explicit v2
APIs: `compact` calls `session.compact`, `undo` stages a revert for a selected
message, and `redo` clears the staged revert (while `revert-commit` applies one
explicitly). Their implementation belongs to
the authenticated control plane and computer supervisor; they must not be sent
through `session.command` with a slash-prefixed name.

The catalog is live and may still be empty when no provider is configured. The
published OpenCode Zen catalog currently exposes free IDs such as
`opencode/big-pickle`; the runtime accepts those IDs and qualification must
still be performed by a real prompt probe before presenting a model as ready.
