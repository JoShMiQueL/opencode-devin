# devin-* ecosystem — shared-core architecture

Working area for the refactor. Five repos, two shared libraries, three
products. All public, npm-public naming, no GitHub org
(repos stay under the personal account with the `devin-*` prefix + topic
`devin-ecosystem` to group them). `agentic-harness` is out of scope — it
orchestrates CLIs, not the protocol.

## Naming map (npm + GitHub, all verified free)

| New name | Was | npm | Kind |
|---|---|---|---|
| `devin-core` | — | free | lib: transport, auth, PKCE, catalog |
| `devin-engine` | — | free | lib: embeddable jailbreak/pipeline |
| `devin-proxy` | = | free | product: standalone OpenAI-compat proxy |
| `opencode-devin` | = | published | product: opencode v2 plugin |
| `claude-devin` | = | free | product: Claude surface / proxy |

`cascade-core` was taken on npm → family settled on `devin-*`.

### Naming rule: `devin-*` prefix vs `*-devin` suffix

The ecosystem convention (opencode-devin, pi-devin-*, dsh-*-devin, the
official `@cognitionai/opencode-devin`) is `<host>-devin` = "a Devin
integration for host X". We follow it:

- **`devin-*` prefix** → pieces of the *stack itself*: the libraries and
  the standalone proxy (devin-core, devin-engine, devin-proxy)
- **`*-devin` suffix** → *integrations*: Devin bridged into an external
  host (opencode-devin, claude-devin, a future vscode-devin...)

Result: the two plugins keep their existing names — zero GitHub renames,
zero npm deprecations. Only the two libs are new repos.

## Dependency graph

```
devin-core  (wire·metadata·catalog·auth·pkce·chat·effort·contract.json)
    │
    ├──> devin-engine  (pipeline·guard·override·sanitize·prune·resolve)
    │        │
    │        ├──> devin-proxy    HTTP :8390/v1 + CLI + supervisor
    │        ├──> devin-opencode in-process engine (flag: uncensored)
    │        └──> devin-claude   in-process engine, Anthropic surface
```

`devin-engine` is a **class, not a server** — the plugins import it
in-process and the standalone proxy wraps it in an HTTP listener. One
implementation of the jailbreak/guard, three deliveries.

### Why two packages, not one

Decided: keep `devin-core` and `devin-engine` as separate packages —
not for aesthetics, because they are different *categories* of code.
`devin-core` is a neutral protocol library ("how to talk to the Devin
backend") that any third party can depend on; `devin-engine` is the
compliance layer — the jailbreak. Merged into one package (even via
subpath exports), every consumer would pull the uncensored code into
node_modules whether imported or not. Split, the jailbreak only exists
in trees that explicitly `npm i devin-engine`. Drift between them is
low-risk: the surface the engine consumes (chat stream, catalog, auth)
is stable, and `contract.json` catches upstream changes in CI.

## Interconnection contract

- `devin-core/contract.json` — golden catalog fixture; every consumer's
  test suite asserts its parser yields the same uid set. Drift → red CI.
- Every repo's README carries an "Ecosystem" section listing the sibling
  packages and which layer each one sits at.
- Topic `devin-ecosystem` on every GitHub repo groups them at
  github.com/topics/devin-ecosystem.

## Refactor state

- [x] decision log + naming (this file)
- [x] devin-proxy: SWE-2.1 family routed (5 effort lanes)
- [ ] devin-core: extract `src/protocol` + `src/auth` from devin-opencode,
      reconcile the 4 divergent files vs devin-claude
- [ ] rewire devin-opencode + devin-claude to import devin-core
- [ ] devin-engine: port `devin_proxy/{pipeline,jailbreak,models}` to TS
- [ ] devin-proxy: Python → TS over devin-engine (Python kept until parity)
- [ ] cost/promo surfacing (`billingTag`, `/v1/models` fields, header)
- [ ] renames + topics + ecosystem READMEs + npm publish

## Renames queued

None — the `<host>-devin` convention means `opencode-devin` and
`claude-devin` are already correctly named. Only `devin-core` and
`devin-engine` are created new.
