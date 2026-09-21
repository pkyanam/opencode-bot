# Expo mobile client

Status: native preview in `apps/mobile`, with the remaining roadmap identified below.

The client is a small Expo Router app that talks to the existing
opencode-bot control Worker. It should use the Worker’s `/api` contract as its
only product backend. It must not copy the chat-template’s server route or its
direct Anthropic integration (`src/app/api/chat+api.ts`); model execution,
computer access, run state, approvals, and credentials remain behind the
control API.

## Evidence and reusable reference

The upstream reference was read from `EvanBacon/chat-template` at commit
[`40379fcbc8d57025e09eef77ae129b7b30b100c7`](https://github.com/EvanBacon/chat-template/tree/40379fcbc8d57025e09eef77ae129b7b30b100c7),
committed 2026-06-18. Its `Conversation` uses `@legendapp/list` with an
estimated item size and maintain-visible-position behavior; its streaming
message is isolated behind `useSyncExternalStore`; and its mock stream batches
updates at 32 ms (about 30 FPS). These are useful UI patterns, not backend
contracts to import wholesale.

Reuse the following ideas or components after checking their license and
platform fit:

- `src/components/chat/conversation.tsx`: virtualized, keyboard-aware message
  layout and scroll-to-bottom behavior.
- `src/components/chat/streaming-store.ts` and
  `src/components/chat/streaming-message.tsx`: keep token churn confined to the
  active assistant row.
- `src/app/index.tsx`: 32 ms stream update throttle and a stable message list
  mapping.
- `src/components/markdown/`: native markdown, code blocks, tables, images,
  and link handling through React Native `Linking`.
- Expo Router file routes and platform-specific files for native drawer versus
  web sidebar behavior.

The reference README currently targets Expo SDK 55 and `@legendapp/list`; this
mobile app uses the current stable Expo SDK 57 line (`expo@57.0.24`, React
Native 0.86) and runs `expo install` compatibility checks after dependency
changes.

## Control API boundary

The Worker authenticates normal `/api` calls with the application bearer token.
The mobile transport should expose one typed request layer that adds
`Authorization: Bearer <device token>`, applies request timeouts, parses the
standard `{ error }` failures, and treats 401 as a re-pair/re-enter-token
state.

| Mobile capability | Existing endpoint(s) | Adapter behavior |
| --- | --- | --- |
| Initial dashboard | `GET /api/state` | Load bots, threads, runs, and pending messages together. |
| Bots and threads | `GET/POST/PATCH/DELETE /api/bots`, `GET/POST/PATCH/DELETE /api/threads` | Keep optimistic UI limited to rename/delete; reconcile with state. |
| Send a prompt | `POST /api/runs` with `threadId`, `prompt`, `idempotencyKey` | Generate a UUID-like idempotency key per user submission and persist it until acknowledged. |
| Run status | `GET /api/runs`, `GET /api/runs/:id` | Poll active runs with backoff; stop polling terminal runs. |
| Run events | `GET /api/runs/:id/events` | Current endpoint returns a JSON event array, not an SSE stream. Treat sequence as the cursor and deduplicate by `(runId, sequence)`. |
| Cancel | `POST /api/runs/:id/cancel` | Disable duplicate taps while request is in flight. |
| Approval | `POST /api/runs/:id/approval` with `requestId`, `decision` | Show the action, target, command, details, and expiry from `pendingApproval`; never auto-approve on reconnect. |
| Native transcript | `GET /api/threads/:id/messages` | Use for computer-backed threads. Owned-node threads explicitly do not support native browsing yet. |
| Chat attachments | `POST /api/uploads` multipart field `file`, then `POST /api/runs` with `attachments: [{id}]` | Pick images/documents with native pickers; upload before submission. Preserve IDs across queued messages and retries. Up to eight files, 10 MiB each. |
| Artifacts | `GET /api/files?path=...`, `GET /api/files/content?path=...` | List bounded workspace paths, then download through an authenticated stream. Current runner limits uploads to 10 MB and downloads to 50 MB. |
| Computer readiness | `GET /api/computer/readiness`, `GET /api/computer/status` | Gate catalog, providers, terminal, and preview screens while the computer is starting. |
| Live preview | `GET /api/computer/preview` | The current response is a multipart JPEG stream. A native image/stream adapter is needed; this is not a normal JSON or static image endpoint. |
| Model/provider catalog | `GET /api/catalog`, `GET /api/providers` | Cache briefly and retry on `computer_starting`; do not store provider keys in the app. |

The current Worker also exposes provider configuration, skills, routines,
extensions, checkpoints, terminal, and node pairing routes. They should be
added as separate mobile screens only after the core run/transcript flow is
stable. Native terminal access is a web-oriented feature and should initially
be omitted from the mobile navigation.

## Pairing and credential storage

Use device pairing, which is separate from computer-node registration:

1. On the owner browser, **Settings → Devices → Pair a device** creates a
   five-minute, single-use invitation. The QR contains an exchange secret in
   the URL fragment, not the durable owner credential.
2. Exchange its `secret` (or the displayed `code`) at
   `POST /api/pairing/redeem` with `deviceName` and `clientType: "expo"`.
3. Save the returned `deviceToken` and send it as the bearer token. The owner
   can revoke this device independently; a 401 returns the client to pairing.

Paired devices are trusted workspace clients: they can use bots and the shared
computer. Administrative provider, deployment, Telegram, and node settings stay
owner-only. This is not isolation for untrusted guests: bot tools can access the
shared computer. `POST /api/nodes/pairing` enrolls a computer and must never be
used as phone login.

Store the resulting small token in `expo-secure-store`, with an in-memory copy
for active requests and an explicit “disconnect” action that deletes it. Expo
documents SecureStore as encrypted key-value storage intended for small secrets;
large values can fail on some platform versions, so store only the token and
small metadata. See [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/).
The token should not be in `EXPO_PUBLIC_*` configuration, logs, crash payloads,
or deep-link analytics.

After redeeming the current pairing flow, call `GET /api/pairing/session/me` to
display the authenticated role and device identity returned by the Worker.
Use that response to hide unavailable controls, while still relying on each
request’s server-side authorization. A paired-client token must remain scoped
to its allowed workspace and must never be replaced with the owner `APP_TOKEN`.

Use Expo Router plus `expo-linking` to receive a short-lived pairing URL or
code. Parse and validate the expected scheme, host, and expiry before exchanging
it, then remove sensitive query data from navigation state. Expo recommends
development builds for reliable linking tests; custom schemes require a new
development build. See [Expo linking overview](https://docs.expo.dev/linking/overview/),
[Expo Linking API](https://docs.expo.dev/versions/latest/sdk/linking/), and
[linking into an app](https://docs.expo.dev/linking/into-your-app/).

## Reconnect, polling, and event adapters

Build the data layer around an adapter rather than coupling screens to HTTP:

```text
ControlApiTransport (Bearer request, timeout, retry classification)
        ↓
RunRepository (state/run/event cursors, idempotency, cache)
        ↓
Chat view model (messages, active run, approval, connection state)
```

On app foreground, token change, or network recovery, fetch `/api/state`, then
refresh each active run and its event array. Poll active runs at roughly 2–4
seconds with jitter and exponential backoff when the request fails; use a
shorter first retry for a pending approval. Merge events by sequence so a
replayed response cannot duplicate tool activity. Since `/api/runs/:id/events`
is currently a snapshot JSON endpoint, an eventual SSE endpoint can be added
behind the same `RunEventSource` interface without changing UI components.

Treat `computer_starting`/503 as a recoverable readiness state, 401 as a
credential state, 409 as a user-visible busy/maintenance state, and network
timeouts as disconnected. Preserve the last confirmed transcript while
reconnecting. Refresh approval state after reconnect and require a new user
tap for any decision.

The chat-template’s 32 ms throttle is appropriate for rendering a rapidly
changing active assistant message. Apply it after event normalization, keep
the canonical event/run state at full fidelity, and update only the streaming
row through a small external store. Virtualize long transcripts with Legend
List or FlatList, use stable message IDs, and bound artifact/event history in
memory even when the server returns up to 100 runs.

## Mobile feature scope and limitations

The first useful native slice is: connect, browse bots/threads, send a run,
watch status and public events, read the transcript, cancel, respond to an
approval, and browse/download artifacts. It can show tool names, bounded input
and output previews, retry/reconnect notices, and sanitized errors using the
same public fields as the web client. It should never render private reasoning
or credential-bearing provider payloads.

Live computer preview is possible in principle but needs a native multipart
JPEG decoder/viewer and lifecycle handling for backgrounding. It will consume
bandwidth and should be paused when the screen is hidden. Native OpenCode
terminal attachment is currently unsuitable for the first mobile release, and
owned-node threads cannot use native message browsing until the runner reports
a result. Large or binary artifacts should open through a bounded download and
the platform share sheet, not be loaded into the transcript.

Push notifications are a later enhancement: the current API has polling and
run snapshots but no mobile push registration or notification delivery
contract. Until that contract exists, background polling should be conservative
and foreground-driven; do not claim realtime delivery while the transport is
snapshot polling.

## Delivery sequence

1. Add a separate Expo app/package with typed `ControlApiTransport`, SecureStore
   credential lifecycle, and deep-link parsing.
2. Implement state/thread/run repositories and a polling event adapter with
   deterministic reconnect tests.
3. Build the virtualized transcript using the chat-template’s list and isolated
   streaming-row patterns, adapted to `Message`, `ToolPart`, and `RunEvent`.
4. Add approval, cancellation, and artifact screens; test expiry, duplicate
   events, offline transitions, and 401/409/503 responses.
5. Evaluate preview and notifications against native platform constraints
   before adding either to the default navigation.

## First native slice (implemented)

The first Expo Router slice now lives in `apps/mobile`. It includes:

- Expo Router routes for pairing, workspace threads, and a conversation view.
- SecureStore backed device-token storage; the owner token is never required by
  the phone client.
- Pairing by QR fragment secret or human code against `/api/pairing/redeem`.
- State/thread creation, public transcript loading, run submission with an
  idempotency key, run/event polling, cancellation, approval decisions, and
  bounded public tool activity.
- A restrained dark OpenCode palette with a thread list and readable composer.

The app intentionally leaves live computer preview, native terminal, and push
notifications for a later slice. The current composer has a native document
picker, uploads selected files through `/api/uploads`, shows removable chips,
and includes uploaded IDs in the run request. The picker is intentionally
bounded to eight files and 10 MiB per file; image preview and share-sheet
download remain later polish.

The visual direction follows the referenced `EvanBacon/chat-template` patterns:
Expo Router file routes, a stable message list, isolated active-run updates,
and explicit scrollable transcript space. The template's direct model route is
not used; all execution remains behind this repository's control Worker. Grok's
official mobile documentation describes the same useful shape of a shared bot
list, per-conversation chat, file/photo input, and explicit computer approval;
those cues informed the simple home/thread/composer hierarchy here. The
official docs do not provide a reusable public design system or source assets,
so no Grok branding or copied screens are included.

Verification completed locally with `npm install`, Expo dependency checks,
`npm run typecheck`, and `npx expo export --platform ios` plus
`npx expo export --platform android`. A signed iOS Release build has also been installed over Wi-Fi on a physical
iPhone. The corrected build launched successfully and retained the same process across
checks more than 20 seconds apart. End-to-end pairing, camera permissions, and
document-picker testing are pending; Android has only bundle verification. The root web typecheck excludes `apps/mobile/**`;
the app has its own `typecheck` script.

The iOS configuration enables Expo's scene lifecycle support for builds made
with Xcode 27. Without it, iOS 27 terminates the app during launch. See
[Expo's scene lifecycle migration guide](https://github.com/expo/fyi/blob/main/ios-scene-lifecycle.md).

## Native preview: current screens

The mobile shell uses the web client's charcoal/ivory theme and wordmark, with
fixed Chats, Bots, Workspace, and Settings navigation. Empty workspaces can
create a bot and their first conversation. Bot settings support name, model
selection, instructions, and deletion; conversations support rename/deletion.
Workspace exposes skill instructions, folder browsing and small text-file
previews, computer status/checkpoints, and routine pause/resume controls.

Workspace state refreshes every five seconds while foregrounded and immediately
on return to the app. Conversation polling uses three seconds during active
work and five seconds otherwise. Background requests pause; automatic polling
does not activate the pull-to-refresh indicator. This is data synchronization,
not an over-the-air binary/UI update service: UI changes still require a new
signed app build.
