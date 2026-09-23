#!/usr/bin/env bash
# Public bootstrap installer. It is intentionally dependency-light so this can
# be run as: curl -fsSL https://raw.githubusercontent.com/pkyanam/opencode-bot/main/install.sh | bash
set -Eeuo pipefail

readonly REPO_URL="${OCBOT_REPO_URL:-https://github.com/pkyanam/opencode-bot.git}"
readonly RELEASE_BASE="${OCBOT_RELEASE_BASE:-https://github.com/pkyanam/opencode-bot}"
readonly NODE_VERSION="${OCBOT_NODE_VERSION:-24.14.0}"
DEFAULT_INSTALL_DIR="${HOME}/.local/share/opencode-bot"
if [[ -z "${OCBOT_INSTALL_DIR:-}" && ! -d "${DEFAULT_INSTALL_DIR}/.git" ]]; then
  DEFAULT_INSTALL_DIR="${DEFAULT_INSTALL_DIR}/cloudflare"
fi
readonly INSTALL_DIR="${OCBOT_INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}"
readonly NODE_ROOT="${OCBOT_NODE_ROOT:-${HOME}/.local/share/opencode-bot-runtime/node-v${NODE_VERSION}}"
NODE_TMP=""

say() { printf '%s\n' "[opencode-bot] $*"; }
die() { printf '%s\n' "[opencode-bot] error: $*" >&2; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
OpenCode Bot installer

Usage:
  install.sh [--cloudflare|--boat] [--yes] [provider options]

With no provider flag, an interactive terminal asks which hosting target to use.
Cloudflare is the default for unattended runs. Boat options (for example
--type, --ttl, and --open) are passed to the Boat setup after the target is
chosen. Cloudflare account selection remains interactive when needed.

Environment:
  OCBOT_PROVIDER=cloudflare|boat  Select a provider without a prompt
  OCBOT_NONINTERACTIVE=1          Disable all interactive login/selection
  CLOUDFLARE_ACCOUNT_ID=...       Select a Cloudflare account in automation
  BOAT_API_KEY=...                Authenticate Boat in automation

Use --yes or OCBOT_NONINTERACTIVE=1 for automation. Secrets are read from
their provider's credential store or environment and are never printed.
EOF
}

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
  local manifest_file version commit manifest_url parsed
  manifest_file="$(mktemp "${TMPDIR:-/tmp}/opencode-bot-release.XXXXXX.json")"
  trap '[[ -n "${NODE_TMP:-}" ]] && rm -rf "$NODE_TMP"; [[ -n "${OCBOT_MANIFEST_TMP:-}" ]] && rm -f "$OCBOT_MANIFEST_TMP"' EXIT
  OCBOT_MANIFEST_TMP="$manifest_file"
  if [[ -n "${OCBOT_VERSION:-}" ]]; then
    [[ "${OCBOT_VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "OCBOT_VERSION must be a strict vSemVer tag such as v0.1.1"
    manifest_url="${RELEASE_BASE}/releases/download/${OCBOT_VERSION}/release-manifest.json"
  else
    manifest_url="${RELEASE_BASE}/releases/latest/download/release-manifest.json"
  fi
  download "$manifest_url" "$manifest_file" || die "could not download release manifest from ${manifest_url}"
  parsed="$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    try { const m=JSON.parse(readFileSync(process.argv[1], "utf8"));
      const imageOk = m.schemaVersion === 1 || (m.schemaVersion === 2 && typeof m.image?.reference === "string" && /^docker\.io\/preethamk\/opencode-bot@sha256:[0-9a-f]{64}$/i.test(m.image.reference));
      if (!imageOk || (m.schemaVersion !== 1 && m.schemaVersion !== 2) || typeof m.version !== "string" || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(m.version) || typeof m.commit !== "string" || !/^[0-9a-f]{40}$/i.test(m.commit)) process.exit(2);
      process.stdout.write(`${m.version}\t${m.commit.toLowerCase()}`);
    } catch { process.exit(2); }
  ' "$manifest_file")" || die "release manifest is invalid (expected schemaVersion 1, strict version, and 40 character commit)"
  version="${parsed%%$'\t'*}"; commit="${parsed#*$'\t'}"
  if [[ -n "${OCBOT_VERSION:-}" && "$version" != "$OCBOT_VERSION" ]]; then die "release manifest version ${version} does not match requested ${OCBOT_VERSION}"; fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    local remote expected current
    remote="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
    expected="${REPO_URL%.git}"
    [[ "${remote%.git}" == "$expected" ]] || die "${INSTALL_DIR} points to a different repository; set OCBOT_INSTALL_DIR or inspect it"
    if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
      die "${INSTALL_DIR} has local changes; commit or move them before rerunning"
    fi
    say "fetching release ${version} into existing checkout at ${INSTALL_DIR}"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "refs/tags/${version}:refs/tags/${version}" >/dev/null || die "could not fetch release ${version}"
    current="$(git -C "$INSTALL_DIR" rev-parse "refs/tags/${version}^{commit}")"
    [[ "$current" == "$commit" ]] || die "release tag ${version} does not match the release manifest commit"
    git -C "$INSTALL_DIR" checkout --detach --quiet "$commit"
  elif [[ -e "$INSTALL_DIR" ]]; then
    die "${INSTALL_DIR} exists but is not an opencode-bot checkout"
  else
    say "cloning release ${version} into ${INSTALL_DIR}"
    git clone --branch "$version" --depth 1 "$REPO_URL" "$INSTALL_DIR" >/dev/null || die "could not clone release ${version}"
    current="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
    [[ "$current" == "$commit" ]] || die "release ${version} does not match the manifest commit"
  fi
  mkdir -p "${INSTALL_DIR}/.opencode-bot"
  cp "$manifest_file" "${INSTALL_DIR}/.opencode-bot/release-manifest.json"
  chmod 600 "${INSTALL_DIR}/.opencode-bot/release-manifest.json"
  rm -f "$manifest_file"
  OCBOT_MANIFEST_TMP=""
}

