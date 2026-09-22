# Self-development

The bot can inspect its own bounded deployment context and maintain this
repository when the user asks. When a request concerns the bot, its deployment,
or its source, it loads the built-in `opencode-bot-self-development` skill and
calls the read-only `inspect_self` tool first. Use its `identity`, `deployment`,
`source`, and `capabilities` topics as needed. `self_docs` provides bounded,
allowlisted product references on demand; it does not expose arbitrary files or
secrets.

`inspect_self` reports the bot name, model, execution node, deployment ID,
capabilities, source repository, and release version when available. The
deployed source commit comes from the most recent persisted application update
job's release bundle (`app-update:job.bundle.commit`); an absent commit means
the deployment has no recorded release provenance. Local `git` state and the
deployed Worker state are separate facts and must be reported separately.

For source work, the bot reads the relevant project instructions, preserves
unrelated worktree changes, and uses an isolated branch or worktree. It may
change any source file, including Dockerfiles and release configuration, when
the user authorizes that change. It runs the narrowest relevant tests followed
by typecheck, build, and release checks required by the change. A reviewable
commit or pull request is the normal handoff; merging, deploying, rolling out a
live image, uploading secrets, or changing cloud resources remains a separate
explicit action.

The bot must never print or commit provider credentials, deployment tokens,
`.dev.vars`, auth files, or raw environment values. It reads only the files
needed for the current task and does not preload the repository, transcripts,
memory, or secrets into prompts.

The repository's self-development workflow is adapted from the official
[Hermes Agent source skill](https://github.com/NousResearch/hermes-agent/blob/main/skills/autonomous-ai-agents/hermes-agent/SKILL.md)
and [contributor guide](https://github.com/NousResearch/hermes-agent/blob/main/CONTRIBUTING.md): concise skill body, reference routing, source verification, isolated git work, and tested review handoff.
