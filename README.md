# opencode-devin

[OpenCode v2](https://opencode.ai) plugin that connects your [Devin](https://devin.ai) / Windsurf subscription to OpenCode:

- **Native `/connect` integration** — sign in with Windsurf straight from the OpenCode TUI. The credential is stored in OpenCode's own auth store; no config files or env vars required.
- **`devin/*` models in `/models`** — the live, per-account catalog (SWE, Claude Opus, GPT, Gemini, DeepSeek, Grok, Kimi and more, with reasoning-effort and speed variants), streamed from Cognition's inference gateway.

> **Requires OpenCode v2.** This plugin targets the v2 plugin API (`Plugin.define`). The official [`@cognitionai/opencode-devin`](https://www.npmjs.com/package/@cognitionai/opencode-devin) plugin is v1-only at the time of writing and does not load on v2.

## Install

Add the plugin to `opencode.json` (project or `~/.config/opencode/opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-devin"]
}
```

OpenCode installs it automatically on the next start.

## Connect

Start OpenCode, run `/connect`, pick **Devin**, then choose a method:

| Method | How it works | Best for |
| --- | --- | --- |
| **Sign in with Windsurf (browser)** | Opens the Windsurf sign-in page and captures the token through a local loopback callback. | Fresh logins |
| **Paste token from windsurf.com** | Opens a page that renders the token in a code block; copy and paste it back into the TUI. | Already signed in to windsurf.com in the browser (no re-login needed) |
| **`DEVIN_LLM_API_KEY`** | Reads the token from the environment. | Headless machines, CI |

After connecting, the model list refreshes automatically and `devin/<model>` entries appear in `/models`.

### Environment variable alternative

Skip `/connect` entirely by exporting a Windsurf OAuth token:

```sh
export DEVIN_LLM_API_KEY=devin-session-token$your_token_here
```

Tokens issued by `npx opencode-windsurf-auth login` (stored in `~/.config/opencode-windsurf-auth/credentials.json`) are picked up automatically as a fallback.

## Use

Pick any `devin/` model in the `/models` picker, or set a default:

```jsonc
// opencode.json
{
  "model": "devin/swe-2-max"
}
```

From the CLI:

```sh
opencode run --model devin/swe-2-max "Refactor the auth module"
opencode run --model devin/claude-opus-4-8:high "Review my changes"
```

## How it works

```
/connect ──▶ Windsurf OAuth (implicit grant) ──▶ devin-session-token$<JWT>
                    │                                    │
                    ▼                                    ▼
        stored as an OpenCode credential        per-account model catalog
                                                    │
                                                    ▼
                              provider `devin` (aisdk:opencode-devin)
                                                    │
                                                    ▼
                          ai-sdk-devin ──▶ Codeium gRPC (GetUserJwt + GetChatMessage)
```

1. **Integration** — the plugin registers a `devin` integration with OAuth methods. `/connect` runs the browser flow (loopback callback or manual paste) and exchanges the short-lived `firebase_id_token` for the long-lived `devin-session-token$<JWT>` via Windsurf's `RegisterUser` endpoint.
2. **Provider** — the plugin publishes a `devin` provider whose model inventory is the account's live catalog. The provider package (`aisdk:opencode-devin`) is loaded by OpenCode's dynamic AI-SDK loader and wraps [`ai-sdk-devin`](https://www.npmjs.com/package/ai-sdk-devin), which implements Cognition's gRPC wire protocol: a short-lived `user_jwt` is minted per session (`GetUserJwt`) and chat streams through `GetChatMessage`.
3. **Reactivity** — the inventory re-publishes whenever a credential is connected, switched, or removed, so connecting mid-session updates `/models` without a restart.

## Troubleshooting

- **No `devin/` models** — the credential is missing or the catalog fetch failed. Run `/connect` again, or check the token with `curl -H "Authorization: Bearer $DEVIN_LLM_API_KEY" https://server.codeium.com/...`.
- **Browser flow opens but nothing happens** — if you are already signed in to windsurf.com, the sign-in page may not round-trip automatically. Use the **Paste token** method instead; it renders the token directly.
- **401 during chat** — the session token was revoked. Re-run `/connect`.

## Development

```sh
npm install
npm run typecheck
npm run build     # emits dist/
```

To test a local checkout without publishing, create a bridge file that re-exports the build:

```ts
// ~/.config/opencode/plugins/devin.ts
export { default } from "file:///absolute/path/to/opencode-devin/dist/index.js"
```

## Credits

- [`ai-sdk-devin`](https://www.npmjs.com/package/ai-sdk-devin) by [karthiknish](https://github.com/karthiknish) — Codeium gRPC client and model catalog.
- [`opencode-windsurf-auth`](https://github.com/rsvedant/opencode-windsurf-auth) — reverse-engineering notes for the Windsurf OAuth flow and Connect-RPC exchange.

## License

[MIT](LICENSE)
