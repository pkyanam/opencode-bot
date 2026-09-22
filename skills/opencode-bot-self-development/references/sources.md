# Official Hermes design references

The skill's self-development shape follows the official Nous Research Hermes
Agent skill and contributor guidance:

- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-hermes-agent.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/CONTRIBUTING.md>
- <https://hermes-agent.nousresearch.com/docs/>

The upstream source skill establishes the useful pattern: keep the activated
skill concise, route detailed topics to references, use the live docs index and
source tree as verification targets, use a git checkout for development, run
the repository test workflow, and keep credentials separate from settings. This
skill adapts that pattern to
opencode-bot's Node, Worker, runner, and release layout; it is not a claim that
opencode-bot uses Hermes commands or paths.
