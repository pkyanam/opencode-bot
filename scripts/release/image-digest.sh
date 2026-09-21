#!/usr/bin/env bash
set -euo pipefail
metadata=${1:?buildx metadata file is required}
test -s "$metadata"
digest=$(node -e '
const fs = require("fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))["containerimage.digest"];
if (typeof value !== "string") process.exit(2);
process.stdout.write(value);
' "$metadata")
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "missing image manifest digest: $digest" >&2; exit 1; }
printf '%s\n' "$digest"
