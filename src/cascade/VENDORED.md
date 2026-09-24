# Vendored: Cascade gRPC protocol client

This directory contains a vendored copy of [`ai-sdk-devin`](https://www.npmjs.com/package/ai-sdk-devin)
v0.3.6 (`dist/` output, byte-for-byte, with its `.d.ts` declarations), which
implements Cognition's Cascade wire protocol:

| File | Role |
| --- | --- |
| `wire.js` | Hand-rolled protobuf encoding + Connect-RPC streaming envelope |
| `metadata.js` | `Metadata` proto builder sent with every RPC |
| `auth.js` | `GetUserJwt` — mints the short-lived `user_jwt` for chat RPCs |
| `catalog.js` | `GetCascadeModelConfigs` — per-account model catalog |
| `chat.js` | `GetChatMessage` — chat streaming |
| `index.js` | AI SDK `LanguageModelV3` provider facade |

## Why vendored

The Cascade protocol is the only inference path provisioned for most accounts
(the OpenAI-compatible REST gateway is not), and it is undocumented — the
implementation is reverse-engineered. Depending on a third-party npm package
on the credential path is supply-chain risk we are not willing to take, so the
audited code lives here instead, reviewed line by line:

- Single network endpoint: `https://server.codeium.com` (Cascade RPCs only).
- No `eval`, dynamic code loading, telemetry, or obfuscation.

## Provenance and license

- Upstream: `ai-sdk-devin` (MIT) by karthiknish.
- Upstream itself ports from `pi-devin-auth` (MIT, Copyright (c) 2026 nmzpy).

Both licenses are MIT; this vendored copy remains subject to them, and this
repository is MIT as well. Keep this notice when updating the vendored code.
