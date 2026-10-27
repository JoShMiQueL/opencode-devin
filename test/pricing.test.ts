import { afterEach, describe, expect, test } from "bun:test"
import { clearCachedUserJwt } from "../src/protocol/auth.ts"
import { createDevin } from "../src/protocol/model.ts"
import { encodeMessage, encodeString, encodeVarintField, encodeTag } from "../src/protocol/wire.ts"

/**
 * Pricing decode tests: synthetic `GetCascadeModelConfigs` replies built with
 * our own protobuf encoder, per the field layout verified against a live dump
 * in PR #3 and the public REST API (docs.devin.ai/desktop/accounts/api-reference/list-models).
 *
 *   ModelConfig (field 1, repeated):
 *     #1  label          string
 *     #4  disabled       varint bool
 *     #18 contextWindow  varint
 *     #22 modelUid       string
 *     #32 pricing        repeated PricingMessage:
 *         #1 type        string   "Input" | "Cached input" | "Output"
 *         #2 price       float32  USD per #3-unit           ← real price
 *         #3 unit        string   e.g. "1M tokens"
 *         #4 factor      float32  per-type constant — NOT the price
 *         #5 credits     float32  same price in Cognition credits
 *         #6 flag        varint
 *         #7 note        string
 */

const API_KEY = "devin-session-token$pricing"
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  clearCachedUserJwt()
})

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const jwt = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp })}.${b64({ sig: "s" })}`
const inSeconds = (delta: number) => Math.floor(Date.now() / 1000) + delta

const float32Field = (num: number, value: number) => {
  const b = Buffer.alloc(4)
  b.writeFloatLE(value)
  return Buffer.concat([encodeTag(num, 5), b])
}

/** One pricing submessage per the layout verified in PR #3. */
const pricingMessage = (type: string, price: number, factor: number, credits: number) =>
  Buffer.concat([
    encodeString(1, type),
    float32Field(2, price),
    encodeString(3, "1M tokens"),
    float32Field(4, factor),
    float32Field(5, credits),
    encodeVarintField(6, 1),
    encodeString(7, "Higher effort consumes more tokens"),
  ])

const modelConfig = (
  modelUid: string,
  opts: { label?: string; pricing?: Buffer[] } = {},
) =>
  Buffer.concat([
    encodeString(1, opts.label ?? modelUid),
    encodeVarintField(4, 0),
    encodeVarintField(18, 200_000),
    encodeString(22, modelUid),
    ...(opts.pricing ?? []).map((p) => encodeMessage(32, p)),
  ])

const catalogReply = (configs: Buffer[]) =>
  new Uint8Array(Buffer.concat(configs.map((config) => encodeMessage(1, config))))

let hostSeq = 0
const host = () => `https://tenant-${hostSeq++}.test`

const stub = (configs: Buffer[]) => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.includes("GetUserJwt")) {
      return Promise.resolve(new Response(new Uint8Array(encodeString(1, jwt(inSeconds(600)))), { status: 200 }))
    }
    if (url.includes("GetCascadeModelConfigs")) {
      return Promise.resolve(new Response(catalogReply(configs), { status: 200 }))
    }
    return Promise.resolve(new Response("unexpected endpoint", { status: 500 }))
  }) as typeof fetch
}

/** Read the pricing OpenCode exposes via languageModel(). */
const modelPricing = async (modelUid: string, configs: Buffer[]) => {
  stub(configs)
  const provider = createDevin({ apiKey: API_KEY, baseURL: host() })
  // The catalog snapshot is internal; probe it through the /models path the
  // provider exposes via listModels-compatible access. createDevin's model
  // does not expose pricing directly, so re-fetch the catalog through the
  // module under test.
  const { getCachedCatalog } = await import("../src/protocol/catalog.ts")
  const catalog = await getCachedCatalog(API_KEY, host())
  return catalog?.byUid.get(modelUid)?.pricing
}

