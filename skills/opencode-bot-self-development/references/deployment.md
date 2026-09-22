# Deployment and runtime inspection

Separate the four layers before reporting status. Start with the read-only
`inspect_self` tool's `deployment` topic when available; it returns bounded
deployment metadata and release/buildpack provenance without exposing the
environment. Then verify the relevant layer below.

| Layer | Evidence to inspect | What it proves |
| --- | --- | --- |
| Source checkout | `git rev-parse HEAD`, `git status --short` | Local files and commit |
| Runner | authenticated `GET /health`, `GET /checkpoint/state` | Local runner process and quiescence |
| Worker | `wrangler tail` or account read APIs when explicitly authorized | Remote Worker behavior |
| Release/image | `.opencode-bot/release-manifest.json`, release bundle metadata, image digest | Artifact provenance and pinned runtime |

Start with `npm run doctor` or `node scripts/setup/botctl.mjs doctor` when a
diagnostic is requested. These checks are intended to be read-only. Inspect the
plan with `node scripts/setup/botctl.mjs plan` before any apply operation.

The repository pins OpenCode and Sandbox versions in `runner/package.json`,
`package.json`, and release validation. A healthy runner does not prove that
the Worker or published image has been updated. A successful local build does
not prove that a release was deployed.

Wrangler is the repository's Cloudflare CLI. Use `npx --no-install wrangler
whoami` only to check account context when needed, and never include account
tokens or raw secret output. Read-only inspection is preferred; any deploy,
secret upload, image rollout, or Worker deletion requires an explicit request
and a reviewed plan.
