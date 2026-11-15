# AGENTS.md — opencode-devin project rules

OpenCode provider plugin for the Devin/Cognition backend. TypeScript + Bun,
Connect-RPC/protobuf wire, no generated code.

## Language

- **Everything in English.** Commit messages, PR titles/bodies, code
  comments, docs, reviews — always English. Code and identifiers too.
- Conventional commits: `feat|fix|docs|ci|chore|test|refactor|perf`.

## Layout

```
src/
├── catalog.ts          <- Model.Info[] from the live catalog (families+variants)
├── constants.ts
└── protocol/
    ├── catalog.ts      <- GetCliModelConfigs decode (field numbers)
    ├── effort.ts       <- effort levels, UID suffix split/join
    ├── model.ts        <- LanguageModelV3, run(), effort resolution
    ├── metadata.ts, auth.ts, wire.ts, chat.ts
test/                   <- bun:test, helpers build wire bytes by hand
```

## Rules

- Field numbers are reverse-engineered — if you change `src/protocol/`,
  verify against the real API (`DEVIN_LLM_API_KEY` + `bun test test/live.test.ts`).
- `bun test` green before every push.
- main is protected: PRs only, squash merge, checks must pass.
