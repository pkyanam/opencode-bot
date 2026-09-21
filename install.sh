#!/usr/bin/env bash
# Public bootstrap installer. It is intentionally dependency-light so this can
# be run as: curl -fsSL https://raw.githubusercontent.com/pkyanam/opencode-bot/main/install.sh | bash
set -Eeuo pipefail

readonly REPO_URL="${OCBOT_REPO_URL:-https://github.com/pkyanam/opencode-bot.git}"
readonly NODE_VERSION="${OCBOT_NODE_VERSION:-24.14.0}"
readonly INSTALL_DIR="${OCBOT_INSTALL_DIR:-${HOME}/.local/share/opencode-bot}"
readonly NODE_ROOT="${OCBOT_NODE_ROOT:-${HOME}/.local/share/opencode-bot-runtime/node-v${NODE_VERSION}}"
NODE_TMP=""

say() { printf '%s\n' "[opencode-bot] $*"; }
die() { printf '%s\n' "[opencode-bot] error: $*" >&2; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

download() {
  if command_exists curl; then curl -fsSL "$1" -o "$2"
  elif command_exists wget; then wget -qO "$2" "$1"
  else die "curl or wget is required to bootstrap Node.js"
  fi
}

node_archive() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "unsupported operating system: $(uname -s) (use macOS or Linux)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) die "unsupported CPU architecture: $(uname -m)" ;;
  esac
  if [[ "$os" == "darwin" ]]; then
    printf 'node-v%s-%s-%s.tar.gz' "$NODE_VERSION" "$os" "$arch"
  else
    printf 'node-v%s-%s-%s.tar.xz' "$NODE_VERSION" "$os" "$arch"
  fi
}

ensure_node() {
  if command_exists node && command_exists npm; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    if [[ "$major" =~ ^[0-9]+$ && "$major" -ge 24 ]]; then return; fi
    say "system Node.js is too old; using a user-local Node.js ${NODE_VERSION}"
  fi
  if [[ ! -x "${NODE_ROOT}/bin/node" || ! -x "${NODE_ROOT}/bin/npm" ]]; then
    local archive tmp url
    archive="$(node_archive)"
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/opencode-bot-node.XXXXXX")"
    NODE_TMP="$tmp"
    trap '[[ -n "${NODE_TMP:-}" ]] && rm -rf "$NODE_TMP"' EXIT
    url="https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
    say "installing Node.js ${NODE_VERSION} under ${NODE_ROOT}"
    download "$url" "${tmp}/${archive}"
    download "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" "${tmp}/SHASUMS256.txt"
    local expected_checksum actual_checksum
    expected_checksum="$(awk -v file="$archive" '$2 == file { print $1 }' "${tmp}/SHASUMS256.txt")"
    [[ -n "$expected_checksum" ]] || die "Node.js checksum manifest did not contain ${archive}"
    if command_exists sha256sum; then actual_checksum="$(sha256sum "${tmp}/${archive}" | awk '{print $1}')"
    else actual_checksum="$(shasum -a 256 "${tmp}/${archive}" | awk '{print $1}')"; fi
    [[ "$actual_checksum" == "$expected_checksum" ]] || die "Node.js archive checksum verification failed"
    rm -rf "${NODE_ROOT}.partial"
    mkdir -p "${NODE_ROOT}.partial"
    case "$archive" in
      *.tar.xz) tar -xJf "${tmp}/${archive}" -C "${NODE_ROOT}.partial" --strip-components=1 ;;
      *.tar.gz) tar -xzf "${tmp}/${archive}" -C "${NODE_ROOT}.partial" --strip-components=1 ;;
    esac
    rm -rf "${NODE_ROOT}"
    mv "${NODE_ROOT}.partial" "${NODE_ROOT}"
    rm -rf "$tmp"
    NODE_TMP=""
    trap - EXIT
  fi
  export PATH="${NODE_ROOT}/bin:${PATH}"
  command_exists node || die "Node.js bootstrap did not produce a usable node binary"
  command_exists npm || die "Node.js bootstrap did not produce a usable npm binary"
}

