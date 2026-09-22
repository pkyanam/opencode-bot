#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=/opt/opencode-bot
SOURCE="${APP_BUNDLE_DIR:-$ROOT}"
RELEASES="$ROOT/releases"
CURRENT="$RELEASES/current"
DATA=/var/lib/opencode-bot
ETC=/etc/opencode-bot
APP_PORT="${APP_PORT:-}"
APP_TOKEN_FILE="${APP_TOKEN_FILE:-}"
APP_BOOTSTRAP_MARKER="${APP_BOOTSTRAP_MARKER:-}"
NODE_VERSION="${BOAT_NODE_VERSION:-v24.12.0}"
if [[ -z "$APP_PORT" && -f /etc/systemd/system/opencode-bot.service ]]; then APP_PORT="$(sed -n 's/^Environment=OPENCODE_PORT=//p' /etc/systemd/system/opencode-bot.service | head -1)"; fi
APP_PORT="${APP_PORT:-8789}"

fail() { printf 'Boat bootstrap failed: %s\n' "$1" >&2; return 1; }
write_bootstrap_marker() {
  [[ -n "$APP_BOOTSTRAP_MARKER" ]] || return 0
  local status="$1" code="${2:-null}"; install -d -m 0700 "$(dirname "$APP_BOOTSTRAP_MARKER")"
  printf '{"status":"%s","exitCode":%s}\n' "$status" "$code" > "$APP_BOOTSTRAP_MARKER"
  chmod 0600 "$APP_BOOTSTRAP_MARKER"
}
finish_bootstrap_marker() { local code=$?; trap - EXIT; if [[ "$code" == 0 ]]; then write_bootstrap_marker terminal 0; else write_bootstrap_marker failed "$code"; fi; exit "$code"; }
write_bootstrap_marker running null
trap finish_bootstrap_marker EXIT
command -v flock >/dev/null 2>&1 || fail 'flock is required'
LOCK_FILE=/tmp/opencode-bot-bootstrap.lock
exec 9>"$LOCK_FILE"
flock -n 9 || fail 'another Boat bootstrap is already running'
[[ -n "$APP_TOKEN_FILE" && -r "$APP_TOKEN_FILE" ]] || fail 'APP_TOKEN_FILE is required and must be readable'
[[ -s "$APP_TOKEN_FILE" ]] || fail 'APP_TOKEN_FILE is empty'
command -v sudo >/dev/null 2>&1 || fail 'sudo is required'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'
command -v shasum >/dev/null 2>&1 || fail 'shasum is required'

install_node24() {
  if command -v node >/dev/null 2>&1 && [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ]]; then return; fi
  local node_arch tmp archive checksums expected actual extract
  case "$(uname -m)" in x86_64) node_arch=x64;; aarch64|arm64) node_arch=arm64;; *) fail "unsupported Linux architecture $(uname -m)";; esac
  tmp="$(mktemp -d /tmp/opencode-node.XXXXXX)"
  archive="node-${NODE_VERSION}-linux-${node_arch}.tar.xz"
  checksums="$tmp/SHASUMS256.txt"
  curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o "$checksums" || fail "Node ${NODE_VERSION} official checksum list unavailable"
  expected="$(awk -v f="$archive" '$2 == f {print $1}' "$checksums")"; [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail 'Node archive is absent from the official checksum list'
  curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/${NODE_VERSION}/$archive" -o "$tmp/$archive" || fail 'Node official archive download failed'
  actual="$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')"; [[ "$actual" == "$expected" ]] || fail 'Node official archive checksum mismatch'
  extract="$tmp/extract"; mkdir -p "$extract"; tar -xJf "$tmp/$archive" -C "$extract"
  sudo install -d -m 0755 "$ROOT/node"; sudo cp -a "$extract/node-${NODE_VERSION}-linux-${node_arch}"/. "$ROOT/node/"
  export PATH="$ROOT/node/bin:$PATH"
  rm -rf "$tmp"
}

install_node24
command -v node >/dev/null 2>&1 || fail 'Node 24 installation did not provide node'
[[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ]] || fail 'Node 24 or newer is required'
sudo install -d -m 0755 "$ROOT/node/bin"
node_source="$(command -v node)"
if [[ "$node_source" != "$ROOT/node/bin/node" ]]; then
  [[ ! -L "$ROOT/node/bin/node" ]] || sudo rm "$ROOT/node/bin/node"
  sudo install -m 0755 "$node_source" "$ROOT/node/bin/node"
