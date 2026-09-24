/**
 * OpenCode v2 plugin: Devin / Cognition.
 *
 * - Integration `devin` with two Windsurf OAuth methods so `/connect` stores
 *   the credential natively: an automated browser flow (loopback callback)
 *   and a manual token paste that works with an existing browser session.
 * - Provider `devin` publishing the per-account model catalog as `devin/*`
 *   models, streamed through the `ai-sdk-devin` provider package.
 *
 * The provider inventory re-publishes automatically whenever a credential is
 * connected, switched, or removed.
 */

import { Plugin, Provider } from "@opencode/plugin"
import { PROVIDER_ID } from "./constants.ts"
import { resolveCredentials, toStoredCredential } from "./credentials.ts"
import { buildTokenUrl } from "./oauth/url.ts"
import { prepareLogin } from "./oauth/loopback.ts"
import { registerUser } from "./oauth/register.ts"
import { fetchModels } from "./catalog.ts"

export { createDevinProvider } from "./provider.ts"

export default Plugin.define({
  id: PROVIDER_ID,
  async setup(ctx) {
    const publish = async () => {
      const credentials = await resolveCredentials(ctx)
      if (!credentials) return
      const models = await fetchModels(credentials.apiKey)
      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
            name: "Devin",
            activation: "enabled",
            // `aisdk:` routes through opencode's dynamic AI-SDK provider
            // loader, which imports this package and calls its `create*`
            // factory with the settings below.
            package: "aisdk:opencode-devin",
            settings: {
              apiKey: credentials.apiKey,
              baseURL: credentials.apiServerUrl,
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
        method: { id: "windsurf", type: "oauth", label: "Sign in with Windsurf (browser)" },
        authorize: async () => {
          const login = await prepareLogin()
          return {
            url: login.url,
            instructions: login.instructions,
            mode: "auto" as const,
            callback: login.awaitToken().then(toStoredCredential),
          }
        },
      })

      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: "token", type: "oauth", label: "Paste token from windsurf.com" },
        authorize: async () => ({
          url: buildTokenUrl(),
          instructions:
            "Open the URL and copy the token shown in the code block on the page (sign in first if asked), then paste it here.",
          mode: "code" as const,
          callback: async (code: string) => toStoredCredential(await registerUser(code)),
        }),
      })

      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "env", names: ["DEVIN_LLM_API_KEY"] },
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