ensure_git() {
  command_exists git && return
  if command_exists brew; then
    say "Git is missing; installing it with the existing user-local Homebrew"
    brew install git
    command_exists git && return
    die "Homebrew did not provide a usable Git binary"
  fi
  if command_exists apt-get; then
    die "Git is required to clone the repository. Install git with your package manager (the installer never invokes sudo)"
  fi
  die "Git is required to clone the repository; install Git and rerun (the installer never invokes sudo)"
}

checkout_repo() {
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    local remote expected
    remote="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
    expected="${REPO_URL%.git}"
    [[ "${remote%.git}" == "$expected" ]] || die "${INSTALL_DIR} points to a different repository; set OCBOT_INSTALL_DIR or inspect it"
    if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
      die "${INSTALL_DIR} has local changes; commit or move them before rerunning"
    fi
    say "updating existing checkout at ${INSTALL_DIR}"
    git -C "$INSTALL_DIR" pull --ff-only --quiet || die "could not fast-forward ${INSTALL_DIR}; inspect it and rerun"
  elif [[ -e "$INSTALL_DIR" ]]; then
    die "${INSTALL_DIR} exists but is not an opencode-bot checkout"
  else
    say "cloning ${REPO_URL} into ${INSTALL_DIR}"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
}

ensure_container_engine() {
  if ! command_exists docker && command_exists brew; then
    say "Docker CLI is missing; installing Docker CLI and Colima with Homebrew"
    brew install docker colima
  fi
  command_exists docker || die "Docker CLI is required for Cloudflare Sandbox deployment; install Docker or a compatible engine and rerun"
  if ! docker info >/dev/null 2>&1 && command_exists colima; then
    say "starting the user-local Colima container engine"
    colima start
  fi
  docker info >/dev/null 2>&1 || die "a running Docker-compatible container engine is required; start Docker Desktop or Colima and rerun"
}

tty_available() { [[ -r /dev/tty && -w /dev/tty ]]; }

ensure_cloudflare_auth() {
  local whoami_output status
  whoami_output="$(npx --no-install wrangler whoami 2>&1)" || status=$?
  status="${status:-0}"
  if [[ "$status" -eq 0 && ! "$whoami_output" =~ (not[[:space:]]+logged|not[[:space:]]+authenticated|no[[:space:]]+api[[:space:]]+token|unauthorized) ]]; then
    say "Cloudflare authentication is available"
    return
  fi
  say "Wrangler needs Cloudflare authentication; a browser login will open"
  if ! tty_available; then
    die "Cloudflare login needs /dev/tty. Run the installer from an interactive terminal, then rerun"
  fi
  npx --no-install wrangler login </dev/tty >/dev/tty
  npx --no-install wrangler whoami >/dev/tty 2>&1 || die "Cloudflare authentication did not complete"
}

