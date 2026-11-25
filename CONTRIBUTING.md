# Contributing

## Workflow

Everything lands on `main` through a **pull request**. `main` is protected:
no direct pushes, no force-pushes, and the shared CI must pass.

```text
feature branch → PR → CI green (verify + test×3 + pr-title) → squash merge
                                                        ↓
                                            release-please opens a
                                            "release: vX.Y.Z" PR on next
                                            conventional-commit push
                                                        ↓
                                            merge release PR → tag + GH Release
                                                        ↓
                                            publish.yml → npm (OIDC, --provenance)
```

## Commits

**Conventional Commits** — `feat:`, `fix:`, `perf:`, `docs:`, `chore:`,
`ci:`, `refactor:`, `test:`, `deps:`. The PR title must follow it too
(it's what lands on `main` via squash). `feat:` → minor bump, `fix:`/`perf:` → patch.

## Pull requests

- Title: conventional commit, lowercase start (`ci: bump X`, not `Ci: Bump X`).
- Keep it one change per PR — release-please groups by commit type.
- CI runs `ci / verify` + `ci / test (ubuntu-24.04, windows-2022, macos-15)`
  + `pr-title / conventional-title` + `release / release-please`. All must
  pass.

## Releasing

Nothing to do manually — release-please maintains a release PR. Merging it
tags `vX.Y.Z`, creates the GitHub Release, and `npm-publish` pushes to npm
via trusted publishing (no token). If a version is already on npm the publish
step skips — re-running is safe.

## CI internals

All workflows are single callers into
[`JoShMiQueL/gh-actions`](https://github.com/JoShMiQueL/gh-actions)
reusable workflows (`ci`, `release`, `npm-publish`, `pr-title`). To change CI
behavior for every repo at once, edit there — not here.
