# Node transfer protocol

Version one uses the existing control Worker as an R2 relay. This works for
home nodes behind NAT and keeps the node agent outbound-only. Direct peer
transport can be added later while retaining the manifest and token contract.

The Workspace integration should:

1. Authenticate the node bearer with `NodeRegistry.authenticate`.
2. Validate that the authenticated node is the manifest's source or target,
   depending on operation, and enqueue a durable `node.transfer` job containing
   the manifest and token. A transfer token alone is not a node credential.
3. Create a manifest with `createTransferManifest`, persist it with the run/job
   receipt, and issue an upload token for the source and a download token for
   the target. Use the idempotency key in the surrounding Workspace record so
   retries return the same manifest rather than creating another object.
4. Route `PUT /api/transfers/:id/content` to `protocol.put` and
   `GET /api/transfers/:id/content` to `protocol.get`. Pass `Request.body`
   through as a stream; do not parse JSON or base64 encode file bytes.
5. Delete the R2 object after expiry or an explicit terminal cleanup. A token
   is rejected after expiry even if cleanup has not run.

The node agent remains responsible for resolving `sourcePath` and
`targetPath` under its configured workspace root and refusing symlink/path
escape. The Worker never receives an arbitrary filesystem path and this module
does not fetch arbitrary URLs. `sha256`, size, node ids, expiry, and transfer id
are copied into R2 custom metadata; downloads reject an object whose metadata
does not match the manifest.

The protocol supports ranged downloads through `downloadRequest` and the
`range` argument to `protocol.get`. The range is checked against the manifest
size before R2 access, which enables retries without replaying a full object.
