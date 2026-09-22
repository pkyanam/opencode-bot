#!/usr/bin/env bash
set -euo pipefail
# Boat's desktop belongs to its native user. Grant only our local service user
# access; never disable X11 authentication for other users or network clients.
for attempt in $(seq 1 60); do
  if runuser -u user -- env DISPLAY=:0 XAUTHORITY=/home/user/.Xauthority xhost +SI:localuser:opencode-bot >/dev/null 2>&1; then exit 0; fi
  sleep 1
done
printf 'Boat desktop is not ready; retry after its display service starts.\n' >&2
exit 1
