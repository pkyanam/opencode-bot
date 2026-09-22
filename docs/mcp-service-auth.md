# Connecting external MCP services

Open **Settings → MCP**, choose the service, then **Sign in on this device**.
You do not need the streamed Computer desktop for normal OAuth login.

If your browser ends at a localhost URL that cannot load, copy the **whole URL**
into **Callback completion**. The callback listener runs on your hosted Computer,
not on your phone or laptop. A callback is a one-time response; it does not belong
in an API-key field.

Close Settings or reload the same tab when needed. **Pending sign-ins → Resume**
reopens the attempt. Different services retain separate attempts. Attempts expire
after 15 minutes, and a Computer restart may invalidate them earlier. Callback
URLs and codes you enter are never saved in browser storage.

## What works today

| Service authentication | Current path |
| --- | --- |
| Public HTTP MCP | Connect; no credentials required. |
| OAuth exposed by OpenCode | Choose a discovered method, open its authorization link, follow its instructions, and check status. Hosted loopback callbacks can be pasted back into the app. |
| One-time authorization code | Enter the code only when that method asks for one. |
| API key or custom headers | Configure through Native OpenCode's MCP controls/configuration. The web OAuth callback field cannot configure these. |
| Local stdio service | Configure its command and environment through Native OpenCode. It runs on the selected Computer, not on the client device. |
| Service needing a registered OAuth client | Supply the client configuration supported by OpenCode/the provider. A generic login button cannot create provider approval or registration that the provider does not offer. |

Connection and token exchange are owned by OpenCode. The app passes through
native methods rather than assuming every server uses Cloudflare's login flow.
A pending UI attempt is not proof that a service is connected; the native status
must confirm completion.

## Expanding the web UI

The next credential surface should use the native integration form schema where
available. It must separate OAuth, API keys, custom headers, and command environment
variables, submit secrets once, and display only configured/not-configured state.
Device-code methods should display their verification link and user code only
when advertised by the service, with polling and expiration rather than a
callback field. These forms are not all implemented yet.

For providers supporting a registered public callback, a deployment HTTPS callback
can eliminate copying URLs. It must bind the callback to its original service,
attempt, state, and PKCE verifier. Arbitrarily changing a localhost redirect URL
is not valid; providers validate registered callback addresses.

The [current MCP authorization specification](https://modelcontextprotocol.io/specification/latest/basic/authorization)
uses OAuth for HTTP transports and environment credentials for stdio transports.
Compatibility also depends on the installed OpenCode version's discovery and
registration support; the app does not claim universal server compatibility.
