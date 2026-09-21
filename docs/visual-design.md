# Visual direction

Reviewed on 2026-09-21 in the browser, including actual screenshots:

- [OpenCode website](https://opencode.ai): framed content, fine dividers, restrained monochrome, clear type hierarchy.
- [Download page](https://opencode.ai/download): generous section spacing, small numbered labels, simple outlined controls.
- [Published active-session screenshot](https://raw.githubusercontent.com/anomalyco/opencode/v2/packages/web/src/assets/web/web-homepage-active-session.png): compact work controls, a readable conversation column, inline file activity, and a distinct adjacent work surface.
- [Project menu screenshot](https://raw.githubusercontent.com/anomalyco/opencode/v2/packages/app/e2e/screenshots/session-project-menu.png): compact contextual actions rather than a toolbar full of commands.

These are visual references, not a claim to reproduce every current OpenCode screen. The Bot workspace keeps its own navigation and uses the existing wordmark.

## Application

Warm charcoal and muted olive surfaces, ivory primary actions, fine dividers, and generous conversation spacing. System fonts eliminate an external font request. Serif type is limited to welcome/connection headings; operational UI stays in familiar sans-serif and monospace. No sparkle icons, decorative status dots, or persistent delegation toolbar.

The conversation remains the main surface. Tool activity and peer handoffs belong at their original position in its timeline. The computer is an optional adjacent preview that pauses when its tab is hidden. Startup copy appears once, with readable progress instead of repeated error cards.

Settings contains device pairing and its QR, service configuration, and updates. Destructive actions remain contextual. A paired device sees only its connection settings; API authorization enforces the same boundary.

The native mobile client is a separate planned surface: see [mobile-client.md](mobile-client.md). It should share attachment, pairing, and conversation semantics rather than copy desktop layout onto a phone.