fi
export PATH="$ROOT/node/bin:$PATH"
[[ -f "$SOURCE/control-local.js" && -d "$SOURCE/runner" && -d "$SOURCE/web" && -d "$SOURCE/boat" ]] || fail 'release bundle is missing required files'
sudo install -d -m 0755 "$RELEASES" "$DATA/objects" "$DATA/computers" "$ETC"
sudo useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin opencode-bot 2>/dev/null || true
sudo chown opencode-bot:opencode-bot "$DATA"
if [[ -e "$CURRENT" && -s "$ETC/app-token" ]] && systemctl is-active --quiet opencode-bot.service 2>/dev/null; then
  existing_auth="$(sudo cat "$ETC/app-token")"
  existing_state="$(curl --fail --silent --show-error --max-time 5 -H "Authorization: Bearer $existing_auth" "http://127.0.0.1:${APP_PORT}/api/state")" || fail 'existing Boat app health check failed; refusing an in-place restart'
  active_count="$(printf '%s' "$existing_state" | node -e 'let s=""; process.stdin.on("data", d => { s += d; }); process.stdin.on("end", () => { try { const v = JSON.parse(s); const active = new Set(["queued","provisioning","running","waiting_approval","waiting_human","recovering","cancelling"]); const n = (v.runs || []).filter(r => active.has(r.status)).length + (v.pendingMessages || []).length; process.stdout.write(String(n)); } catch { process.exit(2); } });')" || fail 'could not inspect existing Boat work state'
  [[ "$active_count" == 0 ]] || fail 'active Boat work exists; finish it before rerunning the installer'
fi
release="$RELEASES/$(date -u +%Y%m%d%H%M%S)-$$"
previous=''; [[ -e "$CURRENT" ]] && previous="$(readlink "$CURRENT")"
unit_backup="$(mktemp -d /tmp/opencode-bot-units.XXXXXX)"
for unit in opencode-bot.service opencode-bot-updater.service opencode-bot-hindsight.service; do
  if [[ -f "/etc/systemd/system/$unit" ]]; then sudo cp -a "/etc/systemd/system/$unit" "$unit_backup/$unit"; fi
done
rollback() {
  sudo systemctl stop opencode-bot.service >/dev/null 2>&1 || true
  sudo rm -rf "$release"
  if [[ -n "$previous" ]]; then
    sudo ln -sfn "$previous" "$CURRENT" || true
    for unit in opencode-bot.service opencode-bot-updater.service opencode-bot-hindsight.service; do
      if [[ -f "$unit_backup/$unit" ]]; then sudo cp -a "$unit_backup/$unit" "/etc/systemd/system/$unit"; fi
    done
    sudo systemctl daemon-reload >/dev/null 2>&1 || true
    sudo systemctl restart opencode-bot-hindsight.service >/dev/null 2>&1 || true
    sudo systemctl restart opencode-bot.service >/dev/null 2>&1 || true
  else
    sudo rm -f "$CURRENT"
  fi
}
trap rollback ERR
sudo mkdir -p "$release"
sudo cp -a "$SOURCE/boat-release.json" "$SOURCE/control-local.js" "$SOURCE/runner" "$SOURCE/web" "$SOURCE/boat" "$SOURCE/packages" "$SOURCE/docs" "$SOURCE/skills" "$SOURCE/README.md" "$SOURCE/SECURITY.md" "$SOURCE/package.json" "$release/"
sudo chmod -R a+rX "$release"
sudo ln -sfn runner/node_modules "$release/node_modules"
# npm 11 may leave install scripts pending by default. These two lockfile-pinned
# scripts are required to materialize the native opencode2 and msgpackr binaries;
# keep the project allowlist narrow instead of enabling arbitrary scripts.
printf '%s\n' 'allow-scripts[]=@opencode/cli' 'allow-scripts[]=msgpackr-extract' | sudo tee "$release/runner/.npmrc" >/dev/null
sudo sh -c "cd '$release/runner' && npm ci --workspaces=false --omit=dev --no-audit --fund=false" >/dev/null
sudo rm -f "$release/runner/.npmrc"
[[ -x "$release/runner/node_modules/.bin/opencode2" ]] || fail 'runner dependency install did not provide the opencode2 executable'
sudo -u opencode-bot env HOME="$DATA" PATH="$release/runner/node_modules/.bin:$ROOT/node/bin:$PATH" "$release/runner/node_modules/.bin/opencode2" --version >/dev/null || fail 'installed opencode2 executable failed its version check'
sudo apt-get install -y --no-install-recommends x11-apps x11-xserver-utils xclip xdotool >/dev/null
sudo install -d -m 0755 "$ROOT/browsers"
sudo PLAYWRIGHT_BROWSERS_PATH="$ROOT/browsers" "$release/runner/node_modules/.bin/playwright" install --with-deps chromium >/dev/null
sudo install -d -m 0700 "$DATA" "$ETC"
sudo install -d -o opencode-bot -g opencode-bot -m 0755 /workspace/shared /workspace/browser
if [[ "$(readlink -f "$APP_TOKEN_FILE")" != "$(readlink -f "$ETC/app-token")" ]]; then sudo install -m 0600 "$APP_TOKEN_FILE" "$ETC/app-token"; else sudo chmod 0600 "$ETC/app-token"; fi
if [[ ! -s "$ETC/runner-token" ]]; then
  token_tmp="$(mktemp)"; od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$token_tmp"; printf '\n' >> "$token_tmp"
  sudo install -m 0600 "$token_tmp" "$ETC/runner-token"; rm -f "$token_tmp"
