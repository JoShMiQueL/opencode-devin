/**
 * `GetUserJwt` — mints the short-lived `user_jwt` required by catalog and chat
 * RPCs (~24 min TTL). The long-lived session token alone is not accepted.
 *
 * Originally ported from pi-devin-auth (MIT, Copyright (c) 2026 nmzpy).
 */

import { encodeMessage, iterFields } from "./wire.ts"
import { buildMetadata } from "./metadata.ts"
import { DEFAULT_API_SERVER } from "../constants.ts"

const MINT_TIMEOUT_MS = 30_000

export class CloudAuthError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "CloudAuthError"
    this.status = status
  }
}

export interface UserJwt {
  jwt: string
  expiresAt: number
}

/** Mint a fresh user_jwt for the given session token. */
export async function mintUserJwt(apiKey: string, host = DEFAULT_API_SERVER, signal?: AbortSignal): Promise<UserJwt> {
  const metadata = buildMetadata({
    apiKey,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  })
  const request = encodeMessage(1, metadata)
  const timeout = AbortSignal.timeout(MINT_TIMEOUT_MS)
  const response = await fetch(`${host.replace(/\/$/, "")}/exa.auth_pb.AuthService/GetUserJwt`, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body: new Uint8Array(request),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })

  const buf = Buffer.from(await response.arrayBuffer())
  if (!response.ok) {
    throw new CloudAuthError(`GetUserJwt HTTP ${response.status}: ${buf.toString("utf8").slice(0, 400)}`, response.status)
  }

  let jwt: string | null = null
  for (const field of iterFields(buf)) {
    if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const candidate = field.value.toString("utf8")
      if (/^eyJ[A-Za-z0-9_-]{10,}={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}$/.test(candidate)) {
        jwt = candidate
        break
      }
    }
  }
  if (!jwt) {
    throw new CloudAuthError(`GetUserJwt 200 but no field-1 JWT found (${buf.length} bytes)`, response.status)
  }

  let expiresAt = Math.floor(Date.now() / 1000) + 600
  try {
    const parts = jwt.split(".")
    const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4)
    const payload = JSON.parse(Buffer.from(pad(parts[1]!).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
      exp?: number
    }
    if (typeof payload.exp === "number") expiresAt = payload.exp
  } catch {
    // non-JWT payload — keep the 10-minute fallback
  }
  return { jwt, expiresAt }
}

let cache: (UserJwt & { apiKey: string; host: string }) | null = null
const inFlight = new Map<string, Promise<UserJwt>>()
let cacheEpoch = 0

/** Mint a user_jwt, reusing a cached one until shortly before expiry. */
export async function getCachedUserJwt(apiKey: string, host = DEFAULT_API_SERVER, signal?: AbortSignal): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cache && cache.apiKey === apiKey && cache.host === host && cache.expiresAt > now + 60) {
    return cache.jwt
  }
  const key = `${host}${apiKey}`
  const pending = inFlight.get(key)
  if (pending) return (await pending).jwt

  const promise = mintUserJwt(apiKey, host, signal)
  inFlight.set(key, promise)
  const epochAtStart = cacheEpoch
  try {
    const minted = await promise
    if (cacheEpoch === epochAtStart) {
      cache = { ...minted, apiKey, host }
    }
    return minted.jwt
  } finally {
    inFlight.delete(key)
  }
}

/** Drop the cached user_jwt (e.g. after an auth failure). */
export function clearCachedUserJwt(): void {
  cache = null
  inFlight.clear()
  cacheEpoch++
}
