# Releases

GitHub Actions builds and smoke-tests the `linux/amd64` computer image, then
publishes it to Docker Hub as `docker.io/preethamk/opencode-bot`. Cloudflare can
pull this public image directly, so normal installs do not download a multi-
gigabyte archive or require a local Docker daemon.

## Release contract

Each release contains:

- A public Docker Hub image tagged with the release version and full source
  commit. Deployments use the immutable digest reference.
- `release-manifest.json`, with schema version 2, the exact source commit,
  runtime versions, platform, and `image.reference`.
- `SHA256SUMS` for the manifest asset.

The workflow requires the repository secret `DOCKERHUB_TOKEN` and the optional
repository variable `DOCKERHUB_USERNAME` (default `preethamk`). The token is
used only in the image publishing job and is never available to pull requests.

## Publish

1. Merge the intended changes to `main` and wait for CI.
2. Update the application version and commit it.
3. Push a matching version tag, for example `git tag v0.1.2 && git push origin v0.1.2`.
4. Watch the Release workflow. It verifies the app, builds and smoke-tests the
   image, pushes both the version and commit tags, resolves the public digest,
   and publishes a GitHub Release only after the manifest is ready.

Published release versions are immutable. Re-running a failed workflow may
complete an unpublished draft; a published release cannot be replaced.

Normal CI remains read-only. Release jobs run only for repository version tags
or an explicit maintainer dispatch, not for pull requests.
