/**
 * OpenCode v2 plugin: Devin / Cognition.
 *
 * - Integration `devin` with the Devin CLI login flow (PKCE, same as chisel)
 *   so `/connect` stores the credential natively: automated browser flow and
 *   a paste-code fallback for headless machines.
 * - Provider `devin` streaming chat through Cognition's Cascade protocol
 *   (src/protocol/), with the live per-account catalog published as
 *   `devin/*` models.
 *
 * The provider inventory re-publishes automatically whenever a credential is
 * connected, switched, or removed.
 */

import { Plugin, Provider } from "@opencode/plugin"
import { DEFAULT_API_SERVER, LLM_ENV_VAR, PROVIDER_ID } from "./constants.ts"
import { resolveCredentials, toStoredCredential } from "./credentials.ts"
import { startCallbackServer } from "./auth/loopback.ts"
import { authorizeUrl } from "./auth/url.ts"
import { challengeFor, generateState, generateVerifier } from "./auth/pkce.ts"
import { exchangeCode } from "./auth/exchange.ts"
import { fetchModels } from "./catalog.ts"

export { createDevinProvider } from "./provider.ts"

function openBrowser(url: string): void {
  if (process.platform === "win32") {
    // `cmd /c start` truncates URLs at "&" (cmd metacharacter) when spawned
    // from Bun — rundll32 hands the URL to the default browser verbatim.
    Bun.spawn(["rundll32", "url.dll,FileProtocolHandler", url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    return
  }
  const cmd = process.platform === "darwin" ? ["open", url] : ["xdg-open", url]
  Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
}

export default Plugin.define({
  id: PROVIDER_ID,
  async setup(ctx) {
    const publish = async () => {
      const credentials = await resolveCredentials(ctx)
      if (!credentials) return
      const models = await fetchModels(credentials.apiKey, credentials.apiServerUrl)
      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
            name: "Devin",
            activation: "enabled",
            // `aisdk:` routes through opencode's dynamic AI-SDK provider
            // loader. The specifier self-references this package's own
            // location: the repo checkout during development, or the plugin's
            // npm cache copy once installed — either way the loader imports
            // it directly, with no registry round-trip.
            package: `aisdk:${new URL("..", import.meta.url).href}`,
            settings: {
              apiKey: credentials.apiKey,
              baseURL: credentials.apiServerUrl ?? DEFAULT_API_SERVER,
            },
          },
          models,
        })
      })
    }

    await ctx.integration.transform((editor) => {
      editor.update(PROVIDER_ID, (integration) => {
        integration.name = "Devin"
      })

      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: "devin", type: "oauth", label: "Log in with Devin (browser)" },
        authorize: async () => {
          const verifier = generateVerifier()
          const state = generateState()
          const server = await startCallbackServer(state)
          const url = authorizeUrl({ state, challenge: await challengeFor(verifier), redirectUri: server.redirectUri })
          openBrowser(url)
          return {
            url,
            instructions: `Log in to Devin in the opened browser tab. If it did not open, go to: ${url}`,
            mode: "auto" as const,
            callback: (async () => {
              try {
                const code = await server.code
                return toStoredCredential(await exchangeCode({ code, verifier }))
              } finally {
                server.close()
              }
            })(),
          }
        },
      })

      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: "code", type: "oauth", label: "Paste code (headless)" },
        authorize: async () => {
          const verifier = generateVerifier()
          const state = generateState()
          return {
            url: authorizeUrl({ state, challenge: await challengeFor(verifier) }),
            instructions:
              "Open the URL, sign in to Devin, and copy the code shown on the page, then paste it here.",
            mode: "code" as const,
            callback: async (code: string) => toStoredCredential(await exchangeCode({ code: code.trim(), verifier })),
          }
        },
      })

      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "env", names: [LLM_ENV_VAR] },
      })
    })

    await publish().catch((error) => {
      console.error("[opencode-devin] initial load failed:", error)
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "credential.updated" || event.type === "credential.switched") {
          await publish().catch(() => {})
        }
      }
    })()

    return () => controller.abort()
  },
})
