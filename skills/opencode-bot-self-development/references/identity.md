# Identity and source inspection

Answer identity questions from observed state, in this order. Prefer the
read-only `inspect_self` tool when it is available: request `all` for an
overview, then `identity`, `deployment`, `source`, or `capabilities` for a
narrow answer. Its `trust` field describes the limits of deployment-provided
metadata; it does not prove that the source checkout is clean.

For product documentation, use the read-only `self_docs` tool with one of its
allowlisted topics (`overview`, `setup`, `memory`, `nodes`, or `security`). It
returns bounded text from a known repository document. Never attempt path
traversal or ask it to expose arbitrary files.

If those tools are unavailable, answer identity questions from observed state
in this order:

```sh
pwd
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short
node --version
```

Then read `package.json` for the application version, `runner/package.json` for
the runner package version, `wrangler.jsonc` for the Worker entry point and
bindings, and `runner/server.mjs` for the local runner service name. The
application package version is source metadata; it is not proof that a remote
Worker or container is running that commit.

For a release-backed identity, inspect the local
`.opencode-bot/release-manifest.json` and verify its commit and version against
the checkout. `scripts/setup/release.mjs` defines the manifest checks, including
the full 40-character source commit and pinned runtime versions. If the
manifest is absent, say that release provenance is unavailable.

For the deployed service, use only authenticated, read-only endpoints already
provided by the deployment workflow (for example runner `/health` and
`/checkpoint/state`). Do not infer a secret or deployment identity from a token.
When a command emits credentials, do not include its output in the response.

Useful source anchors in this repository:

- `apps/control-worker/src/index.ts`: Worker API and Durable Object behavior.
- `runner/server.mjs`: local OpenCode runner and workspace routes.
- `packages/runtime-opencode2/`: OpenCode runtime adapter.
- `scripts/setup/botctl.mjs`: plan/doctor/apply deployment workflow.
- `scripts/release/`: release bundle and provenance verification.

When the source checkout is absent, clone only the repository URL returned by
`inspect_self.source.repository` (currently
`https://github.com/pkyanam/opencode-bot`) into a new temporary directory,
inspect its `README.md` and git remote, and compare its HEAD with the reported
commit. Do not silently substitute a fork, download an archive from an
unverified host, or place credentials in the clone URL. A clone gives source
context; it does not prove which deployment is running.
