# AGENTS.md — working in opencode-devin

OpenCode v2 provider plugin for the Devin/Cognition backend. Thin adapter: the heavy lifting lives in devin-core (wire/auth/catalog) and devin-engine (CascadePipeline — guard/override/retry). This repo is the AI-SDK `LanguageModelV3` surface, the `/connect` PKCE integration, and the plugin-options plumbing.

## Language

- **Everything in English.** Commit messages, PR titles/bodies, code comments, docs, reviews — always English. Code and identifiers too.
- Conventional commits: `feat|fix|docs|ci|chore|test|refactor|perf`.

## Hard rules

- **Model routing** (mirrors the user's global rule): `swe-2-1` is for the orchestrator and the planner only, at its lowest real effort (`low` — `minimal`/`none` don't exist on this family). Everything delegable goes to workers/subagents on cheap lanes that actually exist: `swe-2#medium`, `swe-2-flash`, `swe-2-lightning`, `claude-haiku-5-5`, `gpt-5-4-mini`, `gemini-*-flash`, `kimi-k3`, `glm-5-3-flash`, `deepseek-v4-flash`. `swe-2-1-flash` does NOT exist — never reference it. swe-2-1 bare hits the free-tier rate limit under real load (upstream closes the stream empty in <1s — reads as an instant cut, resets in ~2 min, NOT a pipeline bug).
- **Plugin options are the configuration path**: `{"plugins": [{"package": "opencode-devin", "options": {"mode": "uncensored"}}]}` — `ctx.options` forwards into published provider settings. A manual `provider.devin.options` stanza in opencode.json still overrides; that precedence is documented behavior.
- **`devin/` exposes ALL models in the subscription catalog**, one per family with effort as variants — never hardcode tier lists here.
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
