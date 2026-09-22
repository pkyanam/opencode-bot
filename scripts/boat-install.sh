#!/usr/bin/env bash
set -Eeuo pipefail
trap 'status=$?; printf "[opencode-bot] Boat setup failed at line %s (exit %s). Rerun the installer to resume.\n" "$LINENO" "$status" >&2' ERR
printf '%s\n' '[opencode-bot] Checking Boat and Node.js…'
export PATH="$HOME/.local/bin:$PATH"
node_tmp=""
cleanup_prereq() { rm -rf "${node_tmp:-}"; }
trap cleanup_prereq EXIT

# Checkout-free Boat installer. The release manifest is discovered from the
# trusted GitHub latest release by default; URL/digest flags remain advanced
# overrides for release testing.
if ! command -v boat >/dev/null 2>&1; then
  if [ "${OCBOT_NONINTERACTIVE:-0}" = 1 ] || [ ! -r /dev/tty ]; then
    printf '%s\n' 'Boat CLI is required. Install it from https://boat.dev/install, then rerun.' >&2
    exit 1
  fi
  printf '%s\n' 'Boat CLI is missing; installing it from https://boat.dev/install.' >&2
  curl --fail --location --proto '=https' --tlsv1.2 https://boat.dev/install | sh
  command -v boat >/dev/null 2>&1 || { printf '%s\n' 'Boat CLI installation did not provide boat on PATH.' >&2; exit 1; }
fi

# Keep the installer self-contained. An existing Node 24+ is reused; otherwise
# install the official Node distribution into the user's cache without sudo or
# changing a system runtime. The archive is checked against Node's official
# SHASUMS256.txt before extraction.
node_version="${OCBOT_NODE_VERSION:-24.14.0}"
node_home="${OCBOT_BOAT_NODE_HOME:-$HOME/.local/share/opencode-bot/tools/boat-node}"
[[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf '%s\n' 'OCBOT_NODE_VERSION must be a numeric Node.js version such as 24.14.0.' >&2; exit 1; }
node_archive=""
case "$(uname -s):$(uname -m)" in
  Darwin:x86_64) node_archive="node-v${node_version}-darwin-x64.tar.gz";;
  Darwin:arm64) node_archive="node-v${node_version}-darwin-arm64.tar.gz";;
  Linux:x86_64) node_archive="node-v${node_version}-linux-x64.tar.xz";;
  Linux:aarch64|Linux:arm64) node_archive="node-v${node_version}-linux-arm64.tar.xz";;
  *) printf 'Unsupported platform for Node.js bootstrap: %s:%s\n' "$(uname -s)" "$(uname -m)" >&2; exit 1;;
esac
download_file() {
  if command -v curl >/dev/null 2>&1; then curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 180 --retry 2 --retry-delay 1 --silent --show-error "$1" -o "$2";
  elif command -v wget >/dev/null 2>&1; then wget --https-only --timeout=30 --tries=3 -qO "$2" "$1";
  else printf '%s\n' 'curl or wget is required for the verified Node.js bootstrap.' >&2; exit 1; fi
}
sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
node_major_for() { "$1" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || [ "$(node_major_for "$(command -v node)")" -lt 24 ]; then
  if [ -x "$node_home/bin/node" ] && [ -x "$node_home/bin/npm" ] && [ "$(node_major_for "$node_home/bin/node")" -ge 24 ]; then
    export PATH="$node_home/bin:$PATH"
  else
    node_tmp="$(mktemp -d "${TMPDIR:-/tmp}/opencode-bot-node.XXXXXX")"
    download_file "https://nodejs.org/dist/v${node_version}/${node_archive}" "$node_tmp/$node_archive"
    download_file "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" "$node_tmp/SHASUMS256.txt"
    expected_node_sha="$(awk -v f="$node_archive" '$2 == f {print $1}' "$node_tmp/SHASUMS256.txt")"
    actual_node_sha="$(sha256_file "$node_tmp/$node_archive")"
    [ -n "$expected_node_sha" ] && [ "$actual_node_sha" = "$expected_node_sha" ] || { printf '%s\n' 'Node.js download checksum verification failed.' >&2; exit 1; }
    node_partial="${node_home}.partial"
    rm -rf "$node_partial"
    mkdir -p "$node_partial"
    case "$node_archive" in
      *.tar.xz) tar -xJf "$node_tmp/$node_archive" -C "$node_partial" --strip-components=1;;
      *.tar.gz) tar -xzf "$node_tmp/$node_archive" -C "$node_partial" --strip-components=1;;
    esac
    rm -rf "$node_home"
    mv "$node_partial" "$node_home"
    export PATH="$node_home/bin:$PATH"
  fi
fi
node_major="$(node_major_for "$(command -v node)")"
[ "$node_major" -ge 24 ] || { printf 'Node.js 24+ bootstrap failed (found %s).\n' "$node_major" >&2; exit 1; }

