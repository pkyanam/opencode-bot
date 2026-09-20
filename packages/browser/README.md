# Browser boundary

This package describes the first computer browser capability: the pinned
`@playwright/mcp@0.0.82` stdio server. In a headless computer it runs Chromium
inside the Linux sandbox; in a desktop computer it attaches to the single
headed Chromium owned by `DesktopController` over loopback CDP.
`createPlaywrightMcpServer()` returns the OpenCode 2 native
`mcp.servers` entry. The image must install the package and browser binaries at
build time; generated commands do not use `npx` and do not fetch code at run
time.

The profile and output directories default to `/workspace/browser/profile` and
`/workspace/browser/output`. Sandbox storage is ephemeral until a quiesced
checkpoint adapter is installed. The artifact helpers reject absolute paths,
`..` escapes, and symlinks that point out of the workspace.

Pass `cdpEndpoint: "http://127.0.0.1:9222"` for the headed mode. This omits
`--headless` and `--user-data-dir`, preventing a second browser process from
competing for the persistent `/workspace/browser/profile` profile. The desktop
controller opens a local welcome page and closes Chromium before a checkpoint;
the profile remains under the checkpointable browser workspace.
