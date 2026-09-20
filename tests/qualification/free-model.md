# Credential-free model qualification and scoped observations

The current app qualification includes one successful credential-free
Cloudflare-local wrapped run. On **2026-09-20**, the app used the native
OpenCode CLI **2.0.11** through the local Worker/Sandbox path with
`opencode/muse-spark-1.3-contributor-free`:

```text
started  2026-09-20T23:13:41.264Z
finished 2026-09-20T23:13:50.872Z
cost     0
result   My name is Scout.
```

This is evidence for that exact model, topology, and run. It does not qualify
every advertised free model, a deployed Cloudflare account, or a native desktop
runtime.

`free-model.mjs` is an evidence harness, not a fake fallback. It runs the
pinned OpenCode 2 CLI and client in isolated temporary directories, asks the
server for its model catalog, and attempts `opencode/big-pickle` through the
official OpenCode Zen OpenAI-compatible endpoint. It never reads or writes the
operator's OpenCode auth/config files.

OpenCode's official model catalog advertises Big Pickle and several `*-free`
entries. The official Zen docs describe free models as available through
OpenCode. The isolated harness below tests a different path, `big-pickle`
through the direct Zen endpoint, and records a `FreeTierError` when that
specific unauthenticated request is rejected. That 403 is a scoped observation,
not a claim that all free models or all app topologies are unavailable.

```sh
tmp=$(mktemp -d)
npm install --prefix "$tmp" @opencode/cli@2.0.11
OPENCODE2_BIN="$tmp/node_modules/.bin/opencode2" \
  node tests/qualification/free-model.mjs
```

For a credentialed qualification, pass a dedicated `OPENCODE_API_KEY` in the
environment intentionally. Do not place it in this repository or in a shared
image. The script still uses only the temporary config and service state.

The observed no-credential result on 2026-09-20 was with a clean native V2
configuration (no custom `providers` entry, no provider override, and all
credential-like environment variables scrubbed):

```text
Zen /v1/models: HTTP 200; free ids included big-pickle,
jev-1.13-free, deepseek-v4-flash-free, mimo-v2.5-free,
nemotron-3-ultra-free, and nemotron-3.5-lightning-free.
OpenCode 2.0.11 local server `model.list({location:{location:{directory}}})`
returned an array containing `big-pickle` and the `*-free` entries. The
provider and plugin list endpoints returned empty `data` arrays because no
credentialed integration was activated.
Assistant message: provider.auth, status 403,
"OpenCode's free tier can only be used from within OpenCode".
```

This means the public Zen catalog alone does not qualify every independent
self-hosted path. The successful `muse-spark-1.3-contributor-free` run above
shows that a credential-free model can work in the qualified local Cloudflare
path. Each model/provider/topology combination still needs its own evidence; a
paid/authenticated key or a separately qualified local/OpenAI-compatible model
may be required elsewhere.
