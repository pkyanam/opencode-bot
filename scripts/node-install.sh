#!/usr/bin/env bash
# Install a user-owned outbound node from a GitHub Release. No git checkout is
# used; the release manifest pins both the bundle commit and archive digest.
set -Eeuo pipefail

readonly RELEASE_BASE="${OCBOT_RELEASE_BASE:-https://github.com/pkyanam/opencode-bot}"
readonly NODE_VERSION="${OCBOT_NODE_VERSION:-24.14.0}"
readonly NODE_HOME="${OCBOT_NODE_HOME:-${HOME}/.local/share/opencode-bot-node}"
readonly CONFIG_DIR="${OCBOT_NODE_CONFIG_DIR:-${HOME}/.config/opencode-bot-node}"
readonly CONFIG_FILE="${OCBOT_NODE_CONFIG:-${CONFIG_DIR}/node.json}"
readonly SERVICE_NAME="opencode-bot-node"
tmp=""
NODE_BIN=""
trap '[[ -n "${tmp:-}" ]] && rm -rf "$tmp"' EXIT

say() { printf '[opencode-bot node] %s\n' "$*"; }
die() { printf '[opencode-bot node] error: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
download() { if has curl; then curl --connect-timeout 10 --max-time 180 --retry 2 --retry-delay 1 -fsSL "$1" -o "$2"; elif has wget; then wget --timeout=30 --tries=3 -qO "$2" "$1"; else die 'curl or wget is required'; fi; }
sha256() { if has sha256sum; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
new_tmp() { [[ -z "${tmp:-}" ]] || rm -rf "$tmp"; tmp="$(mktemp -d "${TMPDIR:-/tmp}/opencode-bot-node-install.XXXXXX")"; }
xml_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'; }
node_archive() { case "$(uname -s):$(uname -m)" in Darwin:x86_64) printf 'node-v%s-darwin-x64.tar.gz' "$NODE_VERSION";; Darwin:arm64) printf 'node-v%s-darwin-arm64.tar.gz' "$NODE_VERSION";; Linux:x86_64) printf 'node-v%s-linux-x64.tar.xz' "$NODE_VERSION";; Linux:aarch64|Linux:arm64) printf 'node-v%s-linux-arm64.tar.xz' "$NODE_VERSION";; *) die "unsupported platform $(uname -s)/$(uname -m)";; esac; }

ensure_node() {
  if has node && has npm && [[ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -ge 24 ]]; then NODE_BIN="$(command -v node)"; return; fi
  if [[ -x "$NODE_HOME/bin/node" && -x "$NODE_HOME/bin/npm" ]] && [[ "$("$NODE_HOME/bin/node" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -ge 24 ]]; then export PATH="$NODE_HOME/bin:$PATH"; NODE_BIN="$NODE_HOME/bin/node"; return; fi
  local archive url expected actual partial
  archive="$(node_archive)"; new_tmp
  download "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" "$tmp/$archive"
  download "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  expected="$(awk -v f="$archive" '$2 == f {print $1}' "$tmp/SHASUMS256.txt")"; actual="$(sha256 "$tmp/$archive")"
  [[ -n "$expected" && "$actual" == "$expected" ]] || die 'Node.js download checksum verification failed'
  partial="${NODE_HOME}.partial"; rm -rf "$partial"; mkdir -p "$partial"
  case "$archive" in *.tar.xz) tar -xJf "$tmp/$archive" -C "$partial" --strip-components=1;; *.tar.gz) tar -xzf "$tmp/$archive" -C "$partial" --strip-components=1;; esac
  rm -rf "$NODE_HOME"; mv "$partial" "$NODE_HOME"; export PATH="$NODE_HOME/bin:$PATH"; NODE_BIN="$NODE_HOME/bin/node"
}

