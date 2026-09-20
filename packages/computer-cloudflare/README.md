# Cloudflare computer provider

`CloudflareComputerProvider` owns a Cloudflare Sandbox and starts the image's
runner on the private container port. The adapter never exposes that port to a
browser: callers receive a lease-scoped `RunnerTransport` that adds the bearer
token and generation fence to every request.

The package pins `@cloudflare/sandbox` to `0.12.9`. It intentionally does not
use `@cloudflare/sandbox/opencode`; that convenience module imports the old V1
OpenCode SDK. OpenCode 2 remains behind the runner process, where the runtime
version can be pinned and probed independently.

The Sandbox working disk is ephemeral. By default `checkpoint()` returns an
explicit unsupported manifest. To enable application-owned R2 checkpoints,
configure `checkpointBucket` and make the runner implement:

```text
POST /checkpoint/quiesce  ->  2xx only after writers are at a safe boundary
POST /checkpoint/resume   ->  best-effort release of the barrier
```

The provider archives configured paths only between those calls, verifies a
SHA-256 checksum, and commits an immutable R2 object. This is a workspace
archive; it does not resurrect an in-flight process or silently replay an
ambiguous external action.

The provider reports `desktop: false` and `browser: false` until the image and
desktop broker are qualified. A future computer implementation can satisfy the
same contract without changing the coordinator.
