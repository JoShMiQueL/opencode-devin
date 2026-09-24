# Attribution — Cascade protocol implementation

The TypeScript modules in this directory implement Cognition's Cascade wire
protocol (protobuf framing, `GetUserJwt`, `GetCascadeModelConfigs`,
`GetChatMessage`). The protocol is undocumented; the field layouts were
reverse-engineered from the Windsurf language_server and the Devin CLI.

## Provenance

This is a typed TypeScript port of the audited `ai-sdk-devin` v0.3.6
implementation, which itself ports `pi-devin-auth`:

- `ai-sdk-devin` (MIT) by [karthiknish](https://github.com/karthiknish)
- `pi-devin-auth` (MIT, Copyright (c) 2026 nmzpy)

Both upstream projects are MIT licensed; this port preserves their copyright
notices and remains subject to the MIT license (see the repository LICENSE).

## Security notes

- Single network endpoint: `https://server.codeium.com` (Cascade RPCs only).
- No `eval`, dynamic code loading, telemetry, or obfuscation.
- The port was verified end-to-end against the live protocol (catalog + chat).
