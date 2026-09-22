# Computers and bot collaboration

Each bot has an assigned execution computer. The default computer is the
Cloudflare node; additional computers register through Settings → Computers.
A conversation retains its node assignment so changing a bot's default does
not silently move a running session or its files.

## Local execution, shared coordination

The assigned computer runs OpenCode, its shell/file tools, and its browser.
Owned nodes install their own Chromium and keep its profile and output in the
node's private config directory. Headless Chromium supports macOS, Windows,
and Linux VMs without requiring a logged-in desktop session. It is a separate
profile from the owner's everyday browser.

The control server holds the bot directory, messages, and job routing. A bot
can request work from another bot on any node. The target runs on its assigned
computer, and results return to the originating conversation. This does not
use OpenCode subagent mode or move the target's execution to the sender.
An unavailable node must remain unavailable; never run its work on Cloudflare
as an implicit fallback.

## Boundaries

- Files, provider credentials, and browser cookies belong to the execution node.
  Messaging does not synchronize directories or copy logged-in browser sessions.
- Browser automation and interactive desktop streaming are different capabilities.
  Owned-node browsers run locally; the Cloudflare desktop stream is not their
  preview. Owned-node interactive streaming is still a separate extension.
- Keep capability reporting explicit. A node without a usable runner/browser
  must not be advertised as ready for that capability.
- Registration uses an expiring invitation once. Subsequent connections use a
  saved node credential; restarting OpenCode does not require another invitation.

## Providers and models

The computer selector chooses where OpenCode executes, not where model inference
necessarily happens. A bot running on a Mac can call a hosted model provider;
a bot using a local model needs that provider reachable from its assigned Mac.

Provider configuration is per computer. Connecting a provider on Cloudflare does
not connect it on another node. Bot model selection must use the assigned
computer's catalog. Before dispatch, the node checks that the requested model is
configured and enabled. This is not a credential validity test: expired keys,
provider outages, and account limits can still cause the provider to reject a run.

Bot defaults apply to new conversations. Existing conversations retain their
execution computer and model settings; changing defaults does not migrate files,
credentials, browser sessions, or in-progress work.

Remote configuration uses the node's outbound authenticated connection. The
control server is a trusted intermediary, not an end-to-end encrypted secret
vault. Provider credentials must never appear in job receipts or logs. A central
inference gateway for explicitly shared providers is not currently implemented.

## Local access

The installer creates a dedicated workspace and browser profile. These keep bot
files separate from everyday work, but they are not an operating-system sandbox.
OpenCode tools run with the node service account's filesystem permissions. Use a
separate OS account or VM when you need a stronger boundary.

## Configure a computer from the web app

In Settings → OpenCode, choose **Configure computer**, then connect that computer's
provider or add a custom provider. Settings → MCP uses the same computer selection
for service connections and sign-in. When creating a bot, choose its computer
before selecting its model and any provider-supported variant.

Configuration commands travel over authenticated HTTPS. Sensitive queued inputs
are encrypted at rest and removed after completion or expiry. The control server
can decrypt them to deliver them, so this is not end-to-end encryption. No provider
credentials are copied merely because two bots collaborate.

## Browse outside the workspace

Open **Files**, choose a computer, then select **Computer**. Enter an absolute path
in the Path field and press Go. Workspace remains a convenient shortcut to the
selected computer's configured working directory. Markdown and images have rendered
previews; files can be uploaded, downloaded, renamed, and removed.

Whole-computer access requires the workspace owner credential. It follows the node
service account's OS permissions; it does not grant root or administrator access.
Symbolic links are listed but not followed. Cloudflare Computer view shows the
container filesystem, not the Cloudflare host. Only configured durable directories
survive container replacement.

Owned-node uploads and downloads currently have a 50 MiB limit and use a temporary,
authenticated R2 relay with size and SHA-256 verification. Relay links expire after
ten minutes. This is a bounded relay, not a direct peer-to-peer transfer or unlimited
file synchronization. Bot-to-bot file delivery remains scoped to bot workspaces.
