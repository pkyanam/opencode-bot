# Chat attachments

Use the paperclip, drop files on the composer, or paste an image. Telegram accepts
photos and documents with an optional caption. All clients use the same canonical
attachment IDs, and queued/mid-turn messages retain their attachments.

- Maximum: eight files, 10 MiB each, 20 MiB total per message.
- Images go through OpenCode's native file prompt inputs. Vision depends on the
  selected model. Other files are available for its file tools.
- Uploads reside in the Cloudflare Computer's shared workspace. Checkpoint the
  computer to preserve them; database metadata alone is not a file backup.
- Transfer to additional owned computer nodes is not implemented yet. Those
  conversations reject attachments explicitly instead of sending inaccessible paths.
- Telegram albums currently arrive as individual messages/files; album grouping
  and outgoing generated-file delivery are separate future work.

## HTTP clients

1. `POST /api/uploads` using bearer authentication and multipart field `file`.
2. Keep the response's `attachment.id`.
3. `POST /api/runs` with `threadId`, `prompt`, `idempotencyKey`, and
   `attachments: [{"id":"att_..."}]`. Reuse that idempotency key only when retrying
   the same submission. An omitted prompt becomes “Review the attached file.”
4. `GET /api/uploads/:id` downloads the file with the same bearer credential.

The server ignores client-supplied paths/metadata and resolves each ID itself.
MCP clients can use `upload_file`, `run_start`, and `attachment_read` instead.
