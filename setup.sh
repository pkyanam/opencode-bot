#!/usr/bin/env sh
set -eu
exec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/scripts/setup.mjs" "$@"
