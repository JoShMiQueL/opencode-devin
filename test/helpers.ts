/**
 * Shared test helpers: fake JWTs, synthetic GetCascadeModelConfigs replies,
 * and a fetch stub that serves them. Used by availability.test.ts and
 * pricing.test.ts.
 */
import { encodeMessage, encodeString, encodeTag, encodeVarintField } from "../src/protocol/wire.ts"

export const realFetch = globalThis.fetch

/** base64url(JSON) — the shape a JWT part takes. */
export const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

/** A structurally valid fake JWT expiring `exp` seconds from now. */
export const jwt = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp })}.${b64({ sig: "s" })}`

export const inSeconds = (delta: number) => Math.floor(Date.now() / 1000) + delta

/** float32 protobuf field (wire type 5, fixed32). */
export const float32Field = (num: number, value: number) => {
  const b = Buffer.alloc(4)
  b.writeFloatLE(value)
  return Buffer.concat([encodeTag(num, 5), b])
}

/** One pricing submessage, field #32 of ModelConfig, per the layout verified in PR #3. */
export const pricingMessage = (type: string, price: number, factor: number, credits: number) =>
  Buffer.concat([
    encodeString(1, type),
    float32Field(2, price),
    encodeString(3, "1M tokens"),
    float32Field(4, factor),
    float32Field(5, credits),
    encodeVarintField(6, 1),
    encodeString(7, "Higher effort consumes more tokens"),
  ])

/** One `ModelConfig` message, per the field numbers the catalog decoder reads. */
export const modelConfig = (
  modelUid: string,
  opts: { label?: string; disabled?: boolean; pricing?: Buffer[] } = {},
) =>
  Buffer.concat([
    encodeString(1, opts.label ?? modelUid),
    encodeVarintField(4, opts.disabled ? 1 : 0),
    encodeVarintField(18, 200_000),
    encodeString(22, modelUid),
    ...(opts.pricing ?? []).map((p) => encodeMessage(32, p)),
  ])

/** `GetCascadeModelConfigs` reply: field 1, repeated ModelConfig. */
export const catalogReply = (configs: Buffer[]) =>
  new Uint8Array(Buffer.concat(configs.map((config) => encodeMessage(1, config))))

/** A distinct host per test keeps the module-level catalog cache from leaking between cases. */
let hostSeq = 0
export const uniqueHost = () => `https://tenant-${hostSeq++}.test`

/** Stub global fetch: serves GetUserJwt + GetCascadeModelConfigs, 500s anything else. */
export const stubFetch = (options: { catalog?: () => Response; mint?: () => Response } = {}) => {
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

/** Capture console.warn for assertions on warning text. */
export const silenceWarn = () => {
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
