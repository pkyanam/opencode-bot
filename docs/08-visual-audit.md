# Visual and interaction audit

Reviewed in the running browser on 2026-09-20, initially at a 1072 × 906 viewport.

The current Cloudflare Sandbox image also verified a headed Chromium session
rendered through the app's live MJPEG desktop pane. That evidence covers the
current viewing path; it does not qualify native desktop packaging, human
takeover, or remote owned-node desktop relay.

## Findings and decisions

| Area | Finding | Change |
| --- | --- | --- |
| Empty workspace | Three Create Bot actions, an empty breadcrumb, and a disabled composer repeated the same instruction | One primary onboarding action; hide irrelevant empty-state controls |
| Typography | Monospace body copy made longer conversations dense | System sans for conversation and forms; monospace for technical metadata and navigation labels |
| Header | Generic icon and slash-separated text did not match the requested identity | Imagegen wordmark using the official OpenCode brand asset as reference; reads “opencode bot” |
| Navigation | Hidden Tabs and several modal-only features obscured functionality | Visible Chats, Skills, Files; native commands and Computer access beside the conversation |
| Skills | Repeated create actions and vague empty-state wording | One New Skill action, direct wording, library beside current-bot assignment context |
| Computer | Permanent expanded preview competed with the conversation | Collapsed by default; 360px panel on wide screens, overlay on narrower screens; capture stops on close |
| Commands | Native prompt templates were conflated with terminal UI actions | Live catalog for templates; explicit web actions; native OpenCode terminal for its complete TUI |
| Model selection | Manual model IDs were easy to mistype | Searchable live catalog with known-free, paid, and unknown-pricing distinctions |
| Forms | Tight field spacing and weak dialog semantics | 20px between fields, 28px container padding, Radix dialogs with visible accessible titles |
| Status | Decorative dots and repetitive explanatory footers added clutter | Text or meaningful icons only; status kept beside the relevant action |

## Layout rules

- Use 8px spacing increments for structure, 4px only within compact control groups.
- Keep 12–16px between related controls and 24–32px between distinct sections.
- Conversation is the main work surface; model and command controls belong near task input.
- Skill instructions and model selection belong in the bot context rather than global connection settings.
- Avoid repeating the selected thread title in both the breadcrumb and heading.
- Keep errors inline and actionable; do not display connection or authentication implementation details as product guidance.
- Keep keyboard focus visible and honor reduced-motion preferences.

## Reference boundaries

The OpenCode influence is warm dark surfaces, restrained borders, ivory actions, and the block wordmark. The Grok Bot influence is persistent named bots, conversation-first interaction, and an optional view of the shared computer. This does not imply identical behavior, hosting isolation, or an official affiliation.

References: [OpenCode brand](https://opencode.ai/brand), [Grok Bot computer](https://docs.x.ai/grok-bot/computer-and-apps), [Grok Bot introduction](https://x.ai/news/introducing-grok-bot).
