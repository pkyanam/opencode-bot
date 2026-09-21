# Chat attachments

Use the paperclip, drop files on the web composer, or use **Take photo**, **Choose
photo**, or **Choose file** from the mobile composer. Telegram accepts photos and
documents with an optional caption. All clients use the same canonical attachment
IDs, and queued/mid-turn messages retain their attachments.

- Maximum: eight files, 10 MiB each, 20 MiB total per message.
- Images go through OpenCode's native file prompt inputs. Vision depends on the
  selected model. Other files are available for its file tools.
- Uploads reside in the Cloudflare Computer's shared workspace. Checkpoint the
  computer to preserve them; database metadata alone is not a file backup.
- Chat attachments currently use the shared Cloudflare Computer; chat attachments on additional nodes are not supported yet. The Workspace → Files
  explorer can also upload files into the shared workspace and manage folders;
  these are separate from the attachment chips on a message.
- Telegram albums currently arrive as individual messages/files; album grouping
  and outgoing generated-file delivery are separate future work.

## HTTP clients

1. `POST /api/uploads` using bearer authentication and multipart field `file`.
2. Keep the response's `attachment.id`.
3. `POST /api/runs` with `threadId`, `prompt`, `idempotencyKey`, and
   `attachments: [{"id":"att_..."}]`. Reuse that idempotency key only when retrying
   the same submission. An omitted prompt becomes “Review the attached file.”
4. `GET /api/uploads/:id` downloads the file with the same bearer credential.

For workspace files, use `GET /api/files?path=...` to list a folder,
`GET /api/files/content?path=...` to read or download a file, `POST /api/files`
with a `?path=...` query and raw file bytes to upload, `POST /api/files/mkdir?path=...` to create a folder,
`POST /api/files/move?from=...&to=...` to rename or move, and
`DELETE /api/files?path=...` to remove an item. Paths are server-resolved and
cannot escape the computer workspace. The web explorer supports upload,
download, search, breadcrumbs, sorting, and text previews. Mobile supports
upload, folder creation, image/text previews, rename, delete, and authenticated
downloads through the native save/share sheet.

The server ignores client-supplied paths/metadata and resolves each ID itself.
MCP clients can use `upload_file`, `run_start`, and `attachment_read` instead.
