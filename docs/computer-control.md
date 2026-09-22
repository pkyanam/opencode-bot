# Sign in and take control

## Connect an MCP service

Open **Settings → MCP services**, or type `/mcps` (`/mcp` is an alias).
The list comes from the installed OpenCode runtime. Services that need credentials
show **Sign in**. Choose a native OAuth method when more than one is available.

Choose **Sign in on this device** to open the service in your own browser.
If login ends at a localhost callback that cannot load, copy the **entire address**
(including `code` and `state`) into **Callback completion**, then select
**Complete login**. That localhost listener belongs to the hosted Computer.
The callback is a one-time login response, not an API token.

Pending sign-ins can be resumed after closing Settings or reloading the same
browser tab. Each service has its own attempt. Callback URLs and entered codes
are not saved. An expired attempt or a Computer restart requires a new sign-in.

Follow the instructions returned by each service: a service may finish
automatically or provide a one-time code. API keys and custom authorization
headers are separate from OAuth; configure those through Native OpenCode's MCP
configuration until the web UI exposes the corresponding credential form.
Not every service supports OAuth or every registration method.

**Sign in on Computer** remains an alternative. Return desktop control before
completing login in Settings. Never paste passwords or MFA codes into chat.

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
to focus it, then use the pointer, keyboard, or scroll wheel. Taking control also
focuses keyboard input automatically. Expand **Paste or send text** for the optional
text entry field. On a Mac,
common Command shortcuts map to Control on the Linux Computer. The preview panel
remains view-only.

The Computer is shared by the workspace's bots. Finish or stop the active task
before taking over. New work stays queued while someone holds control. A second
client cannot acquire the same Computer. **Return to bot** or close the expanded
view to release control. Hidden/disconnected clients release their lease; a
60-second server expiry also releases held keys and buttons. A stopped task is
never automatically restarted.

The full-window view fits the complete desktop without cropping. Different screen
aspect ratios can leave dark margins. Chrome uses the actual maximized window
size rather than a fixed page viewport that extends behind its window chrome.

A persistent FFmpeg capture process targets 3 fps for passive preview and 60 fps
while a human holds control. Slow viewers drop frames instead of accumulating a
queue. This is a capture target, not a guaranteed delivered frame rate: MJPEG
bandwidth, container CPU, client decoding, and network latency still apply. Input
uses authenticated HTTP requests, so this is not a WebRTC remote desktop.

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
