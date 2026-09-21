# First public preview qualification

Release preparation: September 20, 2026.

- Clean source copy: `npm ci`, prerequisite checks, web build, and setup apply.
- Actual Cloudflare OAuth and account lookup succeeded.
- The intended Worker did not exist and no Containers were deployed.
- R2 account access returned `10042` (R2 not enabled). Setup stopped with the
  dashboard activation link before creating any cloud resources.
- All 143 automated tests, typechecking, and the production web build passed.
- Automated tests cover installer orchestration, ownership conflicts, runtime
  and control-plane behavior, and browser connection-fragment handling.

This is **not** evidence of a successful account deployment. Full cloud
qualification remains pending an account with R2/Workers/Containers enabled.
Local Worker/Sandbox and native OpenCode qualification are recorded separately.

The development instance is intentionally removed for the owner's fresh-install
trial; no conversations, credentials, or checkpoints are included in the release.
