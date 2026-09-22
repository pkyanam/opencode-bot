# Boat hosting (preview)

Cloudflare remains the preferred hosting target. Boat is an optional, all-Boat,
no-Cloudflare path that runs OpenCode Bot in a persistent Linux VM with a
durable disk and an enabled systemd service.

The unified installer is intended for macOS and Linux. It uses the
logged-in Boat CLI, or `BOAT_API_KEY` for automation. It reuses Node.js 24+ when
available; otherwise it downloads the official Node archive, verifies its
`SHASUMS256.txt` digest, and installs a user-local runtime without sudo or
changing the system Node installation.

The installer downloads the release manifest and verifies the bundle checksum
before provisioning a VM. Use a release that includes Boat assets (v0.1.31 or
later).

```sh
curl -fsSL https://raw.githubusercontent.com/pkyanam/opencode-bot/main/install.sh \
  | bash -s -- --boat --type default --ttl 3600 --open
```

In an interactive run, the Boat installer asks for a VM size and recommends
`default`. The supported values are `small` (2 vCPU, 4 GB), `default` (4 vCPU,
8 GB), `large` (8 vCPU, 16 GB), and `xlarge` (16 vCPU, 32 GB). These names and
capacities come from the Boat CLI's `boat new --help`; use `--type` for a
noninteractive install. The selected type is saved with the Boat ownership
journal and reused on later noninteractive reruns. Boat may impose account or
allocation requirements on larger types.

Provisioning installs the application, npm dependencies, browser runtime, and
desktop integration inside the VM. Expect several minutes on the first run;
the VM needs Node, Chromium dependencies, desktop packages, and application
dependencies. The setup uses the VM's existing desktop display and does not
require Docker.

The default hosted URL is public at the Boat routing layer so mobile and
Telegram clients can reach it. The application still requires its own bearer
token. Boat's private route token is a separate mechanism and is incompatible
with clients that cannot preserve a token-bearing URL. Use `--private` only
when every client supports that route. `--open` opens a local browser URL with
the app token in its fragment; the token is not sent in HTTP requests or logs.

The VM filesystem and app data survive `boat stop` and `boat resume`. The
enabled systemd service starts the app after a resume. Hand-started processes
do not survive a stop. Uninstall deletes the recorded sandbox and requires an
explicit confirmation:

```sh
curl -fsSL https://raw.githubusercontent.com/pkyanam/opencode-bot/main/install.sh \
  | bash -s -- --boat status
curl -fsSL https://raw.githubusercontent.com/pkyanam/opencode-bot/main/install.sh \
  | bash -s -- --boat --uninstall --yes
```

### Updating the app

Starting with v0.1.35, open **Settings → Updates** to check for a release and
update the app and its Computer together. No Cloudflare deployment token or
Boat API key is needed inside the app. Finish active work first. The updater
verifies the GitHub release, keeps your data and connection token, and restarts
the services. Keep the page open to follow progress and reconnect afterward.

An older Boat installation needs one rerun of the installer to install this
updater. Reuse the same installer state directory so it updates your existing
VM. The installer does not resize an existing VM; a different size requires an
explicit Boat resize operation.

The installer records only its owned sandbox under
`~/.local/share/opencode-bot/boat` (override with `OCBOT_BOAT_STATE_DIR`). The
directory is mode `0700`; its state and secret files are mode `0600`. Reruns
reuse the saved app token and refuse to claim success until an authenticated
health check passes. A failed setup leaves a provisioning record for a safe
retry and does not publish a hosted URL.

## Optional memory provider

Pass a local mode-0600 JSON file to the same installer. Do not put provider
keys in command arguments or shell history.

```json
{"llmBaseUrl":"https://llm.example/v1","llmApiKey":"REDACTED","llmModel":"model-name"}
```

```sh
chmod 600 hindsight-provider.json
curl -fsSL https://raw.githubusercontent.com/pkyanam/opencode-bot/main/install.sh \
  | bash -s -- --boat --memory-provider-file "$PWD/hindsight-provider.json"
```

The URL must use HTTPS; loopback HTTP is allowed for a local proxy. The file is
transferred and installed with mode `0600`, then temporary copies are removed.
Omitting the option preserves an existing provider configuration. No provider
credentials are invented, and memory is not reported ready without valid
configuration.

## Browser transport

The existing app preview transport is supported. Boat's native desktop viewer
supports a 1920×1080/60fps display path, but it is not yet integrated into the
app installer. See [Boat browser notes](boat-browser.md) for the current
transport details.