tty_available() { [[ -r /dev/tty && -w /dev/tty ]]; }

configure_cloudflare() {
  local config_file="${INSTALL_DIR}/.opencode-bot/deployment-config.json" state_file="${INSTALL_DIR}/.opencode-bot/deployment-state.json"
  local name instance concurrency answer existing_name allow_rename=0
  [[ -f "scripts/setup/installer-config.mjs" ]] || die "published checkout is missing the Cloudflare installer config helper"
  mkdir -p "${INSTALL_DIR}/.opencode-bot"
  if [[ -s "$state_file" ]]; then
    existing_name="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; try { const s=JSON.parse(readFileSync(process.argv[1])); if (!s.uninstalledAt) process.stdout.write(s.workerName || ""); } catch {}' "$state_file" 2>/dev/null || true)"
  fi
  if [[ -s "$config_file" ]]; then
    name="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; try { const c=JSON.parse(readFileSync(process.argv[1])); process.stdout.write(c.name || ""); } catch {}' "$config_file" 2>/dev/null || true)"
    instance="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; try { const c=JSON.parse(readFileSync(process.argv[1])); process.stdout.write(c.instanceType || ""); } catch {}' "$config_file" 2>/dev/null || true)"
    concurrency="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; try { const c=JSON.parse(readFileSync(process.argv[1])); process.stdout.write(String(c.maxConcurrentRuns || "")); } catch {}' "$config_file" 2>/dev/null || true)"
  fi
  name="${OCBOT_DEPLOYMENT_NAME:-${name:-${existing_name:-ocbot-personal}}}"
  instance="${OCBOT_INSTANCE_TYPE:-${instance:-standard-2}}"
  concurrency="${OCBOT_MAX_CONCURRENT_RUNS:-${concurrency:-2}}"
  if [[ "${OCBOT_NONINTERACTIVE:-0}" != 1 && "$skip_picker" -eq 0 ]] && tty_available; then
    printf '%s\n' '' 'Cloudflare setup questions:' '  The Worker name becomes part of its public workers.dev URL.' >&2
    printf '%s' "Worker name [${name}]: " >/dev/tty; IFS= read -r answer </dev/tty || true; name="${answer:-$name}"
    printf '%s\n' 'Compute size: standard-1 (0.5 vCPU/4 GiB), standard-2 (1/6, recommended),' \
      '  standard-3 (2/8), or standard-4 (4/12).' >&2
    printf '%s' "Compute size [${instance}]: " >/dev/tty; IFS= read -r answer </dev/tty || true; instance="${answer:-$instance}"
    printf '%s\n' '' "Review: Worker ${name}, ${instance} compute size." 'Proceed with Cloudflare provisioning? [y/N]: ' >&2
    IFS= read -r answer </dev/tty || answer=n
    [[ -z "$answer" || "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || die 'Cloudflare provisioning cancelled'
  fi
  if [[ -s "$state_file" ]] && node --input-type=module -e 'import { readFileSync } from "node:fs"; try { process.exit(JSON.parse(readFileSync(process.argv[1])).uninstalledAt ? 0 : 1); } catch { process.exit(1); }' "$state_file"; then allow_rename=1; fi
  node --input-type=module -e 'import { readInstallerConfig, writeInstallerConfig } from "./scripts/setup/installer-config.mjs"; const [file,name,instance,runs,allowRename,liveName]=process.argv.slice(1); let current; try { current=readInstallerConfig(file); } catch {} const owned=liveName || current?.name; if (owned && owned !== name && allowRename !== "1") throw new Error(`deployment name cannot change from ${owned} for this checkout`); writeInstallerConfig(file, {...(current || {}), name, instanceType:instance, maxConcurrentRuns:Number(runs), bucketName:`${name}-artifacts`});' "$config_file" "$name" "$instance" "$concurrency" "$allow_rename" "$existing_name" || die 'invalid Cloudflare setup choices'
  printf '%s\n' "$config_file"
}

choose_provider() {
  local choice
  printf '%s\n' '' 'OpenCode Bot installer' 'Choose where to run your workspace:' \
    '  1) Cloudflare (recommended; managed deployment)' \
    '  2) Boat (preview; persistent VM, no Cloudflare account)' >&2
  printf '%s' 'Hosting provider [1]: ' >/dev/tty
  IFS= read -r choice </dev/tty || choice=1
  case "$choice" in
    2) printf 'boat' ;;
    ''|1) printf 'cloudflare' ;;
    *) die 'choose 1 for Cloudflare or 2 for Boat' ;;
  esac
}

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
  if ! OCBOT_STATE_DIR="$state_dir" node --input-type=module -e '
    import { readFileSync, writeFileSync, chmodSync } from "node:fs";
    const dir = process.env.OCBOT_STATE_DIR;
    const state = JSON.parse(readFileSync(`${dir}/deployment-state.json`, "utf8"));
    const secrets = JSON.parse(readFileSync(`${dir}/secrets.json`, "utf8"));
    if (!state.deploymentUrl || !secrets.APP_TOKEN) process.exit(0);
    const ready = async () => {
      if (process.env.OCBOT_SKIP_HANDOFF_READY === "1") return true;
      const attempts = Math.max(1, Number(process.env.OCBOT_HANDOFF_READY_ATTEMPTS || 10));
      const delayMs = Math.max(0, Number(process.env.OCBOT_HANDOFF_READY_DELAY_MS || 1000));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const url = new URL(state.deploymentUrl); url.pathname = "/"; url.searchParams.set("ocbot", String(Date.now()));
          const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" });
          const html = await response.text();
          const asset = html.match(/<script[^>]+src="(\/assets\/[^"?]+\.js)"/i)?.[1];
          const assetResponse = asset ? await fetch(new URL(asset, url), { signal: AbortSignal.timeout(5000), cache: "no-store" }) : null;
          if (response.ok && /^text\/html(?:;|$)/i.test(response.headers.get("content-type") ?? "") && /<title>OpenCode Bot<\/title>/i.test(html) && assetResponse?.ok) return true;
        } catch { /* deployment propagation is retried below */ }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return false;
    };
    // Bust a cached workers.dev shell while keeping the owner credential in
    // the fragment, where it is never sent in an HTTP request.
    const targetUrl = new URL(state.deploymentUrl); targetUrl.pathname = "/"; targetUrl.searchParams.set("ocbot", String(Date.now())); targetUrl.hash = `connect=${encodeURIComponent(secrets.APP_TOKEN)}`;
    const target = targetUrl.toString();
    const file = `${dir}/open.html`;
    writeFileSync(file, `<!doctype html><meta http-equiv="refresh" content="0;url=${target}"><a href="${target}">Open opencode-bot</a>\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    if (!(await ready())) { process.stderr.write("[opencode-bot] deployment is healthy but its web shell is not ready yet; the saved handoff can be opened again in a minute\n"); process.exit(1); }
  '; then
    say "deployment handoff saved at ${state_dir}/open.html; web assets are still propagating, so it was not opened automatically"
    return 0
  fi
  if [[ -f "${state_dir}/open.html" ]]; then
    say "opening the owner connection handoff"
    if command_exists open; then open "${state_dir}/open.html" >/dev/null 2>&1 || true
    elif command_exists xdg-open; then xdg-open "${state_dir}/open.html" >/dev/null 2>&1 || true
    else say "open ${state_dir}/open.html in a browser to finish owner connection"; fi
  fi
}

run_boat_installer() {
  local script_url="${OCBOT_BOAT_INSTALL_URL:-https://raw.githubusercontent.com/pkyanam/opencode-bot/main/scripts/boat-install.sh}"
  local tmp status arg
  say "Starting Boat setup…"
  tmp="$(mktemp "${TMPDIR:-/tmp}/opencode-bot-boat-entrypoint.XXXXXX.sh")"
  if ! download "$script_url" "$tmp"; then rm -f "$tmp"; die "could not download the Boat installer"; fi
  local -a boat_args=()
  for arg in "$@"; do [[ "$arg" == "--boat" ]] || boat_args+=("$arg"); done
  set +e
  bash "$tmp" ${boat_args[@]+"${boat_args[@]}"}
  status=$?
  set -e
  rm -f "$tmp"
  return "$status"
}

main() {
  # Supplying --yes is accepted for scripts that make authorization explicit;
  # running this installer already authorizes the declared deployment.
  local wants_boat=0 wants_cloudflare=0 skip_picker=0 arg provider="${OCBOT_PROVIDER:-}"
  for arg in "$@"; do
    case "$arg" in
      --help|-h) usage; return 0 ;;
      --boat) wants_boat=1 ;;
      --cloudflare) wants_cloudflare=1 ;;
      --yes|--non-interactive) skip_picker=1 ;;
    esac
  done
  [[ "$wants_boat" -eq 1 && "$wants_cloudflare" -eq 1 ]] && die 'choose only one provider: --cloudflare or --boat'
  [[ "$wants_boat" -eq 1 ]] && provider=boat
  [[ "$wants_cloudflare" -eq 1 ]] && provider=cloudflare
  if [[ -n "${OCBOT_PROVIDER:-}" && ( "$wants_boat" -eq 1 || "$wants_cloudflare" -eq 1 ) && "$provider" != "${OCBOT_PROVIDER}" ]]; then
    die "provider flag conflicts with OCBOT_PROVIDER=${OCBOT_PROVIDER}"
  fi
  local -a filtered_args=()
  for arg in "$@"; do
    case "$arg" in
      --boat|--cloudflare|--non-interactive) ;;
      --yes) [[ "$wants_boat" -eq 1 ]] && filtered_args+=("$arg") ;;
      *) filtered_args+=("$arg") ;;
    esac
  done
  set -- ${filtered_args[@]+"${filtered_args[@]}"}
  case "$provider" in ""|cloudflare|boat) ;; *) die 'OCBOT_PROVIDER must be cloudflare or boat' ;; esac
  if [[ "$skip_picker" -eq 0 && -z "$provider" && "${OCBOT_NONINTERACTIVE:-0}" != 1 && "$wants_boat" -eq 0 ]] && tty_available; then provider="$(choose_provider)"; fi
  if [[ "$provider" == "boat" ]]; then
    [[ "$skip_picker" -eq 1 || "${OCBOT_NONINTERACTIVE:-0}" == 1 ]] && export OCBOT_NONINTERACTIVE=1
    run_boat_installer "$@"; return;
  fi
  ensure_node
  ensure_git
  checkout_repo
  cd "$INSTALL_DIR"
  say "installing locked dependencies"
  npm ci
  ensure_cloudflare_auth
  choose_cloudflare_account
  cloudflare_config="$(configure_cloudflare)"
  say "applying the deployment"
  ./setup.sh apply --apply --install-missing --config "$cloudflare_config"
  open_onboarding
  say "installed successfully at ${INSTALL_DIR}"
}

main "$@"
