#!/usr/bin/env bash
# Boat can hydrate /etc after systemd has already reached multi-user.target.
# Recover enabled services once per boot; never undo an intentional later stop.
set -euo pipefail
marker="${OCBOT_RESUME_MARKER:-/run/opencode-bot-resume-complete}"
[[ -e "$marker" ]] && exit 0
command -v systemctl >/dev/null || exit 0
systemctl is-enabled --quiet opencode-bot.service || exit 0
# The release updater owns service lifecycle while it is applying an update.
if systemctl is-active --quiet opencode-bot-updater.service; then exit 0; fi
systemctl daemon-reload
for unit in opencode-bot-hindsight.service opencode-bot-updater.path opencode-bot.service; do
  if systemctl is-enabled --quiet "$unit"; then systemctl start --no-block "$unit"; fi
done
if systemctl is-active --quiet opencode-bot.service; then
  touch "$marker"
fi
