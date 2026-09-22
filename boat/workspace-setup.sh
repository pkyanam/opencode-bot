#!/usr/bin/env bash
set -Eeuo pipefail

workspace_root=${WORKSPACE_ROOT:-/workspace}
persistent_root=${PERSISTENT_ROOT:-/var/lib/opencode-bot}
workspace_owner=${WORKSPACE_OWNER:-opencode-bot:opencode-bot}
owner_user=${workspace_owner%%:*}
owner_group=${workspace_owner##*:}

install -d -m 0755 "$workspace_root"
install -d -o "$owner_user" -g "$owner_group" -m 0755 \
  "$persistent_root/workspace" "$persistent_root/browser"

link_workspace() {
  local name=$1 destination=$2 path="$workspace_root/$1" staging

  if [[ -L "$path" ]]; then
    [[ "$(readlink "$path")" == "$destination" ]] || {
      printf 'unexpected workspace symlink: %s\n' "$path" >&2
      return 1
    }
  elif [[ -e "$path" ]]; then
    [[ -d "$path" ]] || {
      printf 'unexpected workspace entry: %s\n' "$path" >&2
      return 1
    }
    # Stage the copy first. The original remains in place if either copy fails.
    staging=$(mktemp -d "$destination/.migration.XXXXXX")
    cp -a "$path"/. "$staging"/
    cp -a "$staging"/. "$destination"/
    rm -rf "$staging"
    local backup="${path}.migration-backup.$$"
    [[ ! -e "$backup" && ! -L "$backup" ]] || {
      printf 'unexpected migration backup: %s\n' "$backup" >&2
      return 1
    }
    mv "$path" "$backup"
    if ln -s "$destination" "$path" && [[ "$(readlink "$path")" == "$destination" ]]; then
      rm -rf "$backup"
    else
      rm -f "$path"
      mv "$backup" "$path"
      return 1
    fi
  else
    ln -s "$destination" "$path"
  fi

  chown -R "$workspace_owner" "$destination"
}

link_workspace shared "$persistent_root/workspace"
link_workspace browser "$persistent_root/browser"
