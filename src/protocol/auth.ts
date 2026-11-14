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

import { APICallError } from "@ai-sdk/provider"
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

/**
 * An `APICallError`, so the host sees the status: a rejected session token is
 * then reported as an auth failure instead of being retried as unknown.
 */
export class CloudAuthError extends APICallError {
  readonly status: number
  constructor(message: string, status: number, url = "") {
    // A 200 that carries no token is a server-side fault, not a success.
    super({ message, url, requestBodyValues: undefined, statusCode: status >= 400 ? status : 502 })
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
  const url = `${host.replace(/\/$/, "")}/exa.auth_pb.AuthService/GetUserJwt`
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body: new Uint8Array(request),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })

  const buf = Buffer.from(await response.arrayBuffer())
  if (!response.ok) {
    throw new CloudAuthError(`GetUserJwt HTTP ${response.status}: ${buf.toString("utf8").slice(0, 400)}`, response.status, url)
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
    throw new CloudAuthError(`GetUserJwt 200 but no field-1 JWT found (${buf.length} bytes)`, response.status, url)
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

/** Settle with `promise`, or reject as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

/** Mint a user_jwt, reusing a cached one until shortly before expiry. */
export async function getCachedUserJwt(apiKey: string, host = DEFAULT_API_SERVER, signal?: AbortSignal): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cache && cache.apiKey === apiKey && cache.host === host && cache.expiresAt > now + 60) {
    return cache.jwt
  }
  const key = credentialKey(host, apiKey)
  let pending = inFlight.get(key)
  if (!pending) {
    const epochAtStart = cacheEpoch
    // The mint is shared by every caller waiting on this credential, so it must
    // not be tied to one caller's signal: cancelling that request would fail
    // the others. It is bounded by its own timeout instead.
    const shared: Promise<UserJwt> = mintUserJwt(apiKey, host)
      .then((minted) => {
        if (cacheEpoch === epochAtStart) cache = { ...minted, apiKey, host }
        return minted
      })
      .finally(() => {
        if (inFlight.get(key) === shared) inFlight.delete(key)
      })
    inFlight.set(key, shared)
    pending = shared
  }
  return (await untilAborted(pending, signal)).jwt
}

/** Drop the cached user_jwt (e.g. after an auth failure). */
export function clearCachedUserJwt(): void {
  cache = null
  inFlight.clear()
  cacheEpoch++
}
