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

Use **Sleep computer** when you are done to save current state and stop the
Computer. The preview does not wake it automatically. Choose **Wake computer**
explicitly when you want to continue; waking restores the last saved state and
requires that no task is active.

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

Settings → Storage measures the deployment's R2 objects and defaults automatic
idle checkpoints to every 60 minutes, keeping the latest two within a 2 GiB
budget. Selective cleanup requires confirmation and only deletes unprotected
checkpoint objects; use Workspace → Files when you mean to delete workspace
files. The R2 10 GB-month free allowance is account-wide across deployments,
not a dedicated workspace quota or billing guarantee. Containers require
Workers Paid ($5/month) plus compute, and memory/disk are charged while a
container is awake, including idle time, so the R2 meter is not a deployment
cost estimate. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
and [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).

Cloudflare Sandbox disks are ephemeral. Checkpoints preserve application state,
shared files, and the browser profile in R2. The Cloudflare provider uses multipart
uploads and ranged restores for archives up to 2 GiB; adapters without those
capabilities retain the 32 MiB limit. Restoration verifies the archive checksum
before replacing workspace files. Keep independent backups of important files.

### Sign in to an MCP service

Open **Settings → MCP → Sign in**. **Sign in on Computer** opens the provider's authorization page inside the bot's Computer, where its callback listener runs. Expand the Computer and take control to complete the login. The service list checks the result automatically.

You can also use **Open authorization link** in your own browser. Some services, including Cloudflare, finish at an address such as `http://127.0.0.1:12345/callback?code=…&state=…`. That address belongs to the remote Computer, so a connection error in your browser is expected. Copy the **entire address** into **Callback completion** and select **Complete login**. This is a one-time callback, not an API token.

The app checks the callback against the exact pending login before delivering it to the Computer. An expired attempt or a Computer restart requires a fresh sign-in. Callback URLs are not saved as credentials; don't post them in chat or issues.
