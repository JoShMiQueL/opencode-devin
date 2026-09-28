import { describe, expect, test } from "bun:test"
import { startCallbackServer } from "../src/auth/loopback.ts"
import { resolveCredentials, toStoredCredential } from "../src/credentials.ts"
import { CALLBACK_PATH } from "../src/constants.ts"

const STATE = "state-for-tests"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** True while something still answers on the loopback port. */
const reachable = async (port: number) => {
  try {
    await fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

const portOf = (server: { redirectUri: string }) => Number(new URL(server.redirectUri).port)

describe("loopback callback server", () => {
  test("binds loopback on an ephemeral port", async () => {
    const server = await startCallbackServer(STATE, 5_000)
    expect(server.redirectUri).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${CALLBACK_PATH}$`))
    server.close()
    await server.code.catch(() => {})
  })

  test("delivers the code and the success page on a valid redirect", async () => {
    const server = await startCallbackServer(STATE, 5_000)
    const res = await fetch(`${server.redirectUri}?state=${STATE}&code=AUTHCODE`)
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toContain("Signed in to Devin")
    await expect(server.code).resolves.toBe("AUTHCODE")
    server.close()
  })

  test("rejects a mismatched state without settling the promise", async () => {
    const server = await startCallbackServer(STATE, 5_000)
    let settled = false
    void server.code.then(
      () => (settled = true),
      () => (settled = true),
    )
    const res = await fetch(`${server.redirectUri}?state=WRONG&code=AUTHCODE`)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("Invalid state parameter")
    await sleep(50)
    expect(settled).toBe(false)
    server.close()
    await server.code.catch(() => {})
  })

  test("rejects a redirect with no code", async () => {
    const server = await startCallbackServer(STATE, 5_000)
    const res = await fetch(`${server.redirectUri}?state=${STATE}`)
    expect(res.status).toBe(400)
    server.close()
    await server.code.catch(() => {})
  })

  test("404s an unknown path", async () => {
    const server = await startCallbackServer(STATE, 5_000)
    const port = portOf(server)
    const res = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(res.status).toBe(404)
    server.close()
    await server.code.catch(() => {})
  })

  test("close() rejects the pending code and releases the port", async () => {
    const server = await startCallbackServer(STATE, 5_000)
    const port = portOf(server)
    server.close()
    await expect(server.code).rejects.toThrow("Login cancelled")
    await sleep(150)
    expect(await reachable(port)).toBe(false)
  })

  // The integration method registration has no cancellation hook, so an
  // abandoned sign-in relied on this timer to release the port.
  test("an abandoned sign-in times out and releases the port", async () => {
    const server = await startCallbackServer(STATE, 250)
    const port = portOf(server)
    expect(await reachable(port)).toBe(true)
    await expect(server.code).rejects.toThrow(/timed out/i)
    await sleep(150)
    expect(await reachable(port)).toBe(false)
  })

  test("does not leak a port when the sign-in completes normally", async () => {
    const server = await startCallbackServer(STATE, 5_000)
    const port = portOf(server)
    await fetch(`${server.redirectUri}?state=${STATE}&code=C`)
    await server.code
    // The listener must stay up long enough to deliver the success page; the
    // caller closes it once the code has been exchanged.
    expect(await reachable(port)).toBe(true)
    server.close()
    await sleep(150)
    expect(await reachable(port)).toBe(false)
  })
})

describe("credential resolution", () => {
  const original = process.env.DEVIN_LLM_API_KEY
  const reset = () => {
    if (original === undefined) delete process.env.DEVIN_LLM_API_KEY
    else process.env.DEVIN_LLM_API_KEY = original
  }

  test("prefers the environment variable", async () => {
    process.env.DEVIN_LLM_API_KEY = "devin-session-token$from-env"
    const creds = await resolveCredentials({} as never)
    expect(creds?.apiKey).toBe("devin-session-token$from-env")
    expect(creds?.name).toBe("env")
    reset()
  })

  test("ignores an env value without the token prefix", async () => {
    process.env.DEVIN_LLM_API_KEY = "not-a-devin-token"
    const ctx = {
      integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
    }
    expect(await resolveCredentials(ctx as never)).toBeUndefined()
    reset()
  })

  test("falls back to the stored connection", async () => {
    const ctx = {
      integration: {
        connection: {
          active: async () => ({ id: "devin" }),
          resolve: async () => ({
            type: "oauth",
            access: "devin-session-token$stored",
            metadata: { name: "my-account", apiServerUrl: "https://tenant.example" },
          }),
        },
      },
    }
    const creds = await resolveCredentials(ctx as never)
    expect(creds).toEqual({
      apiKey: "devin-session-token$stored",
      name: "my-account",
      apiServerUrl: "https://tenant.example",
    })
  })

  test("accepts a key-type credential", async () => {
    const ctx = {
      integration: {
        connection: {
          active: async () => ({ id: "devin" }),
          resolve: async () => ({ type: "key", key: "devin-session-token$viakey" }),
        },
      },
    }
    expect((await resolveCredentials(ctx as never))?.apiKey).toBe("devin-session-token$viakey")
  })

  test("reports no credentials when the connection throws", async () => {
    const ctx = {
      integration: {
        connection: {
          active: async () => {
            throw new Error("boom")
          },
          resolve: async () => undefined,
        },
      },
    }
    expect(await resolveCredentials(ctx as never)).toBeUndefined()
  })

  test("builds a long-lived oauth credential", () => {
    const cred = toStoredCredential("devin-session-token$abc")
    expect(cred.type).toBe("oauth")
    // methodID is branded upstream; String() drops the phantom brand.
    expect(String(cred.methodID)).toBe("devin")
    expect(cred.access).toBe("devin-session-token$abc")
    expect(cred.refresh).toBe("")
    expect(cred.expires).toBeGreaterThan(Date.now())
    expect(cred.metadata).toEqual({ name: "opencode" })
  })

  test("records the tenant host in metadata when known", () => {
    expect(toStoredCredential("devin-session-token$abc", "acct", "https://tenant.example").metadata).toEqual({
      name: "acct",
      apiServerUrl: "https://tenant.example",
    })
  })
})
