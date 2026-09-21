# Telegram integration

`TelegramService` implements the server side of a BotFather-configured Telegram
bot. It supports explicit `webhook` and bounded `polling` transports. It uses Telegram deep links for pairing (`https://t.me/<bot>?start=<nonce>`);
the QR shown by the web application should encode that URL. It is not a Telegram
login QR and must not be treated as an authentication mechanism by itself.

The service never returns a BotFather token or webhook secret. `configureBot` is
the explicit transport configuration action. For `webhook`, it calls `getMe`,
then `setWebhook` with a generated (or explicitly supplied) secret, and only
then persists the token through `TelegramStore`. For `polling`, pass
`{ transport: "polling" }` and omit `webhookUrl`; it calls `getMe`, then
`deleteWebhook`, and persists the mode. Telegram's `getUpdates` and webhook
modes are mutually exclusive. Tokens must be encrypted or otherwise protected
by the worker's server-side storage adapter.

## Worker contract

Construct one service for the worker's workspace/database:

```ts
const telegram = new TelegramService({
  store: new DurableObjectTelegramStore(state.storage.sql),
  onMessage: async (message) => {
    // Validate message.threadId/ownerUserId against the workspace's existing
    // bot and thread, then call the existing createRun({ ... }) path.
    const run = await enqueueRun({
      botId: message.botId,
      threadId: message.threadId!,
      prompt: message.text,
      idempotencyKey: message.idempotencyKey,
    });
    return { runId: run.id };
  },
});
```

On configure, the service optionally publishes Telegram's command menu through
`commandsForBot` and `setMyCommands`. The menu always includes `/new`, `/help`,
`/status`, and `/stop`, then adds authenticated native catalog commands.
Commands are routed only after the chat binding is found. Implement `onCommand`
in the worker using the context's existing owner, bot, and thread IDs. A `/new`
result may return `{ threadId }` to move that paired chat to a new thread for
the same bot, and may return `{ text, runId }` for an immediate reply and a
tracked run completion. Never route a command before pairing.

`refreshCommands(botId)` reloads the server-side catalog and updates Telegram's
menu without asking the user to submit the BotFather token again. A bare
`/start` never authorizes a chat: an unpaired user receives the Settings pairing
instruction, while an already paired user receives a ready/help prompt.

The admin routes should be authenticated with the existing `APP_TOKEN` before
calling these methods:

* `POST /api/bots/:botId/telegram/configure` body `{ token, webhookUrl, transport }` calls
  `configureBot({ botId, token, webhookUrl, transport })`, and returns its public result.
  The token is accepted over HTTPS and held only inside the service/store.
* `POST /api/bots/:botId/telegram/pairing` body `{ ownerUserId, threadId }`
  calls `createPairingLink`. Return `{ deepLink, expiresAt }` to the web UI and
  render `deepLink` as a QR. Do not return stored config objects directly.
* `GET /api/bots/:botId/telegram/pairings` calls `listPairings(botId)` and can
  show the paired chat/user metadata. `POST /api/bots/:botId/telegram/pairings/revoke`
  body `{ chatId, telegramUserId }` calls `revokePairing`; this removes the
  binding and does not call Telegram or reveal the bot token.
* `POST /api/integrations/telegram/webhook/:botId` calls
  `handleWebhook(botId, request)` and returns `webhookJson(outcome)`. Telegram's
  `X-Telegram-Bot-Api-Secret-Token` header is checked with a constant-time
  comparison before the body is parsed. This route must remain unauthenticated
  by `APP_TOKEN`, because Telegram cannot send that application bearer token.

When `transport` is `polling`, the worker's short Durable Object alarm should
call `pollOnce(botId, 0)` for each configured polling bot. The durable offset is
advanced only after the update is accepted by the same pairing and routing
pipeline used by webhooks. A Telegram 409 polling conflict is returned as
`{ error: "conflict" }`; no token or URL is included.

`onMessage` receives a paired message and a deterministic idempotency key. It
must use that key when invoking the existing run creation path. The service
stores the returned run ID and destination chat. During the existing worker
alarm/reconciliation pass, after a run reaches a terminal state, call:

```ts
await telegram.deliverRunCompletion({
  runId: run.id,
  status: run.status,
  output: run.result,
  error: run.error,
});
```

This sends the result to the paired chat, splitting output at Telegram's 4096
character limit. Each run delivery is atomically claimed and marked `sent` in
the store. It is safe to call when no Telegram delivery exists; the method
returns `{ sent: false, chunks: 0 }`. A process restart or network error while a
message may have been accepted by Telegram moves the delivery to
`needs_review`, preventing an alarm from silently sending a duplicate.

`TelegramStore` is intentionally an adapter contract. The SQL adapter should
store bot configs (including token and webhook secret) server-side, hash pairing
nonces with SHA-256, atomically delete a consumed challenge, atomically claim
`(botId, updateId)`, and key bindings by `(botId, chatId, telegramUserId)`.
Never put tokens in SQL query errors, logs, response bodies, or frontend state.

For active runs, call `deliverRunProgress({ runId, text })` with public activity.
The adapter reserves one quiet message, edits it when content changes (at least
four seconds between updates), and persists its Telegram message ID. Do not
include reasoning, credentials, or raw tool payloads. `inheritRunProgress`
transfers that activity to a bot-handoff continuation with the same chat route.
Completion settles the activity and sends a distinct formatted answer. Pass
only the final answer as `output`; retain commentary in the activity timeline.
