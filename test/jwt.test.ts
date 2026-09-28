import { afterEach, describe, expect, test } from "bun:test"
import { clearCachedUserJwt, credentialKey, getCachedUserJwt } from "../src/protocol/auth.ts"
import { streamChatEvents } from "../src/protocol/chat.ts"
import { encodeString } from "../src/protocol/wire.ts"

const HOST = "https://tenant.test"
const API_KEY = "devin-session-token$test"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  clearCachedUserJwt()
})

/** A syntactically valid JWT, with an `exp` the decoder will pick up. */
const jwt = (exp: number, tag: string) => {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp, tag })}.${b64({ sig: tag })}`
}

/** The `GetUserJwt` reply is field 1 (length-delimited) holding the token. */
const mintBody = (token: string) => new Uint8Array(encodeString(1, token))

const secondsFromNow = (delta: number) => Math.floor(Date.now() / 1000) + delta

/** Route by URL so a single stub can serve both RPCs. */
const stubFetch = (handler: (url: string) => Response) => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => Promise.resolve(handler(String(input)))) as typeof fetch
}

const isMint = (url: string) => url.includes("GetUserJwt")
const isChat = (url: string) => url.includes("GetChatMessage")

const drain = async (it: AsyncGenerator<unknown>) => {
  for await (const _ of it) {
    // exhaust the generator so the request is actually issued
  }
}

describe("credentialKey", () => {
  test("cannot collide across a host/credential boundary", () => {
    // Without a separator these would be the same key, and two credentials
    // would share a cached session.
    expect(credentialKey("h", "ab")).not.toBe(credentialKey("ha", "b"))
  })
})

describe("user_jwt cache", () => {
  test("mints once and reuses the cached token", async () => {
    let mints = 0
    stubFetch((url) => {
      if (!isMint(url)) return new Response("unexpected", { status: 500 })
      mints++
      return new Response(mintBody(jwt(secondsFromNow(600), "one")), { status: 200 })
    })

    const first = await getCachedUserJwt(API_KEY, HOST)
    const second = await getCachedUserJwt(API_KEY, HOST)
    expect(mints).toBe(1)
    expect(second).toBe(first)
  })

  test("keeps tokens for different credentials apart", async () => {
    stubFetch((url) => {
      const tag = url.includes(HOST) ? "hostA" : "hostB"
      return isMint(url) ? new Response(mintBody(jwt(secondsFromNow(600), tag)), { status: 200 }) : new Response("", { status: 500 })
    })

    const a = await getCachedUserJwt(API_KEY, HOST)
    const b = await getCachedUserJwt(API_KEY, "https://other.test")
    expect(a).not.toBe(b)
  })

  test("re-mints once the cached token is inside the refresh window", async () => {
    let mints = 0
    stubFetch((url) => {
      if (!isMint(url)) return new Response("unexpected", { status: 500 })
      mints++
      return new Response(mintBody(jwt(secondsFromNow(30), `mint-${mints}`)), { status: 200 })
    })

    await getCachedUserJwt(API_KEY, HOST)
    // 30s left is inside the 60s lookahead, so the second call must re-mint.
    await getCachedUserJwt(API_KEY, HOST)
    expect(mints).toBe(2)
  })

  test("clearCachedUserJwt forces the next call to re-mint", async () => {
    let mints = 0
    stubFetch((url) => {
      if (!isMint(url)) return new Response("unexpected", { status: 500 })
      mints++
      return new Response(mintBody(jwt(secondsFromNow(600), `mint-${mints}`)), { status: 200 })
    })

    const before = await getCachedUserJwt(API_KEY, HOST)
    clearCachedUserJwt()
    const after = await getCachedUserJwt(API_KEY, HOST)
    expect(mints).toBe(2)
    expect(after).not.toBe(before)
  })
})

// A rejected token is just as stale as an expired one, and used to be replayed
// for the rest of its lifetime, so every 401 needed a manual re-connect.
describe("401 invalidates the cached user_jwt", () => {
  const primeTheCache = async () => {
    let mints = 0
    stubFetch((url) => {
      if (isMint(url)) {
        mints++
        return new Response(mintBody(jwt(secondsFromNow(600), `mint-${mints}`)), { status: 200 })
      }
      return new Response("unauthorized", { status: 401, statusText: "Unauthorized" })
    })
    const first = await getCachedUserJwt(API_KEY, HOST)
    return { first, mints: () => mints }
  }

  test("a 401 from chat drops the cached token so the retry mints a fresh one", async () => {
    const { first, mints } = await primeTheCache()
    expect(mints()).toBe(1)

    await expect(
      drain(streamChatEvents({ apiKey: API_KEY, apiServerUrl: HOST, modelUid: "swe-2-max", messages: [] })),
    ).rejects.toThrow(/401/)

    const retried = await getCachedUserJwt(API_KEY, HOST)
    expect(mints()).toBe(2)
    expect(retried).not.toBe(first)
  })

  test("a non-401 chat failure leaves the cached token alone", async () => {
    const { first, mints } = await primeTheCache()

    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (isMint(url)) return Promise.resolve(new Response(mintBody(jwt(secondsFromNow(600), "cached")), { status: 200 }))
      return Promise.resolve(new Response("boom", { status: 500 }))
    }) as typeof fetch

    await expect(
      drain(streamChatEvents({ apiKey: API_KEY, apiServerUrl: HOST, modelUid: "swe-2-max", messages: [] })),
    ).rejects.toThrow(/500/)

    // Still cached: a server error says nothing about the credential.
    expect(await getCachedUserJwt(API_KEY, HOST)).toBe(first)
    expect(mints()).toBe(1)
  })
})