describe("pricing decode (field #32)", () => {
  test("reads USD price from field #2, not the constant factor #4", async () => {
    // Opus 5.5 values verified against the Devin app: $4 in / $20 out.
    const pricing = await modelPricing("claude-opus-5-5-medium", [
      modelConfig("claude-opus-5-5-medium", {
        pricing: [
          pricingMessage("Input", 4, 0.1, 20),
          pricingMessage("Cached input", 0.4, 0.007, 2),
          pricingMessage("Output", 20, 0.28, 100),
        ],
      }),
    ])
    expect(pricing?.input).toBe(4)
    expect(pricing?.cachedInput).toBeCloseTo(0.4, 6)
    expect(pricing?.output).toBe(20)
  })

  test("different models decode different prices — field #4 was the constant", async () => {
    // Before PR #3, both entries below produced {0.1, 0.007, 0.28} because
    // field #4 carries a per-type constant, not the price.
    const configs = [
      modelConfig("cheap-model", {
        pricing: [pricingMessage("Input", 0.75, 0.1, 3.75), pricingMessage("Output", 3.75, 0.28, 18.75)],
      }),
      modelConfig("dear-model", {
        pricing: [pricingMessage("Input", 10, 0.1, 50), pricingMessage("Output", 50, 0.28, 250)],
      }),
    ]
    stub(configs)
    const { getCachedCatalog } = await import("../src/protocol/catalog.ts")
    const catalog = await getCachedCatalog(API_KEY, host())
    expect(catalog?.byUid.get("cheap-model")?.pricing?.input).toBe(0.75)
    expect(catalog?.byUid.get("dear-model")?.pricing?.input).toBe(10)
  })

  test("ignores unknown pricing labels instead of substring-matching them", async () => {
    // The REST API documents extra labels: sidekick_input (Fusion models),
    // cache_read, cache_write, message. A substring match would let e.g.
    // "sidekick_input" overwrite the real input price.
    const pricing = await modelPricing("fusion-model", [
      modelConfig("fusion-model", {
        pricing: [
          pricingMessage("Input", 2, 0.1, 10),
          pricingMessage("sidekick_input", 99, 0.1, 495),
          pricingMessage("Output", 10, 0.28, 50),
          pricingMessage("sidekick_message", 0.5, 0, 2.5),
        ],
      }),
    ])
    expect(pricing).toEqual({ input: 2, cachedInput: 0, output: 10 })
  })

  test("cache_read label maps to cachedInput", async () => {
    const pricing = await modelPricing("m", [
      modelConfig("m", {
        pricing: [
          pricingMessage("Input", 1, 0.1, 5),
          pricingMessage("cache_read", 0.1, 0.007, 0.5),
          pricingMessage("Output", 5, 0.28, 25),
        ],
      }),
    ])
    expect(pricing?.cachedInput).toBeCloseTo(0.1, 6)
  })

  test("a model with no #32 fields reports no pricing", async () => {
    const pricing = await modelPricing("free-model", [modelConfig("free-model")])
    expect(pricing).toBeUndefined()
  })

  test("ignores a non-float #2 and a float #4 with wrong wire type", async () => {
    // Robustness: #2 must be wire 5 (fixed32); a length-delimited #2 must not
    // be misread. Likewise a #4 string must not crash the loop.
    const pricing = await modelPricing("m", [
      modelConfig("m", {
        pricing: [
          Buffer.concat([
            encodeString(1, "Input"),
            encodeString(2, "not-a-float"), // wrong wire for price
            float32Field(4, 0.1),
          ]),
          Buffer.concat([encodeString(1, "Output"), float32Field(2, 8), encodeString(4, "x")]),
        ],
      }),
    ])
    // Input price stays 0 (no valid #2), output reads 8.
    expect(pricing).toEqual({ input: 0, cachedInput: 0, output: 8 })
  })
})
