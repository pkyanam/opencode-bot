#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=${OPENCODE_ROOT:-/opt/opencode-bot}
DATA=${HINDSIGHT_DATA_DIR:-/var/lib/opencode-bot/hindsight}
ETC=${OPENCODE_ETC:-/etc/opencode-bot}
VENV="$ROOT/hindsight-venv"
fail(){ printf 'Hindsight bootstrap failed: %s\n' "$1" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || fail 'run as root (the script creates a system service and unprivileged account)'
UV_BIN="${UV_BIN:-$(command -v uv 2>/dev/null || true)}"
if [[ -z "$UV_BIN" && -x /root/.local/bin/uv ]]; then UV_BIN=/root/.local/bin/uv; fi
if [[ -z "$UV_BIN" ]]; then for candidate in /home/*/.local/bin/uv; do [[ -x "$candidate" ]] && { UV_BIN="$candidate"; break; }; done; fi
[[ -n "$UV_BIN" ]] || fail 'uv is required; install it for the bootstrap user before running this script'
command -v systemctl >/dev/null 2>&1 || fail 'systemd is required'
[[ -x "$ROOT/node/bin/node" ]] || fail 'Boat Node 24 runtime is missing; run the main Boat bootstrap first'
[[ -f "$ROOT/releases/current/boat/hindsight-start.mjs" ]] || fail 'release does not contain hindsight-start.mjs'

id opencode-bot >/dev/null 2>&1 || useradd --system --home-dir /var/lib/opencode-bot --shell /usr/sbin/nologin opencode-bot
install -d -o opencode-bot -g opencode-bot -m 0700 "$DATA" "$DATA/pg0" "$ETC"
# The runtime is code, not workspace data. Never execute an interpreter that
# the bot service can replace when this installer runs as root.
if [[ -e "$VENV" && "$(stat -c %u "$VENV")" != 0 ]]; then rm -rf "$VENV"; fi
[[ -x "$VENV/bin/python" ]] || "$UV_BIN" venv --python 3.12 "$VENV"
"$UV_BIN" pip install --python "$VENV/bin/python" 'hindsight-api-slim[embedded-db,local-onnx]==0.10.1' 'flashrank==0.2.10'

# Reuse image-baked model caches when available. Download only missing caches;
# these paths are shared read-only by the unprivileged Hindsight process.
install -d -m 0755 /opt/huggingface /opt/flashrank
if [[ ! -f /opt/huggingface/intfloat-multilingual-e5-small/onnx/model.onnx ]]; then
  HF_HOME=/opt/huggingface "$VENV/bin/python" -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='intfloat/multilingual-e5-small', local_dir='/opt/huggingface/intfloat-multilingual-e5-small', allow_patterns=['onnx/model.onnx','*.json','tokenizer*','sentencepiece.bpe.model'])"
fi
if [[ ! -d /opt/flashrank/ms-marco-MiniLM-L-12-v2 ]]; then
  HF_HOME=/opt/huggingface "$VENV/bin/python" -c "from flashrank import Ranker; Ranker(model_name='ms-marco-MiniLM-L-12-v2', cache_dir='/opt/flashrank')"
fi
chown -R opencode-bot:opencode-bot "$DATA"
chown -R root:root "$VENV"
chmod -R a+rX "$VENV"
chmod -R a+rX /opt/huggingface /opt/flashrank
if [[ ! -s "$ETC/hindsight-token" ]]; then umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$ETC/hindsight-token"; printf '\n' >> "$ETC/hindsight-token"; fi
chown opencode-bot:opencode-bot "$ETC/hindsight-token"; chmod 0600 "$ETC/hindsight-token"
install -m 0644 "$ROOT/releases/current/boat/opencode-bot-hindsight.service" /etc/systemd/system/opencode-bot-hindsight.service
systemctl daemon-reload
systemctl enable opencode-bot-hindsight.service
systemctl restart opencode-bot-hindsight.service
printf 'Hindsight service installed; provider configuration remains optional and explicit.\n'
