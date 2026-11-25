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
- [x] devin-proxy (Python): SWE-2.1 family routed (5 effort lanes)
- [x] devin-core: extracted `src/protocol` + `src/auth` from opencode-devin,
      AI-SDK removed, node:http port, AI-SDK-compatible `DevinApiError` marker
- [x] rewired opencode-devin (#19 merged, 156 tests) + claude-devin
      (#26 merged to develop, 45 tests) to import `devin-core@^0.0.3`
- [x] devin-engine: `devin_proxy/{pipeline,jailbreak,models}` ported to TS
      (26 unit tests)
- [x] devin-proxy: Python → TS over devin-engine, full parity —
      chat/SSE/models/health/image_caption/web_search verified live
- [x] cost/promo surfacing: `free_until`/`credits_per_run`/`free_tier` in
      /v1/models + /health (GetCliModelConfigs fields 3/19/23)
- [x] npm publish: devin-core@0.0.3, devin-engine@0.0.3, devin-proxy@0.1.1
- [x] renames: devin-proxy = TS, Python → devin-proxy-py
- [x] OIDC Trusted Publishing on all 3 packages (publish.yml workflow)
- [x] claude-devin develop → main merged (#28); release PR #29 open
- [x] devin-proxy-py archived (superseded notice in README)
- [x] normal/uncensored mode toggle: EngineSettings.mode (engine 0.0.4),
      devin-proxy `--mode`/`DEVIN_PROXY_MODE`/settings.toml (proxy 0.2.0)

## Renames done

- `opencode-devin`, `claude-devin` — unchanged (the `<host>-devin`
  convention already names them correctly).
- `devin-core`, `devin-engine` — created new (master branches).
- `devin-proxy` — now the TypeScript proxy (was the Python repo).
  Python moved to `devin-proxy-py` (reference, kept green).
- npm: `devin-proxy` publishes the TS package.

## CI / release standard (all repos)

Same 4 workflows in every package (opencode-devin is the reference):

| Workflow | Trigger | Job |
| --- | --- | --- |
| `ci.yml` | push main/master + PRs | typecheck → build → test on ubuntu/windows/macos |
| `release-please.yml` | push main/master | opens/updates the release PR, tags + GH Release on merge |
| `pr-title.yml` | PR opened/edited | enforces Conventional Commits on the squash title |
| `publish.yml` | `v*` tag / `release: published` / dispatch | verify tag==pkg.version → test → OIDC `npm publish --provenance`, skips if already on npm |

`devin-proxy-py` and `claude-devin` keep their own flows (Python release,
GitFlow develop→main). Dependabot only where the lockfile is supported —
bun.lock isn't, so npm ecosystems were dropped.

## How work flows (all active repos)

- **`main` is the only long-lived branch** (claude-devin keeps GitFlow:
  `develop` → `main`). `main` is protected everywhere: no direct push, no
  force-push, required checks must pass.
- **Everything lands via PR.** Branch off `main`, open the PR with a
  conventional-commits title, squash-merge on green.
- **release-please cuts releases.** Merging its release PR tags `vX.Y.Z`,
  creates the GitHub Release, and triggers `npm-publish` (OIDC, provenance).
- **Shared CI** lives in `JoShMiQueL/gh-actions` — each repo has one
  `main.yml` caller. Changes to CI go there once.

### Branch-protection baseline

| Repo | main | develop |
| --- | --- | --- |
| devin-core / devin-engine / devin-proxy | required: ci verify+test×3, pr-title, release-please | — |
| opencode-devin | same set | — |
| claude-devin | verify, test×2, branch-gate | verify, test×2 |
| gh-actions | no direct push (no CI of its own) | — |
