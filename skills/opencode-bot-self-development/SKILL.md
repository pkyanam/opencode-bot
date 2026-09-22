---
name: opencode-bot-self-development
description: >
  Identify, inspect, test, and safely improve this opencode-bot deployment and
  source tree. Use when asked who you are, which version or checkout is running,
  how the bot is deployed, or to change the bot itself and prepare a reviewable
  release. Load the matching reference before making source or deployment claims.
license: MIT
---

# opencode-bot self-development

This skill is an operating guide for the bot maintaining its own product. It
does not grant new permissions and it must not be used to disclose credentials.

## Progressive workflow

1. **Identify before acting.** If available, call the read-only `inspect_self`
   tool with `all`, then the narrow topic (`identity`, `deployment`, `source`,
   or `capabilities`) needed for the answer. Read `references/identity.md` for
   interpretation. If the tool is unavailable, inspect the checkout with
   `pwd`, `git status --short`, `git rev-parse HEAD`, and the relevant
   package/version files. Report facts with paths and commit IDs; do not guess
   a deployed version from a local source version.
2. **Inspect the actual deployment.** Read `references/deployment.md` and use
   `inspect_self deployment` plus read-only health, checkpoint, release-manifest,
   and Wrangler queries first. Distinguish local checkout, runner/container
   image, Worker deployment, and release artifact. Never print environment
   values that may contain secrets.
3. **Plan source changes in isolation.** Before editing, read
   `references/change-release.md`, check repository instructions, and create a
   dedicated branch or worktree when the request changes source. Preserve
   unrelated user edits. Keep changes narrow and reviewable.
4. **Verify before handoff.** Run the smallest relevant tests, then the required
   typecheck/build/release checks. Show the exact commands and outcomes. Prepare
   a commit or pull request only when requested or when the surrounding workflow
   explicitly expects one; never merge, deploy, or publish without explicit
   authorization.

## Hard boundaries

- Treat source, deployment state, and user workspace files as separate trust
  domains. Do not use deployment credentials to modify unrelated accounts.
- Do not read, copy, echo, commit, or paste secrets from `.dev.vars`, secret
  stores, auth files, process environments, or provider credentials. Redact
  tokens and URLs containing credentials from logs and summaries.
- Do not inject the whole repository, transcripts, memory, or environment into
  prompts. Read only the files needed for the current question, and load a
  reference file only when its topic applies.
- Authorized source changes may include Dockerfiles, deployment bindings, and
  release configuration. Keep those edits in the isolated checkout, review and
  test them, and do not mutate a live image, Worker, release channel, or cloud
  resource as a side effect of diagnosis.
- Wrangler may be used for read-only inspection and for the repository's
  documented release workflow. Never run a mutating Wrangler command merely to
  answer an identity question.

## Routing

- “Who are you / what version / where is your source?” → `references/identity.md`
- “What is deployed / is the runner healthy?” → `references/deployment.md`
- “Change yourself / fix a bug / open a PR” → `references/change-release.md`
- “Why did a check or release fail?” → load the relevant reference, then inspect
  the named test or release script instead of relying on this summary.
