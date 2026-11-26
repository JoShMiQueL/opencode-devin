# AGENTS.md — working in opencode-devin

OpenCode v2 provider plugin for the Devin/Cognition backend. Thin adapter: the heavy lifting lives in devin-core (wire/auth/catalog) and devin-engine (CascadePipeline — guard/override/retry). This repo is the AI-SDK `LanguageModelV3` surface, the `/connect` PKCE integration, and the plugin-options plumbing.

## Language

- **Everything in English.** Commit messages, PR titles/bodies, code comments, docs, reviews — always English. Code and identifiers too.
- Conventional commits: `feat|fix|docs|ci|chore|test|refactor|perf`.

- **Model routing**: the orchestrator and the big lanes are used as little as possible — everything delegable goes to workers/subagents on cheap lanes. Don't recommend swe-2-1-flash for workers (standing rule); the bare swe-2-1 lane hits the free-tier rate limit under real workloads — upstream closes the stream empty, the pipeline burns all retries in <1s, and the user sees an instant cut. When that happens, check for `Reached free model rate limit` upstream before debugging the pipeline.
## Model routing

- **Delegate everything delegable — the orchestrator and the big lanes are used as little as possible.** Workers and subagents go to cheap/small lanes; the swe-2-1 bare lane hits the free-tier rate limit under real workloads (upstream closes the stream empty in <1s — instant cut for the user, resets in minutes, not a bug). `swe-2-1-flash` stays off the worker/subagent lane per the standing rule.
- Recommend `swe-2-1-high`/`xhigh` or `swe-2-max` for direct user prompts; higher effort streams more granularly AND measures better uncensored compliance.

## Hard rules

- **Plugin options are the configuration path**: `{"plugins": [{"package": "opencode-devin", "options": {"mode": "uncensored"}}]}` — `ctx.options` forwards into published provider settings. A manual `provider.devin.options` stanza in opencode.json still overrides; that precedence is documented behavior.
- **Delegation rule**: the orchestrator and the big lanes are used as little as possible — everything delegable goes to workers/subagents on cheap lanes. swe-2-1 bare hits the free-tier rate limit under real workloads (upstream returns an empty stream, the pipeline classifies "empty", and all retries burn in under a second — reads to the user as an instant cut). If swe-2-1 replies die instantly, check for the upstream `Reached free model rate limit` error before assuming a pipeline bug.
- **`devin/` exposes ALL models in the subscription catalog**, one per family with effort as variants — never hardcode tier lists here. Don't use swe-2-1-flash for workers/subagents in recommendations.
- The opencode plugin cache (`~/.cache/opencode/npm/opencode-devin@latest/`) pins whatever was latest when first downloaded — when testing unreleased engine changes, hot-patch `dist/` into the cache's nested `node_modules/devin-engine/` and check the nested `devin-core` version too (the stale-nested trap).
- Field numbers in protocol files are reverse-engineered — comments citing evidence are load-bearing.

## Versioning & releases

- devin-core and devin-engine are pinned **exactly** in package.json — no carets. When upstream publishes, bump manually: `npm pkg set dependencies.devin-engine=X.Y.Z && npm install && gh pr create --fill`.
- release-please + trusted publishing via the shared `gh-actions` reusables; see the ecosystem root AGENTS.md for the protection-drop merge dance.

## Testing

`bun test` green before every push. main is protected: PRs only, squash merge, checks must pass. Live verification uses the real credential at `~/AppData/Roaming/devin/credentials.toml` — harness scripts (measure compliance rates, capture wire bodies) are local-only, never committed.

## Ecosystem

| Repo | Role |
|---|---|
| `devin-core` | wire + auth + PKCE + catalog |
| `devin-engine` | guarded-retry pipeline (CascadePipeline embedded here) |
| `devin-proxy` | OpenAI-compatible standalone proxy |
| **`opencode-devin`** (this) | OpenCode v2 plugin |
| `claude-devin` | Claude-compatible surface |