fi
if [[ -n "${APP_MEMORY_CONFIG_FILE:-}" ]]; then
  sudo install -m 0600 "$APP_MEMORY_CONFIG_FILE" "$ETC/hindsight-provider.json"
fi
sudo chown -R opencode-bot:opencode-bot "$DATA" "$ETC"
sudo chown -R opencode-bot:opencode-bot "$ROOT/browsers"
sed "s/Environment=OPENCODE_PORT=8789/Environment=OPENCODE_PORT=${APP_PORT}/" "$release/boat/opencode-bot.service" | sudo install -m 0644 /dev/stdin /etc/systemd/system/opencode-bot.service
sudo install -m 0644 "$release/boat/opencode-bot-updater.service" /etc/systemd/system/opencode-bot-updater.service
sudo install -d -o opencode-bot -g opencode-bot -m 0700 "$DATA/update"
sudo chown -R opencode-bot:opencode-bot "$DATA/update"
printf 'opencode-bot ALL=(root) NOPASSWD: /bin/systemctl start --no-block opencode-bot-updater.service\n' | sudo install -m 0440 /dev/stdin /etc/sudoers.d/opencode-bot-updater
sudo ln -sfn "$release" "$CURRENT"
sudo bash "$release/boat/hindsight-setup.sh"
sudo systemctl daemon-reload
sudo systemctl enable opencode-bot.service
sudo systemctl restart opencode-bot.service
for attempt in $(seq 1 60); do
  auth="$(sudo cat "$ETC/app-token")"
  state_json="$(curl --fail --silent --show-error --max-time 2 -H "Authorization: Bearer $auth" "http://127.0.0.1:${APP_PORT}/api/state" 2>/dev/null || true)"
  if [[ -n "$state_json" ]] && printf '%s' "$state_json" | node -e 'let s=""; process.stdin.on("data", d => { s += d; }); process.stdin.on("end", () => { try { const v = JSON.parse(s); if (!Array.isArray(v.bots) || !Array.isArray(v.threads) || !Array.isArray(v.runs)) process.exit(1); } catch { process.exit(1); } });'; then
    catalog_json="$(curl --fail --silent --show-error --max-time 3 -H "Authorization: Bearer $auth" "http://127.0.0.1:${APP_PORT}/api/catalog" 2>/dev/null || true)"
    readiness_json="$(curl --fail --silent --show-error --max-time 5 -H "Authorization: Bearer $auth" "http://127.0.0.1:${APP_PORT}/api/computer/readiness" 2>/dev/null || true)"
    if printf '%s' "$catalog_json" | node -e 'let s=""; process.stdin.on("data", d => { s += d; }); process.stdin.on("end", () => { try { const v = JSON.parse(s); if (!Array.isArray(v.models) || !Array.isArray(v.commands) || !Array.isArray(v.providers)) process.exit(1); } catch { process.exit(1); } });' && printf '%s' "$readiness_json" | node -e 'let s=""; process.stdin.on("data", d => { s += d; }); process.stdin.on("end", () => { try { const v = JSON.parse(s); process.exit(v.state === "ready" ? 0 : 1); } catch { process.exit(1); } });'; then
      trap - ERR; sudo rm -rf "$unit_backup"; printf 'Boat app ready on port %s\n' "$APP_PORT"; exit 0
    fi
  fi
  sleep 1
done
fail 'authenticated app health check did not become ready'
