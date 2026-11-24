# DESIGN — Devin client ecosystem: shared-core architecture

Status: **approved direction** (owner decision, 2026-11). Captures the
decisions before the refactor so the four repos stay coherent.

## Decision log

| # | Decision | Choice |
|---|----------|--------|
| 1 | Hosting | GitHub **org**, all repos **public**, npm **public** `@org/*` |
| 2 | Shared base | **Two** packages, not one: `cascade-core` (transport) + `devin-engine` (jailbreak brain) |
| 3 | `devin-proxy` language | **Python → TypeScript** refactor; Python kept as reference until test parity |
| 4 | Delivery model | Engine is **embeddable** — three products wrap it differently |
| 5 | Drift guard | `contract.json` golden catalog fixture ships with the core; every consumer asserts uid parity in CI |

## The packages

### `cascade-core` — protocol & upstream truth
TypeScript. The reverse-engineered Connect-RPC layer every product shares.
- `wire.ts` proto codec (tolerant reader — upstream frames carry non-proto payloads)
- `metadata.ts` client fingerprint (tracks installed `devin` CLI version)
- `catalog.ts` `GetCliModelConfigs`/`GetCascadeModelConfigs` parse → uid/name/context/credits/promo/expires
- `auth.ts` session token resolution (`DEVIN_LLM_API_KEY` > `credentials.toml`)
- `pkce/` OAuth PKCE flow (loopback callback + manual code paste)
- `chat.ts` `GetChatMessage` streaming transport
- `effort.ts` reasoning-effort ↔ wire-uid mapping (SWE-2 / 2.1 / Flash tier tables)
- `contract.json` golden catalog fixture + expected uid set

Donor: `opencode-devin/src/protocol` (cleanest). `metadata.ts`/`wire.ts`
are already byte-identical across `opencode-devin` and `claude-devin`;
the other five files diverge and get reconciled picking the correct
version each.

### `devin-engine` — the compliance brain (embeddable)
TypeScript. Port of `devin_proxy/{pipeline,jailbreak,models}` minus
transport. **A class, not a server** — no ports, no listeners.

```ts
import { createEngine } from "@org/devin-engine"
const eng = createEngine({ catalog, override, settings })
for await (const delta of eng.chat(messages, { model, effort })) { ... }
eng.billingTag("swe-2-1-max")  // -> "free" | "promo:2026-12-09" | "6.0cr"
```

Contents: guarded-retry pipeline, refusal guard, system-override
injection, sanitize, tool rendering, input pruning, `resolve_model`.
This is the value-add — `cascade-core` is "how to talk to Devin",
`devin-engine` is "how to make Devin comply".

## The three products

| Product | Wraps engine as | Uncensored | Surface |
|---|---|---|---|
| `opencode-devin` | **in-process** (imported) | flag `devin.uncensored` | `/connect` login, `devin/*` models, AI-SDK provider |
| `claude-devin` | **in-process** (imported) | always | Anthropic-compatible local API + `claude` wrapper |
| `devin-proxy` | **standalone HTTP** server | always | OpenAI-compatible `:8390/v1`, CLI + supervisor, any client |

The plugin "with the proxy inside" = the plugin instantiates `devin-engine`
in-process. No external process needed for uncensored opencode — the
plugin **is** the proxy. The standalone proxy is the same engine wrapped
in an HTTP listener for non-opencode clients.

## Refactor plan (`devin-proxy` Python → TS)

Not a 1:1 port of 4.5k lines — a recomposition:
- `transport/*` (~800 LoC) → **deleted**, `cascade-core` import
- `jailbreak/*` + `pipeline.py` + `models/catalog.py` (~1.5k LoC) → `devin-engine`
- `api/*` + `server.py` + `cli.py` + `service.py` (~1.7k LoC) → TS HTTP surface + CLI (template: `claude-devin`)
- tests ~840 LoC → `bun test`, plus `contract.json` parity

## Cost / promo visibility (decided feature)

`catalog.ts` already parses `credits`, `expires_at`, `promo`. Surfacing:
- `engine.billingTag(uid)` → `"free" | "promo:YYYY-MM-DD" | "Ncr"`
- `/v1/models` entries carry `{credits_per_run, free_until, promo}`
- optional `cost_tag` suffixes the model id (`swe-2.1-max@free`) — the only
  channel a generic OpenAI-compatible picker actually displays
- `X-Devin-Billing` response header per request

## Open questions

- Org name (pending owner): `devin-infra`, `cascade-clients`, other.
- Publish channel confirmed npm public; GitHub Packages rejected (auth friction).
