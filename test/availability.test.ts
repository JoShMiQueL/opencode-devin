import { afterEach, describe, expect, test } from "bun:test"
import { clearCachedUserJwt } from "../src/protocol/auth.ts"
import { createDevin } from "../src/protocol/model.ts"
import { ModelNotAvailableError } from "../src/protocol/catalog.ts"
import { encodeMessage, encodeString, encodeVarintField } from "../src/protocol/wire.ts"

const API_KEY = "devin-session-token$availability"
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  clearCachedUserJwt()
})

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const jwt = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp })}.${b64({ sig: "s" })}`
const inSeconds = (delta: number) => Math.floor(Date.now() / 1000) + delta

/** One `ModelConfig` message, per the field numbers the catalog decoder reads. */
const modelConfig = (modelUid: string, opts: { label?: string; disabled?: boolean } = {}) =>
  Buffer.concat([
    encodeString(1, opts.label ?? modelUid),
    encodeVarintField(4, opts.disabled ? 1 : 0),
    encodeVarintField(18, 200_000),
    encodeString(22, modelUid),
  ])

/** `GetCascadeModelConfigs` reply: field 1, repeated ModelConfig. */
const catalogReply = (configs: Buffer[]) =>
  new Uint8Array(Buffer.concat(configs.map((config) => encodeMessage(1, config))))

/**
 * A distinct host per test keeps the module-level catalog cache from leaking
 * between cases, since it is keyed by credential and host.
 */
let hostSeq = 0
const host = () => `https://tenant-${hostSeq++}.test`

const stub = (options: { catalog?: () => Response; mint?: () => Response } = {}) => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    const respond = () => {
      if (url.includes("GetUserJwt")) {
        return options.mint?.() ?? new Response(new Uint8Array(encodeString(1, jwt(inSeconds(600)))), { status: 200 })
      }
      if (url.includes("GetCascadeModelConfigs")) {
        return options.catalog?.() ?? new Response("not configured", { status: 500 })
      }
      return new Response("unexpected endpoint", { status: 500 })
    }
    return Promise.resolve(respond())
  }) as typeof fetch
}

const callOptions = { prompt: [] as never, tools: undefined }

const silenceWarn = () => {
  const original = console.warn
  let captured: string[] = []
  console.warn = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "))
  }
  return {
    restore: () => {
      console.warn = original
    },
    captured: () => captured,
  }
}

describe("model availability", () => {
  test("proceeds when the catalog lists the model as enabled", async () => {
    stub({ catalog: () => new Response(catalogReply([modelConfig("swe-2-max")]), { status: 200 }) })
    const warn = silenceWarn()
    try {
      const provider = createDevin({ apiKey: API_KEY, baseURL: host() })
      const model = provider.languageModel("swe-2-max")
      // It gets as far as the chat endpoint, which the stub fails; what matters
      // is that availability did not reject it and nothing was warned about.
      await expect(model.doGenerate(callOptions)).rejects.toThrow(/500/)
      expect(warn.captured()).toHaveLength(0)
    } finally {
      warn.restore()
    }
  })

  test("fails fast with a clear error when the model is disabled", async () => {
    stub({
      catalog: () =>
        new Response(catalogReply([modelConfig("swe-2-max", { label: "Sonnet", disabled: true })]), { status: 200 }),
    })
    const provider = createDevin({ apiKey: API_KEY, baseURL: host() })
    const model = provider.languageModel("swe-2-max")

    // The catalog is resolved before the stream is built, so this rejects
    // without touching the chat endpoint.
    await expect(model.doGenerate(callOptions)).rejects.toThrow(ModelNotAvailableError)
    await expect(model.doGenerate(callOptions)).rejects.toThrow(/not enabled for your Cognition account tier/)
    await expect(model.doGenerate(callOptions)).rejects.toThrow(/Sonnet/)
  })

  test("warns but does not block when the model is absent from the catalog", async () => {
    // The catalog is not a guarantee that it enumerates every uid Cascade
    // accepts, so an unknown model must still be sent.
    stub({ catalog: () => new Response(catalogReply([modelConfig("other-model")]), { status: 200 }) })
    const warn = silenceWarn()
    try {
      const provider = createDevin({ apiKey: API_KEY, baseURL: host() })
      const model = provider.languageModel("unlisted-model")
      // The request is allowed through; it fails later at the chat endpoint.
      await expect(model.doGenerate(callOptions)).rejects.toThrow(/500/)
      expect(warn.captured().join("\n")).toContain("not in the Cascade catalog")
    } finally {
      warn.restore()
    }
  })

  test("does not judge the model when the catalog could not be fetched", async () => {
    stub({ catalog: () => new Response("boom", { status: 500 }) })
    const warn = silenceWarn()
    try {
      const provider = createDevin({ apiKey: API_KEY, baseURL: host() })
      const model = provider.languageModel("swe-2-max")
      // Unavailable catalog means unknown, not rejected.
      await expect(model.doGenerate(callOptions)).rejects.toThrow(/500/)
      expect(warn.captured().join("\n")).not.toContain("not in the Cascade catalog")
    } finally {
      warn.restore()
    }
  })

  test("fetches the catalog once per provider and reuses it", async () => {
    let catalogFetches = 0
    stub({
      catalog: () => {
        catalogFetches++
        return new Response(catalogReply([modelConfig("swe-2-max")]), { status: 200 })
      },
    })
    const provider = createDevin({ apiKey: API_KEY, baseURL: host() })
    const first = provider.languageModel("swe-2-max")
    const second = provider.languageModel("swe-2-max")
    await Promise.resolve(first.doGenerate(callOptions)).catch(() => {})
    await Promise.resolve(second.doGenerate(callOptions)).catch(() => {})
    expect(catalogFetches).toBe(1)
  })

  test("an empty catalog leaves every model unjudged", async () => {
    stub({ catalog: () => new Response(catalogReply([]), { status: 200 }) })
    const warn = silenceWarn()
    try {
      const provider = createDevin({ apiKey: API_KEY, baseURL: host() })
      await expect(provider.languageModel("anything").doGenerate(callOptions)).rejects.toThrow(/500/)
      expect(warn.captured().join("\n")).toContain("not in the Cascade catalog")
    } finally {
      warn.restore()
    }
  })
})