stop_service() {
  if [[ "$(uname -s)" == Darwin ]]; then launchctl bootout "gui/$(id -u)/com.opencode.bot.node" 2>/dev/null || true
  elif has systemctl; then systemctl --user disable --now "$SERVICE_NAME.service" 2>/dev/null || true; fi
}
install_browser() {
  export PLAYWRIGHT_BROWSERS_PATH="$NODE_HOME/browsers"
  mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
  say 'Installing the private Chromium browser…'
  npx --no-install --prefix "$NODE_HOME/bundle/runner" playwright install --no-shell chromium >/dev/null
}
uninstall() { stop_service; rm -f "$HOME/Library/LaunchAgents/com.opencode.bot.node.plist" "$HOME/.config/systemd/user/$SERVICE_NAME.service"; if [[ -f "$NODE_HOME/.opencode-bot-node-owned" ]]; then rm -rf "$NODE_HOME"; else say "preserving $NODE_HOME (ownership marker is missing)"; fi; if [[ -f "$CONFIG_DIR/.opencode-bot-node-owned" ]]; then rm -f "$CONFIG_FILE" "$CONFIG_DIR/.opencode-bot-node-owned"; rm -rf "$CONFIG_DIR/state" "$CONFIG_DIR/workspace"; rmdir "$CONFIG_DIR" 2>/dev/null || true; else say "preserving $CONFIG_DIR (ownership marker is missing)"; fi; say 'node runtime, service, and local credentials removed; revoke the node in Settings if it is still listed'; }

install_service() {
  local agent="${NODE_HOME}/bundle/scripts/node-agent.mjs"; mkdir -p "$CONFIG_DIR"; chmod 700 "$CONFIG_DIR"
  if [[ "$(uname -s)" == Darwin ]]; then
    local dir="$HOME/Library/LaunchAgents"; mkdir -p "$dir"
    local x_node x_agent x_config x_log x_path x_browsers; x_node="$(xml_escape "$NODE_BIN")"; x_agent="$(xml_escape "$agent")"; x_config="$(xml_escape "$CONFIG_FILE")"; x_log="$(xml_escape "$NODE_HOME/node.log")"; x_path="$(xml_escape "$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"; x_browsers="$(xml_escape "$NODE_HOME/browsers")"
    cat > "$dir/com.opencode.bot.node.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.opencode.bot.node</string><key>ProgramArguments</key><array><string>${x_node}</string><string>${x_agent}</string><string>start</string><string>--config</string><string>${x_config}</string></array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${x_path}</string><key>PLAYWRIGHT_BROWSERS_PATH</key><string>${x_browsers}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${x_log}</string><key>StandardErrorPath</key><string>${x_log}</string></dict></plist>
EOF
    chmod 600 "$dir/com.opencode.bot.node.plist"
    local attempt loaded=0
    for attempt in 1 2 3 4 5; do
      if launchctl bootstrap "gui/$(id -u)" "$dir/com.opencode.bot.node.plist"; then loaded=1; break; fi
      sleep 1
    done
    [[ "$loaded" == 1 ]] || die 'macOS could not start the node service. Pairing credentials were saved; rerun this installer to retry.'
    launchctl print "gui/$(id -u)/com.opencode.bot.node" >/dev/null || die 'macOS did not register the node service'
  else
    local dir="$HOME/.config/systemd/user"; mkdir -p "$dir"
    cat > "$dir/$SERVICE_NAME.service" <<EOF
[Unit]
Description=OpenCode Bot owned computer node
After=network-online.target
[Service]
ExecStart="${NODE_BIN}" "${agent}" start --config "${CONFIG_FILE}"
Environment="PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin"
Environment="PLAYWRIGHT_BROWSERS_PATH=${NODE_HOME}/browsers"
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
[Install]
WantedBy=default.target
EOF
    chmod 600 "$dir/$SERVICE_NAME.service"
    has systemctl || die 'systemd is required on Linux; run node-agent start manually on another Unix service manager'
    systemctl --user daemon-reload; systemctl --user enable --now "$SERVICE_NAME.service"
  fi
}

