#!/usr/bin/env bash
set -euo pipefail
tag=${1:?release tag is required}
expected_commit=${2:?expected commit is required}
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "invalid release tag: $tag" >&2; exit 1; }
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "commit must be full SHA" >&2; exit 1; }
package_version=$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")
[[ "$tag" == "v$package_version" ]] || { echo "release tag $tag does not match package version v$package_version" >&2; exit 1; }
actual_commit=$(git rev-parse HEAD)
tag_commit=$(git rev-parse "refs/tags/$tag^{commit}")
[[ "$actual_commit" == "$expected_commit" ]] || { echo "HEAD does not match expected commit" >&2; exit 1; }
[[ "$tag_commit" == "$expected_commit" ]] || { echo "tag does not point at expected commit" >&2; exit 1; }
main_ref=refs/remotes/origin/main
git show-ref --verify --quiet "$main_ref" || main_ref=refs/heads/main
git show-ref --verify --quiet "$main_ref" && git merge-base --is-ancestor "$expected_commit" "$main_ref" || {
  echo "release commit is not descended from main" >&2
  exit 1
}
printf '%s\n' "$actual_commit"
