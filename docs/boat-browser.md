# Boat browser and desktop integration

Boat provides the interactive display for a Boat-hosted computer. Its default
desktop viewer uses Moonlight/WebRTC at up to 1920x1080 and 60 fps; VNC is the
HTTPS fallback for networks where WebRTC or UDP connectivity is unavailable.
Boat also provides a browser-only Chrome surface. These viewers are created by
the Boat control plane and are separate from the application API.

`LocalComputerProvider` runs the authenticated runner on the same VM and keeps
the runner on loopback. It preserves Boat's native display by passing through
the existing `DISPLAY` value (falling back to `:0` for a Boat VM) instead of
starting X11, Xvfb, Fluxbox, Moonlight, or VNC. The runner receives the same
workspace in `WORKSPACE_DIRECTORY` and `OPENCODE_DIRECTORY`, a provider-owned
`RUNTIME_ROOT`, and loopback `BOT_TOOLS_URL`/CDP defaults. The native Boat
desktop service therefore remains the owner of the visible `:0` screen.

The provider does not manufacture a Boat desktop or browser URL and does not
proxy Moonlight, WebRTC, or VNC streams. A Boat host or control-server adapter
must call Boat's authenticated desktop/browser endpoint and return its
short-lived viewer URL. The runner's existing authenticated desktop routes can
continue to serve application clients that use the multipart preview path, but
that stream is not equivalent to Boat's 60 fps viewer.

Chrome profile ownership remains a runner concern. The current runner defaults
to `/workspace/browser/profile`; configure the Boat image and persistent
filesystem accordingly. Browser-only Boat URLs are sensitive, expire, and
should not be written to logs or durable workspace records. Desktop processes
may disappear across Boat stop/resume or fork, so the application must reopen
the browser and restart its app/dev server after hydration.

## Native display limitations

The local provider can accurately report Linux desktop/browser capability when
the Boat image supplies Chrome and the native display service. It cannot prove
that Moonlight, VNC, or browser-only streaming is available from the runner's
health endpoint. Until a Boat control-server adapter is added, callers should
surface desktop URL creation as an explicit unsupported integration rather than
claiming that the local runner itself provides a Boat viewer.

See the [Boat desktop streaming documentation](https://docs.boat.dev/desktop-streaming.md)
for viewer modes, browser-only behavior, and URL handling.
