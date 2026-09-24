/**
 * Windsurf credential resolution.
 *
 * The chat credential is a long-lived Windsurf OAuth token
 * (`devin-session-token$<JWT>`). Sources, in priority order:
 *
 *   1. `DEVIN_LLM_API_KEY` environment variable
 *   2. the credential stored by opencode's `/connect` (this plugin's integration)
 *   3. `~/.config/opencode-windsurf-auth/credentials.json`, written by
 *      `npx opencode-windsurf-auth login` (kept for users migrating from the
 *      v1 tooling)
 */

import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Credential } from "@opencode/plugin"
import { CREDENTIAL_TTL_MS, DEFAULT_API_SERVER, LLM_ENV_VAR, WINDSURF_AUTH_FILE } from "./constants.ts"
import type { WindsurfCredentials } from "./oauth/register.ts"

export type { WindsurfCredentials }

export type PluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

function fromEnv(): WindsurfCredentials | undefined {
  const apiKey = process.env[LLM_ENV_VAR]
  if (!apiKey?.startsWith("devin-session-token$")) return undefined
  return { apiKey, name: "env", apiServerUrl: DEFAULT_API_SERVER }
}

function fromStoredConnection(ctx: PluginContext): Promise<WindsurfCredentials | undefined> {
  return (async () => {
    const connection = await ctx.integration.connection.active("devin")
    if (!connection) return undefined
    const value = await ctx.integration.connection.resolve(connection)
    const access = value?.type === "oauth" ? value.access : value?.type === "key" ? value.key : undefined
    if (!access?.startsWith("devin-session-token$")) return undefined
    const metadata = value?.type === "oauth" ? value.metadata : undefined
    return {
      apiKey: access,
      name: typeof metadata?.name === "string" ? metadata.name : "opencode",
      apiServerUrl:
        typeof metadata?.apiServerUrl === "string" ? metadata.apiServerUrl : DEFAULT_API_SERVER,
    }
  })().catch(() => undefined)
}

async function fromWindsurfAuthFile(): Promise<WindsurfCredentials | undefined> {
  try {
    const data = JSON.parse(
      await Bun.file(path.join(os.homedir(), WINDSURF_AUTH_FILE)).text(),
    ) as {
      apiKey?: string
      name?: string
      apiServerUrl?: string
    }
    if (!data.apiKey?.startsWith("devin-session-token$")) return undefined
    return {
      apiKey: data.apiKey,
      name: data.name ?? "windsurf",
      apiServerUrl: data.apiServerUrl || DEFAULT_API_SERVER,
    }
  } catch {
    return undefined
  }
}

/** Resolve the active Windsurf credentials, or `undefined` when not connected. */
export async function resolveCredentials(ctx: PluginContext): Promise<WindsurfCredentials | undefined> {
  return (await fromEnv()) ?? (await fromStoredConnection(ctx)) ?? (await fromWindsurfAuthFile())
}

/** Build the opencode credential object stored by `/connect`. */
export function toStoredCredential(credentials: WindsurfCredentials): Credential.OAuth {
  return {
    type: "oauth",
    methodID: "windsurf" as Credential.OAuth["methodID"],
    refresh: "",
    access: credentials.apiKey,
    expires: Date.now() + CREDENTIAL_TTL_MS,
    metadata: { name: credentials.name, apiServerUrl: credentials.apiServerUrl },
  }
}
