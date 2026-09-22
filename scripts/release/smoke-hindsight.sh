#!/usr/bin/env bash
set -euo pipefail
image=${1:?image reference is required}
name="opencode-hindsight-smoke-${RANDOM}"
# Readiness verifies the real database, migrations and baked CPU models. Actual
# retain/recall/reflect tests use a separately authenticated live model service.
docker run --rm -d --name "$name" --cpus=2 --memory=3g \
  -e RUNNER_TOKEN=release-memory-smoke --entrypoint node "$image" \
  /opt/opencode-bot/runner/hindsight-service.mjs >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
for attempt in $(seq 1 30); do
  if docker exec "$name" curl --fail --silent http://127.0.0.1:8790/live >/dev/null; then break; fi
  sleep 1
done
docker exec "$name" curl --fail --silent -X POST http://127.0.0.1:8790/configure \
  -H 'Authorization: Bearer release-memory-smoke' -H 'Content-Type: application/json' \
  --data '{"llmBaseUrl":"http://127.0.0.1:9/v1","llmApiKey":"readiness-only","llmModel":"readiness-only"}' >/dev/null
for attempt in $(seq 1 90); do
  if docker exec "$name" curl --fail --silent http://127.0.0.1:8790/health \
      -H 'Authorization: Bearer release-memory-smoke'; then
    echo 'Hindsight database and models are ready'
    exit 0
  fi
  sleep 2
done
docker logs --tail 100 "$name"
exit 1