# Reuse an existing session. If one is missing, let an interactive user complete
# Boat's documented browser login through /dev/tty; piped/noninteractive runs
# fail with a precise instruction instead of hanging for input.
if [ -z "${BOAT_API_KEY:-}" ] && ! boat status --json --no-update >/dev/null 2>&1; then
  if [ "${OCBOT_NONINTERACTIVE:-0}" = 1 ] || [ ! -r /dev/tty ]; then
    printf '%s\n' 'Boat authentication is required. Run boat login, or set BOAT_API_KEY for automation.' >&2
    exit 1
  fi
  boat login --no-update </dev/tty >/dev/tty
fi

script_url="${OCBOT_BOAT_SCRIPT_URL:-https://raw.githubusercontent.com/pkyanam/opencode-bot/main/scripts/setup/boat.mjs}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/opencode-bot-boat.XXXXXX")"
cleanup() { rm -rf "$tmp_dir" "$node_tmp"; }
trap cleanup EXIT
script_file="$tmp_dir/boat.mjs"
curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error "$script_url" -o "$script_file"
ui_url="${OCBOT_BOAT_UI_URL:-https://raw.githubusercontent.com/pkyanam/opencode-bot/main/scripts/setup/installer-ui.mjs}"
ui_file="$tmp_dir/installer-ui.mjs"
curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error "$ui_url" -o "$ui_file"

node_command=install
skip_bundle=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) node_command=uninstall; skip_bundle=1;;
    --status) node_command=status; skip_bundle=1;;
    --doctor) node_command=doctor; skip_bundle=1;;
    status|doctor) node_command="$arg"; skip_bundle=1;;
  esac
done

bundle="${OCBOT_BOAT_BUNDLE:-}"
if [ "$skip_bundle" -eq 0 ] && [ -z "$bundle" ]; then
  printf '%s\n' '[opencode-bot] Downloading the verified Boat release…'
  manifest_url="${OCBOT_BOAT_MANIFEST_URL:-https://github.com/pkyanam/opencode-bot/releases/latest/download/boat-bundle-manifest.json}"
  # Keep automatic discovery pinned to this repository. This prevents a
  # generic github.com URL from silently changing the executable bundle.
  case "$manifest_url" in
    https://github.com/pkyanam/opencode-bot/releases/*/download/boat-bundle-manifest.json) ;;
    *) printf '%s\n' 'Boat release manifest must be hosted in the trusted opencode-bot GitHub repository.' >&2; exit 1;;
  esac
  curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error "$manifest_url" -o "$tmp_dir/boat-bundle-manifest.json"
  read -r release_version archive_file expected_sha expected_size <<EOF
$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(m.schemaVersion!==1 || !/^v\d+\.\d+\.\d+$/.test(m.version) || !/^[0-9a-f]{40}$/.test(m.commit||"") || m.archive?.file!=="boat-bundle.tar.gz" || !/^[0-9a-f]{64}$/.test(m.archive.sha256||"") || !Number.isSafeInteger(m.archive.size) || m.archive.size<=0) { process.exit(2); } process.stdout.write(`${m.version} ${m.archive.file} ${m.archive.sha256} ${m.archive.size}`)' "$tmp_dir/boat-bundle-manifest.json")
EOF
  if [ -z "${release_version:-}" ]; then printf '%s\n' 'Invalid Boat release manifest.' >&2; exit 1; fi
  bundle="$tmp_dir/boat-bundle.tar.gz"
  archive_url="${OCBOT_BOAT_BUNDLE_URL:-https://github.com/pkyanam/opencode-bot/releases/download/$release_version/$archive_file}"
  case "$archive_url" in
    https://github.com/pkyanam/opencode-bot/releases/download/*/boat-bundle.tar.gz) ;;
    *) printf '%s\n' 'Boat release bundle must be hosted in the trusted opencode-bot GitHub repository.' >&2; exit 1;;
  esac
  curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error "$archive_url" -o "$bundle"
  actual_sha="$(shasum -a 256 "$bundle" | awk '{print $1}')"
  actual_size="$(wc -c < "$bundle" | tr -d '[:space:]')"
  [ "$actual_sha" = "$expected_sha" ] && [ "$actual_size" = "$expected_size" ] \
    || { printf '%s\n' 'Boat release bundle checksum or size mismatch.' >&2; exit 1; }
  OCBOT_BOAT_BUNDLE_SHA256="$expected_sha"
elif [ "$skip_bundle" -eq 0 ]; then
  if [ -z "${OCBOT_BOAT_BUNDLE_SHA256:-}" ]; then printf '%s\n' 'OCBOT_BOAT_BUNDLE_SHA256 is required with OCBOT_BOAT_BUNDLE.' >&2; exit 1; fi
fi

# Login reads a key from stdin in boat.mjs when BOAT_API_KEY is present. Existing
# Boat CLI sessions are reused. Do not echo the key or any token-bearing URL.
set +e
if [ "$skip_bundle" -eq 1 ]; then
  node "$script_file" "$node_command" "$@"
else
  node "$script_file" install --bundle "$bundle" --bundle-sha256 "$OCBOT_BOAT_BUNDLE_SHA256" "$@"
fi
status=$?
set -e
exit "$status"
