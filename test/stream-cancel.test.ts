import { afterEach, describe, expect, test } from "bun:test"
import { clearCachedUserJwt } from "../src/protocol/auth.ts"
import { createDevin } from "../src/protocol/model.ts"
import { encodeMessage, encodeString, encodeVarintField } from "../src/protocol/wire.ts"

const API_KEY = "devin-session-token$stream"
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

/** A Connect frame: flags 0x00, 4-byte BE length, payload. */
const frame = (payload: Buffer) => {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

/** Protobuf message carrying one text delta (field 3). */
const textDelta = (text: string) => frame(encodeString(3, text))

let hostSeq = 0
const host = () => `https://stream-tenant-${hostSeq++}.test`

/**
 * Stub the chat endpoint with a body that yields `deltas` and then stays open,
 * so the stream can be cancelled while data is still in flight. Reports whether
 * the body was cancelled by the protocol layer.
 */
const stubStreamingChat = (deltas: string[]) => {
  let bodyCancelled = false
  let requested = false
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.includes("GetUserJwt")) {
      return Promise.resolve(new Response(new Uint8Array(encodeString(1, jwt(inSeconds(600)))), { status: 200 }))
    }
    if (url.includes("GetCascadeModelConfigs")) {
      return Promise.resolve(new Response(catalogReply([modelConfig("swe-2-max")]), { status: 200 }))
    }
    requested = true
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const delta of deltas) controller.enqueue(new Uint8Array(textDelta(delta)))
        // Never closed: the stream stays mid-flight until cancelled.
      },
      cancel() {
        bodyCancelled = true
      },
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  }) as typeof fetch
  return {
    wasCancelled: () => bodyCancelled,
    wasRequested: () => requested,
  }
}

const callOptions = { prompt: [] as never, tools: undefined }

const model = () => createDevin({ apiKey: API_KEY, baseURL: host() }).languageModel("swe-2-max")

describe("doStream cancellation", () => {
  test("releases the HTTP body when the consumer cancels mid-stream", async () => {
    // Over the coalescing threshold so a delta is emitted immediately instead
    // of waiting on the flush interval.
    const chat = stubStreamingChat(["x".repeat(200)])
    const { stream } = await model().doStream(callOptions)

    const reader = stream.getReader()
    let sawText = false
    for (let i = 0; i < 5 && !sawText; i++) {
      const { value, done } = await reader.read()
      if (done) break
      if ((value as { type: string }).type === "text-delta") sawText = true
    }
    expect(sawText).toBe(true)
    expect(chat.wasRequested()).toBe(true)

    await reader.cancel("user interrupted")

    // The protocol layer must tear the body down rather than leaving the request
    // open behind an abandoned generator.
    await Bun.sleep(50)
    expect(chat.wasCancelled()).toBe(true)
  })

  test("cancelling before the request is issued does not start one", async () => {
    // Esc pressed the instant the stream is handed over: there is nothing to
    // tear down, and the chat round-trip must be skipped entirely.
    const chat = stubStreamingChat(["x"])
    const { stream } = await model().doStream(callOptions)
    await stream.cancel("interrupted immediately")
    await Bun.sleep(50)
    expect(chat.wasRequested()).toBe(false)
  })

  test("the stream still completes normally on a clean read", async () => {
    // One text delta, then an EOS trailer so the stream terminates by itself.
    const chat = stubStreamingChat(["done"])
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes("GetUserJwt")) {
        return Promise.resolve(new Response(new Uint8Array(encodeString(1, jwt(inSeconds(600)))), { status: 200 }))
      }
      if (url.includes("GetCascadeModelConfigs")) {
        return Promise.resolve(new Response(catalogReply([modelConfig("swe-2-max")]), { status: 200 }))
      }
      // Empty trailer frame (flags 0x02, zero length) marks end-of-stream.
      const trailer = Buffer.alloc(5)
      trailer[0] = 0x02
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(textDelta("done")))
          controller.enqueue(new Uint8Array(trailer))
          controller.close()
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as typeof fetch

    const { stream } = await model().doStream(callOptions)
    const parts: Record<string, unknown>[] = []
    for await (const part of stream) parts.push(part as Record<string, unknown>)

    expect(parts[0]!.type).toBe("stream-start")
    expect(parts.at(-1)!.type).toBe("finish")
    expect(chat).toBeDefined()
  })
})
