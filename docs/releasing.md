# Releases without local Docker

GitHub Actions builds the computer. Installers download and verify that build,
then upload it to the owner's Cloudflare registry using short-lived credentials.
No Docker Hub account, registry password, or local Docker daemon is needed.

## Release contract

A release contains:

- `computer-image.tar.gz`: the Linux amd64 computer, exported as a Docker image
  archive. Docker is the archive format; opening it does not require Docker.
- `release-manifest.json`: version, exact source commit, runtime versions,
  platform, and the archive's byte count and SHA-256.
- `SHA256SUMS`: checksums for the downloadable assets.

The installer resolves a published release, checks out the corresponding commit,
verifies and decompresses the archive, and uses a pinned `crane` binary to push it into the user's
Cloudflare account. Allow roughly 8 GB of temporary free disk space for the
image download and unpacking. Wrangler generates temporary registry credentials; they
are kept out of logs and removed after the upload. The Worker deployment uses
an image digest, never a mutable `latest` image tag.

## Publish

1. Merge the intended changes to `main` and wait for CI.
2. Update the application version and commit it.
3. Push a matching version tag, for example `git tag v0.1.1 && git push origin v0.1.1`.
4. Watch the Release workflow. It verifies the app, builds and smoke-tests the
   image, prepares the assets, and publishes the release only after success.

A failed build must not become the installer's default release. Published
release versions are immutable: ship a new version rather than replacing an
existing archive under the same tag. Re-running a failed workflow may complete
an unpublished draft.

Normal CI remains read-only. Release jobs run only for repository version tags
or an explicit maintainer dispatch, not for pull requests. Publishing uses the
repository's scoped GitHub token; no user Cloudflare credentials live in CI.

## Development

`npm run preview:worker` still requires Docker to run a local computer. That is
separate from deploying a release. Keep local Dockerfile changes covered by the
release smoke test so image dependencies and browser startup are checked before
publication.

Cloudflare does not pull GHCR images directly. The managed-registry copy avoids
that limitation without adding a Docker Hub publishing account. References:
[Cloudflare image management](https://developers.cloudflare.com/containers/guides/image-management/),
[temporary registry credentials](https://developers.cloudflare.com/workers/wrangler/commands/containers/),
and [crane](https://github.com/google/go-containerregistry/tree/v0.20.7/cmd/crane).
