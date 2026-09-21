# Sign in and take control

## Connect an MCP service

Open **Settings → MCP services**, or type `/mcps` (`/mcp` is an alias).
The list comes from the installed OpenCode runtime. Services that need credentials
show **Sign in**. Choose a native OAuth method when more than one is available.

Some services return to a localhost callback inside the hosted Computer. For
these, choose **Sign in on Computer**, then **Take control** and **Open login in
Computer**. Finish login directly in that browser, return control, and check the
service's status. Never paste a password or MFA code into the bot conversation.
The login attempt stays in Settings; Cancel cancels it through OpenCode.

For native operations without a web equivalent, open **Native OpenCode** and use
its own interactive command menu. The web Commands menu combines the runtime's
session commands, supported session actions, and workspace shortcuts; CLI
subcommands are not interchangeable with session slash commands.

## Use the Computer

Expand the live Computer preview and choose **Take control**. Click the desktop
to focus it, then use the pointer, keyboard, scroll wheel, or text input. On a Mac,
common Command shortcuts map to Control on the Linux Computer. The preview panel
remains view-only.

The Computer is shared by the workspace's bots. Finish or stop the active task
before taking over. New work stays queued while someone holds control. A second
client cannot acquire the same Computer. **Return to bot** or close the expanded
view to release control. Hidden/disconnected clients release their lease; a
60-second server expiry also releases held keys and buttons. A stopped task is
never automatically restarted.

Interactive desktop control currently applies to the Cloudflare Computer.
Additional owned nodes still have their documented desktop-streaming limitations.

## Preserve files before upgrading

Cloudflare Sandbox disks are ephemeral. Checkpoints preserve application state,
shared files, and the browser profile in R2. The Cloudflare provider uses multipart
uploads and ranged restores for archives up to 2 GiB; adapters without those
capabilities retain the 32 MiB limit. Restoration verifies the archive checksum
before replacing workspace files. Keep independent backups of important files.
