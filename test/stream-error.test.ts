import { afterEach, describe, expect, test } from "bun:test"
import { clearCachedUserJwt } from "devin-core"
import { createDevin } from "../src/protocol/model.ts"
import { encodeMessage, encodeString, encodeVarintField } from "devin-core"

const API_KEY = "devin-session-token$stream-error"
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  clearCachedUserJwt()
})

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const jwt = (exp: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp })}.${b64({ sig: "s" })}`
const inSeconds = (delta: number) => Math.floor(Date.now() / 1000) + delta

const modelConfig = (modelUid: string) =>
  Buffer.concat([encodeString(1, modelUid), encodeVarintField(4, 0), encodeVarintField(18, 200_000), encodeString(22, modelUid)])

const catalogReply = (configs: Buffer[]) =>
  new Uint8Array(Buffer.concat(configs.map((c) => encodeMessage(1, c))))

/** Connect frame with an explicit flags byte: 0x02 marks the end-of-stream trailer. */
const frame = (flags: number, payload: Buffer) => {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

const RATE_LIMIT = "Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model."

/** Chat endpoint that answers with a failure trailer and no content, like a limit hit. */
const stubLimitHit = () => {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.includes("GetUserJwt")) {
      return Promise.resolve(new Response(new Uint8Array(encodeString(1, jwt(inSeconds(600)))), { status: 200 }))
    }
    if (url.includes("GetCascadeModelConfigs")) {
      return Promise.resolve(new Response(catalogReply([modelConfig("swe-2-1")]), { status: 200 }))
    }
    const trailer = frame(0x02, Buffer.from(JSON.stringify({ error: { code: "resource_exhausted", message: RATE_LIMIT } })))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(trailer))
        controller.close()
      },
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  }) as typeof fetch
}

const callOptions = { prompt: [] as never, tools: undefined }

describe("doStream failure reporting", () => {
  test("a limit hit surfaces as an error part and an error finish, not a silent stop", async () => {
    stubLimitHit()
    const model = createDevin({ apiKey: API_KEY, baseURL: "https://stream-error-tenant.test" }).languageModel("swe-2-1")
    const { stream } = await model.doStream(callOptions)

    const parts: Record<string, unknown>[] = []
    // Must close normally: an exception here is exactly what opencode drops silently.
    for await (const part of stream) parts.push(part as Record<string, unknown>)

    const errorPart = parts.find((p) => p.type === "error") as { error: Error } | undefined
    expect(errorPart).toBeDefined()
    expect(String(errorPart!.error.message)).toContain(RATE_LIMIT)

    const finish = parts.at(-1) as { type: string; finishReason: { unified: string } }
    expect(finish.type).toBe("finish")
    expect(finish.finishReason.unified).toBe("error")
  })
})
