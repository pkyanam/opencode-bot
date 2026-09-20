# Operations guide

The repository ships a deliberately conservative setup program. It does not
create or modify Cloudflare resources until the operator supplies `--apply`.
Run `./setup.sh doctor` first, then inspect the machine-readable plan:

```sh
./setup.sh doctor
./setup.sh plan > deployment-plan.json
./setup.sh apply --apply
```

`doctor` checks the local Node, Git, container engine, Wrangler, and Cloudflare
login. A missing Docker daemon is reported separately from a missing CLI. Use
`npm exec wrangler login` to authenticate; never put an API token in a shell
history or a checked-in config file. `--install-missing` only creates a local
`.dev.vars` file with randomly generated development tokens. It does not use
sudo, install an operating-system package, enable billing, or accept Cloudflare
terms.

The deployment journal is `.opencode-bot/deployment-state.json` and is ignored
by Git. It records resource ownership metadata and SHA-256 fingerprints of
internal tokens, never token values. Keep it with the deployment's encrypted
backup material. If an apply stops part way through, inspect the journal and
rerun after fixing the reported prerequisite; do not delete resources to make a
retry appear clean.

The Worker configuration pins the OpenCode release and Sandbox package line
and uses SQLite Durable Objects for authoritative coordination. The initial
slice uses DO alarms rather than a queue consumer or D1 projection. R2 stores
application-owned computer checkpoints when that adapter is enabled. Never
adopt an existing same-name resource unless you can verify it belongs to this
installation.

Secrets are intentionally separate from Wrangler configuration. `apply` creates
or reuses a mode-0600 local secret bundle and uploads it with Wrangler after the
Worker is deployed; it never prints the values. Provider keys supplied through
`OPENAI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, or
`OPENCODE_API_KEY` are included in that bundle. Provider keys are never passed
as Docker build arguments. Use a custom domain with Cloudflare
Access for the initial deployment; preview and alternate hostnames must remain
protected too.

For an upgrade, pause run admission, checkpoint the workspace and browser
profile, deploy the matched Worker/image pair, run the restore probe, and only
then resume admission. Keep the previous image and pre-migration backup until
the probe passes. `destroy` should stop compute and remove routing while
retaining data; purging R2, keys, and backups is a separate deliberate action.

## Stable local previews

`npm run preview:worker -- --var APP_TOKEN:local-preview-token --var RUNNER_TOKEN:local-runner-token`
creates a gitignored snapshot of the Worker bundle and assets, then starts
Wrangler with that bundle. Vite can refresh the frontend without replacing the
container's outbound gateway. Restart this command deliberately after backend
changes. Checkpoint an idle computer before rebuilding its image.

During qualification, direct source reloads left the Docker egress proxy pointing
to a closed host port. Native model calls then retried with connection reset or
certificate verification errors. A freshly started gateway successfully handled
native Muse Spark requests. Do not turn off certificate validation to hide this
failure. Check the local proxy log and restart the preview backend; restore the
committed checkpoint if the container image changed.
