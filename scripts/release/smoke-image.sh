#!/usr/bin/env bash
set -euo pipefail
image=${1:?image reference is required}
expected_opencode=${2:-2.0.11}
expected_sandbox=${3:-0.12.9}
entrypoint=$(docker inspect --format '{{json .Config.Entrypoint}}' "$image")
[[ "$entrypoint" == *"/container-server"* ]] || { echo "Sandbox entrypoint missing: $entrypoint" >&2; exit 1; }
docker run --rm --entrypoint /bin/sh "$image" -ceu '
  stage() { echo "[desktop-smoke] $1"; }
  stage "checking runtime versions"
  node_version=$(node -p "process.versions.node")
  node_major=${node_version%%.*}
  test "$node_major" -ge 24
  command -v opencode >/dev/null
  opencode --version | grep -F "'"$expected_opencode"'" >/dev/null
  stage "checking Playwright browser"
  test -x /opt/opencode-bot/runner/node_modules/.bin/playwright-mcp
  browser=$(find /opt/ms-playwright -type f -path "*/chrome-linux64/chrome" -perm -111 -print -quit)
  test -n "$browser" && test -x "$browser"
  stage "checking headless Chromium"
  xvfb-run -a "$browser" --headless --no-sandbox --disable-dev-shm-usage --dump-dom about:blank >/dev/null
  stage "running headed desktop controls"
  node /opt/opencode-bot/runner/smoke-desktop.mjs
  stage "checking workspace directories"
  test -d /workspace/state && test -d /workspace/shared && test -d /workspace/browser
  printf "node=%s opencode=%s sandbox=%s browser=%s\n" "$node_version" "$(opencode --version | head -n1)" "'"$expected_sandbox"'" "$browser"
'
