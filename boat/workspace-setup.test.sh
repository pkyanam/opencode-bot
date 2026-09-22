#!/usr/bin/env bash
set -Eeuo pipefail

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
workspace=$root/workspace
persistent=$root/persistent
mkdir -p "$workspace/shared" "$workspace/browser" "$persistent/workspace" "$persistent/browser"
printf 'shared-data\n' > "$workspace/shared/data.txt"
printf 'browser-data\n' > "$workspace/browser/data.txt"

run_setup() {
  WORKSPACE_ROOT="$workspace" PERSISTENT_ROOT="$persistent" WORKSPACE_OWNER="$(id -un):$(id -gn)" \
    bash boat/workspace-setup.sh
}

run_setup
[[ -L "$workspace/shared" && "$(readlink "$workspace/shared")" == "$persistent/workspace" ]]
[[ $(cat "$workspace/shared/data.txt") == shared-data ]]
[[ -L "$workspace/browser" && -f "$workspace/browser/data.txt" ]]
run_setup

rm "$workspace/shared"
ln -s "$root/wrong" "$workspace/shared"
if run_setup; then echo 'wrong symlink was accepted' >&2; exit 1; fi
rm "$workspace/shared"
mkdir "$workspace/shared"
printf 'original\n' > "$workspace/shared/original.txt"

fakebin=$root/bin
mkdir "$fakebin"
cat > "$fakebin/cp" <<'EOF'
#!/bin/sh
if [ "${FAIL_CP:-}" = 1 ]; then exit 77; fi
exec /bin/cp "$@"
EOF
cat > "$fakebin/ln" <<'EOF'
#!/bin/sh
case "${FAIL_LN:-}" in
  1) case " $* " in *" $WORKSPACE_ROOT/shared "*) exit 78;; esac;;
esac
exec /bin/ln "$@"
EOF
chmod +x "$fakebin/cp" "$fakebin/ln"
if PATH="$fakebin:$PATH" FAIL_CP=1 run_setup; then echo 'copy failure was accepted' >&2; exit 1; fi
[[ -d "$workspace/shared" && -f "$workspace/shared/original.txt" ]]
if PATH="$fakebin:$PATH" FAIL_LN=1 run_setup; then echo 'link failure was accepted' >&2; exit 1; fi
[[ -d "$workspace/shared" && -f "$workspace/shared/original.txt" ]]

echo 'workspace setup tests passed'
