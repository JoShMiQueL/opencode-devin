# AGENTS.md — working in opencode-devin

OpenCode v2 provider plugin for the Devin/Cognition backend. Thin adapter: the heavy lifting lives in devin-core (wire/auth/catalog) and devin-engine (CascadePipeline — guard/override/retry). This repo is the AI-SDK `LanguageModelV3` surface, the `/connect` PKCE integration, and the plugin-options plumbing.

## Language

- **Everything in English.** Commit messages, PR titles/bodies, code comments, docs, reviews — always English. Code and identifiers too.
- Conventional commits: `feat|fix|docs|ci|chore|test|refactor|perf`.

## Hard rules

- **Plugin options are the configuration path**: `{"plugins": [{"package": "opencode-devin", "options": {"mode": "uncensored"}}]}` — `ctx.options` forwards into published provider settings. A manual `provider.devin.options` stanza in opencode.json still overrides; that precedence is documented behavior.
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