usage() {
  cat <<'HELP'
Connect this computer to OpenCode Bot (no checkout required).
Usage: bash node-install.sh --control-url URL --pairing-token TOKEN [--name NAME]
  --control-url URL    Your OpenCode Bot workspace URL
  --pairing-token TOKEN  One-use token from Settings > Computers
  --name NAME          Optional display name (defaults to this computer's hostname)
  --version vX.Y.Z     Install a specific release
  --update             Update an already paired node (reuses saved credentials)
  --uninstall         Remove the installed node service and its local data
  --help              Show this help
HELP
}
main() {
  local control_url='' pairing_token='' name='' version manifest_url bundle_url expected actual expected_size actual_size update=0
  while (($#)); do
    case "$1" in --control-url|--pairing-token|--name|--version) [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 needs a value";; esac
    case "$1" in --control-url) control_url="${2:-}"; shift 2;; --pairing-token) pairing_token="${2:-}"; shift 2;; --name) name="${2:-}"; shift 2;; --version) export OCBOT_VERSION="${2:-}"; shift 2;; --update) update=1; shift;; --uninstall) uninstall; return;; --help|-h) usage; return;; *) die "unknown option $1 (use --control-url, --pairing-token, and --name)";; esac; done
  # A rerun against an existing paired node must never tear down its bundle
  # before dependencies are staged. Route it through the transactional updater.
  if [[ "$update" == 1 || -f "$CONFIG_FILE" ]]; then
    ensure_node
    local updater="$NODE_HOME/bundle/scripts/node-update.mjs" bootstrap_manifest=''
    # Releases before the transactional updater shipped no updater entrypoint.
    # Bootstrap it from the newly verified archive without touching the live
    # bundle; the updater then performs the same staged swap and rollback.
    if [[ ! -f "$updater" ]]; then
      new_tmp; [[ -n "${OCBOT_VERSION:-}" ]] && manifest_url="$RELEASE_BASE/releases/download/$OCBOT_VERSION/node-bundle-manifest.json" || manifest_url="$RELEASE_BASE/releases/latest/download/node-bundle-manifest.json"
      download "$manifest_url" "$tmp/manifest.json" || die 'could not download the node release manifest'
      read -r version bundle_url expected expected_size <<EOF
