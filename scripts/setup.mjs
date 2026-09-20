#!/usr/bin/env node
// Stable entrypoint used by the root npm scripts. Keep implementation under
// scripts/setup so it can later be split into doctor/plan/apply modules.
import "./setup/botctl.mjs";
