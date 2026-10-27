# Changelog

All notable changes to this project are documented in this file. It is
generated automatically by [release-please](https://github.com/googleapis/release-please)
from [Conventional Commits](https://www.conventionalcommits.org/).

## [0.2.1](https://github.com/JoShMiQueL/opencode-devin/compare/v0.2.0...v0.2.1) (2026-10-27)


### Bug Fixes

* exact-label pricing match + decode tests, shared login helpers, devin CLI ([#4](https://github.com/JoShMiQueL/opencode-devin/issues/4)) ([5963429](https://github.com/JoShMiQueL/opencode-devin/commit/5963429651c58b190d3e3ddf83a7b928a0d2d69a))

## [0.2.0](https://github.com/JoShMiQueL/opencode-devin/compare/v0.1.1...v0.2.0) (2026-09-28)

### Bug Fixes

* correct cancellation, tool-call framing and auth invalidation ([#1](https://github.com/JoShMiQueL/opencode-devin/pull/1)) ([32c65e8](https://github.com/JoShMiQueL/opencode-devin/commit/32c65e86d3ded7dc02e46e21129fe9f0288a9bd6))

### Build System

* upgrade to TypeScript 7 (native compiler) ([77915b7](https://github.com/JoShMiQueL/opencode-devin/commit/77915b72b6a9feda90ec456615a0b2563ab693b6))

### Documentation

* render the how-it-works diagram with Mermaid ([84fa717](https://github.com/JoShMiQueL/opencode-devin/commit/84fa7170275d7e4dad230354d58051bd7957f13e))

### Continuous Integration

* bump actions/checkout to v7 and drop deprecated Node 20 target ([fd619a4](https://github.com/JoShMiQueL/opencode-devin/commit/fd619a4))
* pin runner to ubuntu-24.04 ahead of the ubuntu-latest Ubuntu 26 migration ([813717e](https://github.com/JoShMiQueL/opencode-devin/commit/813717e))
* move to the ubuntu-26.04 runner ahead of the ubuntu-latest migration ([b3fd42e](https://github.com/JoShMiQueL/opencode-devin/commit/b3fd42e))
* cache the bun package store keyed on the lockfile ([c4d65aa](https://github.com/JoShMiQueL/opencode-devin/commit/c4d65aa))
* pin the bun version for a stable binary cache and reproducible runs ([f58ab25](https://github.com/JoShMiQueL/opencode-devin/commit/f58ab25))

## [0.1.1](https://github.com/JoShMiQueL/opencode-devin/compare/v0.1.0...v0.1.1) (2026-09-24)

### Bug Fixes

* open the login URL with rundll32 on Windows ([f518ddb](https://github.com/JoShMiQueL/opencode-devin/commit/f518ddb2f2280b646a1b3d5173395000a7969a26))

### Continuous Integration

* upgrade npm for trusted publishing OIDC support ([9630965](https://github.com/JoShMiQueL/opencode-devin/commit/96309656cc8af6174c02b5075261869379d44a2c))

## 0.1.0 (2026-09-24)

### Features

* initial release: Devin provider for OpenCode v2 with `/connect` PKCE login and `devin/*` models from the live Cascade catalog
