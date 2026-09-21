# OpenCode 2 extensions and a safe discovery surface

Research checked September 20, 2026 against the OpenCode 2 documentation, the
published `@opencode/plugin` contract, and the Agent Skills specification. The
native runtime in this repository is pinned to OpenCode `2.0.11`.

## What is verified

OpenCode 2 has two different extension systems:

- A **skill** is a portable directory whose entry point is `SKILL.md`. It is
  discovered and loaded on demand by the native `skill` tool.
- A **plugin** is executable JavaScript/TypeScript that changes server behavior
  or the CLI/TUI. It is loaded into OpenCode and therefore has a much larger
  trust and update surface.

They must not be presented as one interchangeable “app” catalog. OpenCode's
official docs describe npm packages, Git specifications, local paths, and
project/global directories as plugin sources. They describe HTTP `index.json`
catalogs only for skills. We found no official OpenCode plugin marketplace or
curated registry contract to consume; the official plugin workflow resolves
packages through npm or Git. Community marketplace projects are not an
OpenCode-owned trust signal and should not be represented as an official
catalog.

Primary references: [OpenCode V2 plugin overview](https://opencode.ai/v2/docs/build/plugins/),
[plugin configuration and CLI](https://opencode.ai/v2/docs/plugins/),
[plugin commands](https://opencode.ai/v2/docs/cli/commands/),
[OpenCode skills](https://opencode.ai/v2/docs/skills/), and the
[Agent Skills specification](https://agentskills.io/specification).

## Skills: format, paths, and discovery

The portable shape is:

```text
my-skill/
├── SKILL.md              # required
├── scripts/              # optional executable helpers
├── references/           # optional on-demand documentation
└── assets/               # optional templates and data
```

`SKILL.md` starts with YAML frontmatter and then Markdown. The Agent Skills
standard requires `name` and `description`; `name` is 1–64 lowercase
alphanumeric/hyphen characters, cannot start/end with a hyphen or contain
`--`, and must match the parent directory. `description` is 1–1024
characters and should say what the skill does and when to use it. Optional
fields are `license`, `compatibility`, `metadata`, and experimental
`allowed-tools`. The body is unrestricted Markdown. The standard recommends
progressive disclosure: metadata at startup, a short instruction body on
activation, and supporting files only as needed. `skills-ref validate` is the
reference validator.

OpenCode 2 searches these locations:

```text
~/.config/opencode/skills
~/.claude/skills
~/.agents/skills
.opencode/skills
.claude/skills
.agents/skills
```

For project paths it walks from the current directory toward the project root.
The preferred project form is `.opencode/skills/<skill-id>/SKILL.md`; a flat
`<source>/<skill-id>.md` is also accepted. Config can add local paths or an
HTTP catalog using the `skills` array in `opencode.json`/`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "skills": ["./team-skills", "~/shared/opencode-skills",
    "https://example.com/opencode/skills/"]
}
```

An HTTP source is a base URL containing `index.json`. Its entries contain a
name, a cache-busting `version`, and safe same-origin relative `files`; the
entry file must be `SKILL.md` or `<name>.md`. OpenCode fetches files below
`<base-url>/<name>/`. IDs are path-derived and case-sensitive. Later sources
override earlier definitions with the same ID. A description makes a skill
eligible for model discovery; `metadata.opencode/autoinvoke: false` hides it
from the model's available list while keeping explicit loading possible.
`slash: false` (or `metadata.opencode/slash`) hides it from interactive
command catalogs.

## Plugins: V2 contract and install commands

A V2 plugin exports a default `Plugin.define({ id, setup(ctx) })` definition.
`setup` receives an OpenCode server-like context and can register tools, hooks,
transforms, subscriptions, and cleanup. The published package normally has
`type: "module"`, an export such as `".": "./src/index.ts"`, and a compatible
`@opencode/plugin` dependency. V2's context also exposes location, options,
registries, and APIs such as `ctx.skill.list()`/`ctx.skill.transform(...)`.

Plugin entries in `opencode.json(c)` are ordered strings or objects:

```jsonc
{
  "plugins": [
    "opencode-acme-plugin@1.2.0",
    "@acme/opencode-plugin",
    "./plugins/local",
    { "package": "@acme/opencode-plugin", "options": { "strict": true } }
  ]
}
```

V2 also auto-discovers `.opencode/plugins/*.ts|*.js` and immediate package
directories, plus the equivalent global config directory. Use `cli.json` for
CLI-only plugins; those run locally even when the CLI connects to a remote
server. A leading `-` disables an ID or wildcard and `*` enables all matching
plugins.

The verified global package lifecycle is:

```text
opencode plugin add <npm-or-git-spec>
opencode plugin list
opencode plugin list --builtin
opencode plugin check
opencode plugin update [<configured-package>]
opencode plugin remove <configured-package>
```

`plugin add` accepts npm names with versions/tags/ranges and npm-compatible Git
specifications, including hosted shortcuts, HTTPS/SSH, commit/tag/branch
selectors, and `::path:` subdirectory selectors. It does not accept tarball or
npm alias targets. Unpinned npm/Git packages can be checked for updates;
exact npm versions and full Git commit hashes remain pinned. Cached packages
may install in the background at server startup. This makes plugin
installation an executable mutation and a supply-chain decision, not a normal
skill import.

OpenCode 2 is intentionally incompatible with V1 plugin implementations. V1
uses `plugin` and function/server hooks; V2 uses plural `plugins` and
`setup(ctx)`. Renaming the config key or moving a file does not port the code.
The migration guide says the same package can expose separate V1 `server()`
and V2 `setup()` implementations, but each implementation must use its own
API.

## Mapping to this repository

The runtime already owns the authoritative location-scoped native catalog in
`OpenCode2Runtime.catalog()`: models, providers, agents, native session
commands, MCP status, explicit actions, and a `cliOnlyCommands` list. It
submits a native session command through `client.session.command({ sessionID,
name, text })`; CLI-only names such as `plugin`, `mcp`, `serve`, and `models`
must not be sent as slash commands. The adapter's `runtime.experimentalApi`
flag and `2.0.11` version should remain visible anywhere native capability is
shown.

The existing web Skills surface is the application's durable bot-skill store
(`GET/POST /api/skills`, assignment via `/api/bots/:id/skills`); it is not yet a
native OpenCode skill registry or installer. Keep that distinction visible in
the UI. A future native bridge can read `ctx.skill.list()` through a deliberate
runtime endpoint, but should not infer installed plugins from the local bot
database.

## Recommended Discover experience

Add a modest **Discover** section inside Skills rather than a general plugin
store. It should show:

1. Local and assigned skills from the existing workspace store.
2. A small set of explicitly trusted external skill catalogs, each labeled with
   its source URL, version, and last refresh time. Treat catalog entries as
   untrusted Markdown until the user chooses to import them.
3. Links to the official OpenCode skill and plugin documentation, plus a
   “copy command” affordance for `opencode plugin add`, `list`, `check`, and
   `remove`.

For skills, a preview should show the exact `SKILL.md` metadata, all files that
will be copied, source URL, license, version, and ID collision behavior. Import
should be explicit, preserve provenance, validate with the Agent Skills rules,
and allow removal. Do not silently modify `opencode.json`, global config, or
the native daemon from a card click.

For plugins, display the package/Git spec and an “Open Native OpenCode” or
copyable CLI command. If a later implementation adds an install action, it
must call the native CLI (`opencode plugin add`) through an explicit terminal
flow, show the exact target and resulting config diff, and require a user
confirmation immediately before execution. Do not download, execute, or
pretend to verify third-party plugin code in the web process. Do not fabricate
ratings, signatures, compatibility, or an OpenCode-maintained marketplace.

The first implementation can therefore be read-only discovery plus native
commands. It remains useful, matches the APIs that are actually shipped, and
keeps executable plugin installation behind the native trust boundary.


## Implemented discovery

The Skills header has a single **Discover** action. Its dialog separates Skills
and Plugins, links to skills.sh, Anthropic's source examples, the OpenCode
ecosystem list, and current native documentation. A GitHub repository URL can
be turned into an editable review request for the selected bot. This reviews
source, licensing, dependencies, and runtime compatibility before installation;
opening the dialog does not install code. The existing app library remains
explicitly identified as instructions included in every run, distinct from
native on-demand skill discovery.