$(node --input-type=module -e 'import {readFileSync} from "node:fs"; const m=JSON.parse(readFileSync(process.argv[1])); if(m.schemaVersion!==1||!/^v\d+\.\d+\.\d+$/.test(m.version)||!/^[0-9a-f]{40}$/.test(m.commit)||m.archive?.file!=="node-bundle.tar.gz"||!/^[0-9a-f]{64}$/.test(m.archive.sha256)||!Number.isSafeInteger(m.archive.size)||m.archive.size<=0) process.exit(2); process.stdout.write(`${m.version} ${m.archive.file} ${m.archive.sha256} ${m.archive.size}`)' "$tmp/manifest.json")
EOF
      bundle_url="$RELEASE_BASE/releases/download/$version/$bundle_url"; download "$bundle_url" "$tmp/node-bundle.tar.gz"; actual="$(sha256 "$tmp/node-bundle.tar.gz")"; actual_size="$(wc -c < "$tmp/node-bundle.tar.gz" | tr -d '[:space:]')"; [[ "$actual" == "$expected" && "$actual_size" == "$expected_size" ]] || die 'node bundle checksum or size verification failed'
      mkdir -p "$tmp/bootstrap"; tar -xzf "$tmp/node-bundle.tar.gz" -C "$tmp/bootstrap"; updater="$tmp/bootstrap/scripts/node-update.mjs"; [[ -f "$updater" ]] || die 'verified release does not contain the node updater'; bootstrap_manifest="$tmp/manifest.json"
    fi
    local update_args=("$updater" --node-home "$NODE_HOME" --config "$CONFIG_FILE")
    [[ -n "${OCBOT_VERSION:-}" ]] && update_args+=(--version "$OCBOT_VERSION")
    [[ -n "$bootstrap_manifest" ]] && update_args+=(--manifest "$bootstrap_manifest" --archive "$tmp/node-bundle.tar.gz")
    say 'Updating the paired node (credentials, workspace, and browser profile are preserved)…'
    "$NODE_BIN" "${update_args[@]}"
    say 'node update completed'; return
  fi
  name="${name:-$(hostname -s 2>/dev/null || hostname 2>/dev/null || printf 'opencode-node')}"
  [[ -n "$control_url" && -n "$pairing_token" && -n "$name" ]] || die '--control-url and --pairing-token are required'
  say 'Preparing runtime…'
  ensure_node; export PATH="$(dirname "$NODE_BIN"):$PATH"; new_tmp
  if [[ -n "${OCBOT_VERSION:-}" ]]; then [[ "$OCBOT_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die '--version must be vSemVer'; manifest_url="$RELEASE_BASE/releases/download/$OCBOT_VERSION/node-bundle-manifest.json"; else manifest_url="$RELEASE_BASE/releases/latest/download/node-bundle-manifest.json"; fi
  say 'Downloading the verified node release…'
  download "$manifest_url" "$tmp/manifest.json" || die 'could not download the node release manifest'
  read -r version bundle_url expected expected_size <<EOF
$(node --input-type=module -e 'import {readFileSync} from "node:fs"; const m=JSON.parse(readFileSync(process.argv[1])); if(m.schemaVersion!==1||!/^v\d+\.\d+\.\d+$/.test(m.version)||!/^[0-9a-f]{40}$/.test(m.commit)||m.archive?.file!=="node-bundle.tar.gz"||!/^[0-9a-f]{64}$/.test(m.archive.sha256)||!Number.isSafeInteger(m.archive.size)||m.archive.size<=0) process.exit(2); process.stdout.write(`${m.version} ${m.archive.file} ${m.archive.sha256} ${m.archive.size}`)' "$tmp/manifest.json")
EOF
  bundle_url="$RELEASE_BASE/releases/download/$version/$bundle_url"; download "$bundle_url" "$tmp/node-bundle.tar.gz"; actual="$(sha256 "$tmp/node-bundle.tar.gz")"; actual_size="$(wc -c < "$tmp/node-bundle.tar.gz" | tr -d '[:space:]')"; [[ "$actual" == "$expected" && "$actual_size" == "$expected_size" ]] || die 'node bundle checksum or size verification failed'
  stop_service; rm -rf "$NODE_HOME.partial"; mkdir -p "$NODE_HOME" "$NODE_HOME.partial"; tar -xzf "$tmp/node-bundle.tar.gz" -C "$NODE_HOME.partial"; rm -rf "$NODE_HOME/bundle"; mv "$NODE_HOME.partial" "$NODE_HOME/bundle"; printf '{"version":"%s","commit":"%s"}\n' "$version" "$(node --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.argv[1])).commit)' "$tmp/manifest.json")" > "$NODE_HOME/bundle-version.json"; chmod 600 "$NODE_HOME/bundle-version.json"; : > "$NODE_HOME/.opencode-bot-node-owned"; chmod 600 "$NODE_HOME/.opencode-bot-node-owned"
  # Redeem before npm downloads. A retry for the same control server reuses the
  # saved node credential rather than trying to consume the pairing token twice.
  if "$NODE_BIN" --input-type=module -e 'import {readFileSync} from "node:fs"; try { const c=JSON.parse(readFileSync(process.argv[1])); const a=new URL(c.controlUrl), b=new URL(process.argv[2]); process.exit(c.nodeId && c.nodeSecret && c.runnerToken && a.origin===b.origin && a.pathname.replace(/\/api\/nodes\/?$/, "").replace(/\/$/, "")===b.pathname.replace(/\/$/, "") ? 0 : 1); } catch { process.exit(1); }' "$CONFIG_FILE" "$control_url"; then
    say 'Using the saved node connection…'
  else
    "$NODE_BIN" "$NODE_HOME/bundle/scripts/node-agent.mjs" register --control-url "$control_url" --pairing-token "$pairing_token" --name "$name" --config "$CONFIG_FILE" >/dev/null
  fi
  : > "$CONFIG_DIR/.opencode-bot-node-owned"; chmod 600 "$CONFIG_DIR/.opencode-bot-node-owned"
  say 'Installing OpenCode dependencies…'
  npm ci --prefix "$NODE_HOME/bundle/runner" --omit=dev --no-audit --fund=false >/dev/null
  rm -rf "$NODE_HOME/bundle/node_modules"; ln -s runner/node_modules "$NODE_HOME/bundle/node_modules"
  say 'Starting the background service…'
  install_browser
  install_service; say "paired $name and registered the background service (credentials are in $CONFIG_FILE)"
}
main "$@"
