/**
 * Devin credential resolution.
 *
 * The chat credential is a long-lived session token
 * (`devin-session-token$<JWT>`), issued either by the Devin CLI login flow
 * (PKCE) or by Windsurf OAuth. Sources, in priority order:
 *
 *   1. `DEVIN_LLM_API_KEY` environment variable
 *   2. the credential stored by opencode's `/connect` (this plugin's integration)
 */

import type { Plugin } from "@opencode/plugin"
import { Credential } from "@opencode/plugin"
import { CREDENTIAL_TTL_MS, DEFAULT_API_SERVER, LLM_ENV_VAR, PROVIDER_ID, TOKEN_PREFIX } from "./constants.ts"

export interface DevinCredentials {
  apiKey: string
  name: string
  /** Tenant-scoped inference host; empty means the default Codeium server. */
  apiServerUrl?: string
}

export type PluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

function fromEnv(): DevinCredentials | undefined {
  const apiKey = process.env[LLM_ENV_VAR]
  if (!apiKey?.startsWith(TOKEN_PREFIX)) return undefined
  return { apiKey, name: "env" }
}

async function fromStoredConnection(ctx: PluginContext): Promise<DevinCredentials | undefined> {
  try {
    const connection = await ctx.integration.connection.active(PROVIDER_ID)
    if (!connection) return undefined
    const value = await ctx.integration.connection.resolve(connection)
    const access = value?.type === "oauth" ? value.access : value?.type === "key" ? value.key : undefined
    if (!access?.startsWith(TOKEN_PREFIX)) return undefined
    const metadata = value?.type === "oauth" ? value.metadata : undefined
    return {
      apiKey: access,
      name: typeof metadata?.name === "string" ? metadata.name : "opencode",
      apiServerUrl: typeof metadata?.apiServerUrl === "string" ? metadata.apiServerUrl : undefined,
    }
  } catch {
    return undefined
  }
}

/** Resolve the active Devin credentials, or `undefined` when not connected. */
export async function resolveCredentials(ctx: PluginContext): Promise<DevinCredentials | undefined> {
  return (await fromEnv()) ?? (await fromStoredConnection(ctx))
}

/** Build the opencode credential object stored by `/connect`. */
export function toStoredCredential(
  apiKey: string,
  name = "opencode",
  apiServerUrl?: string,
): Credential.OAuth {
  return {
    type: "oauth",
    methodID: "devin" as Credential.OAuth["methodID"],
    refresh: "",
    access: apiKey,
    expires: Date.now() + CREDENTIAL_TTL_MS,
    metadata: apiServerUrl ? { name, apiServerUrl } : { name },
  }
}
