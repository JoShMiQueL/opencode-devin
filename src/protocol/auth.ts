/**
 * `GetUserJwt` — mints the short-lived `user_jwt` required by catalog and chat
 * RPCs. The long-lived session token alone is not accepted.
 *
 * The real lifetime comes from the token's own `exp` claim; the cache only
 * trusts it, and falls back to {@link FALLBACK_JWT_TTL_SECONDS} when `exp` is
 * missing or unparseable. Observed tokens run roughly 24 minutes.
 *
 * Originally ported from pi-devin-auth (MIT, Copyright (c) 2026 nmzpy).
 */

import { encodeMessage, iterFields } from "./wire.ts"
import { buildMetadata } from "./metadata.ts"
import { DEFAULT_API_SERVER } from "../constants.ts"

const MINT_TIMEOUT_MS = 30_000

/**
 * Assumed lifetime when the token carries no readable `exp`. Deliberately
 * shorter than the observed ~24 minutes: a too-short assumption costs one extra
 * mint, a too-long one keeps sending a token the server will reject.
 */
const FALLBACK_JWT_TTL_SECONDS = 600

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

  let expiresAt = Math.floor(Date.now() / 1000) + FALLBACK_JWT_TTL_SECONDS
  try {
    const parts = jwt.split(".")
    const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4)
    const payload = JSON.parse(Buffer.from(pad(parts[1]!).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
      exp?: number
    }
    if (typeof payload.exp === "number") expiresAt = payload.exp
  } catch {
    // non-JWT payload — keep the conservative fallback
  }
  return { jwt, expiresAt }
}

/**
 * Separator for composite cache keys.
 *
 * 0x1F (unit separator) cannot appear in a host or a token, so keys built from
 * them are unambiguous. It is spelled as an escape rather than a literal control
 * byte so it stays visible in diffs and review: silently dropped by a re-encode,
 * `host="a" key="bc"` would collide with `host="ab" key="c"` and two different
 * credentials would share a cached session.
 */
const KEY_SEPARATOR = "\x1f"

/** Cache key for one credential against one host. */
export const credentialKey = (host: string, apiKey: string): string => `${host}${KEY_SEPARATOR}${apiKey}`

let cache: (UserJwt & { apiKey: string; host: string }) | null = null
const inFlight = new Map<string, Promise<UserJwt>>()
let cacheEpoch = 0

/** Mint a user_jwt, reusing a cached one until shortly before expiry. */
export async function getCachedUserJwt(apiKey: string, host = DEFAULT_API_SERVER, signal?: AbortSignal): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cache && cache.apiKey === apiKey && cache.host === host && cache.expiresAt > now + 60) {
    return cache.jwt
  }
  const key = credentialKey(host, apiKey)
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
