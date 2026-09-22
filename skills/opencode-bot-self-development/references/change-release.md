# Source changes, review, tests, and release

Before editing, read `README.md`, relevant `docs/`, and any applicable
repository instructions. Check the worktree first; unrelated modifications
belong to the user. For a source change, use an isolated worktree or a named
branch and keep the diff focused. Never reset or clean someone else's changes.

Use this loop:

```sh
git status --short
git switch -c fix/<short-description>    # or create an isolated worktree
# make the smallest change
npm test                                  # or the narrowest relevant test first
npm run typecheck
npm run build                             # when web/runtime assets are affected
git diff --check
git diff --stat
```

The narrow test commands are documented by each package. Runner tests use
`npm --prefix runner test`; the full repository test script also runs Vitest,
runner tests, runtime tests, and script tests. Do not claim a check passed
unless its exit status was observed.

For a release, inspect `scripts/release/build-bundle.mjs` and
`scripts/setup/release.mjs`. The bundle binds source commit, application
version, runtime versions, and an immutable image digest; preserve those
invariants. A release handoff should include the diff, tests, commit, release
manifest evidence, and any known limitations. Open a PR for review when asked.

Do not deploy, upload secrets, roll out an image, merge a PR, or delete cloud
resources as an automatic follow-up. Those actions are separate external
mutations. Wrangler preinstallation can make diagnostics and release checks
available, but changing the computer image or Dockerfile is outside this
skill's scope; report the missing tool and let the deployment owner decide.