choose_cloudflare_account() {
  local state_dir account_file requested raw accounts count choice selected
  state_dir="${INSTALL_DIR}/.opencode-bot"
  account_file="${state_dir}/account-id"
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  requested="${CLOUDFLARE_ACCOUNT_ID:-}"
  if [[ -s "$account_file" ]]; then
    local saved
    saved="$(tr -d '[:space:]' < "$account_file")"
    if [[ -n "$requested" && "$requested" != "$saved" ]]; then
      die "CLOUDFLARE_ACCOUNT_ID differs from the account selected for this checkout (${saved}); use the original account or a new OCBOT_INSTALL_DIR"
    fi
    requested="$saved"
  fi

  raw="$(npx --no-install wrangler whoami --json 2>/dev/null)" || die "Wrangler could not enumerate Cloudflare accounts; rerun authentication"
  accounts="$(printf '%s' "$raw" | node --input-type=module -e '
    let text=""; process.stdin.on("data", c => text += c).on("end", () => {
      try {
        const value=JSON.parse(text); const rows=Array.isArray(value) ? value : (value.accounts ?? value.result ?? []);
        for (const row of rows) { const id=typeof row === "string" ? row : row.id ?? row.account_id; const name=typeof row === "object" ? (row.name ?? row.account_name ?? "") : ""; if (id) process.stdout.write(`${id}\t${name}\n`); }
      } catch { process.exitCode=1; }
    });
  ' 2>/dev/null)" || die "Wrangler returned an unreadable account list"
  [[ -n "$accounts" ]] || die "Wrangler returned no usable Cloudflare accounts; authenticate again with an account that can deploy Workers"
  count="$(printf '%s\n' "$accounts" | awk 'NF { n++ } END { print n+0 }')"
  if [[ -n "$requested" ]]; then
    if ! printf '%s\n' "$accounts" | awk -F '\t' -v id="$requested" '$1 == id { found=1 } END { exit found ? 0 : 1 }'; then
      die "Cloudflare account ${requested} is not available to the authenticated Wrangler identity"
    fi
    selected="$requested"
  elif [[ "$count" -eq 1 ]]; then
    selected="$(printf '%s\n' "$accounts" | awk -F '\t' 'NF { print $1; exit }')"
  else
    if ! tty_available; then
      die "multiple Cloudflare accounts are available; set CLOUDFLARE_ACCOUNT_ID to the intended account and rerun"
    fi
    say "multiple Cloudflare accounts are available:"
    local index=0 line id name
    while IFS=$'\t' read -r id name; do index=$((index + 1)); printf '%s\n' "  ${index}) ${name:-unnamed} (${id})" >/dev/tty; done <<< "$accounts"
    printf '%s' "[opencode-bot] Choose the Cloudflare account number: " >/dev/tty
    IFS= read -r choice </dev/tty || true
    [[ "$choice" =~ ^[0-9]+$ && "$choice" -ge 1 && "$choice" -le "$count" ]] || die "invalid Cloudflare account selection"
    selected="$(printf '%s\n' "$accounts" | awk -F '\t' -v n="$choice" 'NF { i++; if (i == n) { print $1; exit } }')"
  fi
  printf '%s\n' "$selected" > "$account_file"
  chmod 600 "$account_file"
  export CLOUDFLARE_ACCOUNT_ID="$selected"
  say "using Cloudflare account ${selected}"
}

open_onboarding() {
  local state_dir="${INSTALL_DIR}/.opencode-bot"
  [[ -s "${state_dir}/deployment-state.json" && -s "${state_dir}/secrets.json" ]] || return 0
  OCBOT_STATE_DIR="$state_dir" node --input-type=module -e '
    import { readFileSync, writeFileSync, chmodSync } from "node:fs";
    const dir = process.env.OCBOT_STATE_DIR;
    const state = JSON.parse(readFileSync(`${dir}/deployment-state.json`, "utf8"));
    const secrets = JSON.parse(readFileSync(`${dir}/secrets.json`, "utf8"));
    if (!state.deploymentUrl || !secrets.APP_TOKEN) process.exit(0);
    const target = `${state.deploymentUrl.replace(/\/$/, "")}#connect=${encodeURIComponent(secrets.APP_TOKEN)}`;
    const file = `${dir}/open.html`;
    writeFileSync(file, `<!doctype html><meta http-equiv="refresh" content="0;url=${target}"><a href="${target}">Open opencode-bot</a>\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  '
  if [[ -f "${state_dir}/open.html" ]]; then
    say "opening the owner connection handoff"
    if command_exists open; then open "${state_dir}/open.html" >/dev/null 2>&1 || true
    elif command_exists xdg-open; then xdg-open "${state_dir}/open.html" >/dev/null 2>&1 || true
    else say "open ${state_dir}/open.html in a browser to finish owner connection"; fi
  fi
}

main() {
  # Supplying --yes is accepted for scripts that make authorization explicit;
  # running this installer already authorizes the declared deployment.
  case "${1:-}" in --yes) shift ;; esac
  ensure_node
  ensure_git
  checkout_repo
  cd "$INSTALL_DIR"
  ensure_container_engine
  say "installing locked dependencies"
  npm ci
  ensure_cloudflare_auth
  choose_cloudflare_account
  say "applying the deployment"
  ./setup.sh apply --apply --install-missing
  open_onboarding
  say "installed successfully at ${INSTALL_DIR}"
}

main "$@"