// A model the catalog never listed is not refused up front — the catalog is not
// a contract that it enumerates every accepted uid — but when the request does
// fail, the probable reason travels with the error.
describe("unlisted model diagnostics", () => {
  const failing = () => stub({ catalog: () => new Response(catalogReply([modelConfig("other-model")]), { status: 200 }) })

  test("doGenerate explains an unlisted model when the request fails", async () => {
    failing()
    const warn = silenceWarn()
    try {
      const provider = createDevin({ apiKey: API_KEY, baseURL: host() })
      const error = await provider
        .languageModel("unlisted-model")
        .doGenerate(callOptions)
        .then(() => null, (e: Error) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toContain("not listed in your Cognition catalog")
      expect(error!.message).toContain("unlisted-model")
      // The original upstream failure is preserved, not replaced.
      expect(error!.message).toContain("500")
    } finally {
      warn.restore()
    }
  })

  test("doStream surfaces the hint through the stream error", async () => {
    failing()
    const warn = silenceWarn()
    try {
      const provider = createDevin({ apiKey: API_KEY, baseURL: host() })
      const { stream } = await provider.languageModel("unlisted-model").doStream(callOptions)
      // The stream opens with stream-start; the failure surfaces on a later read.
      const reader = stream.getReader()
      const error = await (async () => {
        for (;;) {
          try {
            const { done } = await reader.read()
            if (done) return null
          } catch (e) {
            return e as Error
          }
        }
      })()
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toContain("not listed in your Cognition catalog")
    } finally {
      warn.restore()
    }
  })

  test("no hint is added for a model the catalog lists", async () => {
    stub({ catalog: () => new Response(catalogReply([modelConfig("swe-2-max")]), { status: 200 }) })
    const warn = silenceWarn()
    try {
      const provider = createDevin({ apiKey: API_KEY, baseURL: host() })
      const error = await provider
        .languageModel("swe-2-max")
        .doGenerate(callOptions)
        .then(() => null, (e: Error) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).not.toContain("not listed in your Cognition catalog")
    } finally {
      warn.restore()
    }
  })

  test("no hint is added when the catalog could not be loaded", async () => {
    stub({ catalog: () => new Response("boom", { status: 500 }) })
    const warn = silenceWarn()
    try {
      const provider = createDevin({ apiKey: API_KEY, baseURL: host() })
      const error = await provider
        .languageModel("whatever")
        .doGenerate(callOptions)
        .then(() => null, (e: Error) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).not.toContain("not listed in your Cognition catalog")
    } finally {
      warn.restore()
    }
  })
})

