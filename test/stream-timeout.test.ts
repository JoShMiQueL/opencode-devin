import { afterEach, describe, expect, test } from "bun:test"
import { clearCachedUserJwt } from "../src/protocol/auth.ts"
import { CloudChatError, streamChatEvents, type ChatEvent } from "../src/protocol/chat.ts"
import { encodeString } from "../src/protocol/wire.ts"
import { inSeconds, jwt, realFetch, uniqueHost } from "./helpers.ts"

const API_KEY = "devin-session-token$timeout"

afterEach(() => {
  globalThis.fetch = realFetch
  clearCachedUserJwt()
})

const frame = (payload: Buffer, flags = 0) => {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return new Uint8Array(Buffer.concat([header, payload]))
}
const textDelta = (text: string) => frame(encodeString(3, text))
const trailer = () => frame(Buffer.alloc(0), 0x02)

interface ChatStub {
  /** Delay before the HTTP response (headers) is returned. */
  headersAfterMs?: number
  /** Number of text deltas, sent `intervalMs` apart, followed by the EOS trailer. */
  deltas?: number
  intervalMs?: number
  /** Leave the body open after the deltas instead of sending the trailer. */
  stall?: boolean
}

/**
 * Stub the chat endpoint. Like real fetch, the request signal keeps governing
 * the response body after the headers have arrived: aborting it errors the body.
 */
const stubChat = (stub: ChatStub) => {
  const state = { chatRequests: 0, bodyCancelled: false }
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).includes("GetUserJwt")) {
      return Promise.resolve(new Response(new Uint8Array(encodeString(1, jwt(inSeconds(600)))), { status: 200 }))
    }
    state.chatRequests++
    const signal = init?.signal ?? undefined
    return new Promise<Response>((resolve, reject) => {
      const onAbortBeforeHeaders = () => {
        clearTimeout(headersTimer)
        reject(signal!.reason)
      }
      const headersTimer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbortBeforeHeaders)
        let timer: ReturnType<typeof setTimeout> | undefined
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => {
              clearTimeout(timer)
              try {
                controller.error(signal.reason)
              } catch {
                // already closed
              }
            })
            let sent = 0
            const tick = () => {
              if (sent < (stub.deltas ?? 0)) {
                controller.enqueue(textDelta(`chunk-${sent++};`))
                timer = setTimeout(tick, stub.intervalMs ?? 0)
              } else if (!stub.stall) {
                controller.enqueue(trailer())
                controller.close()
              }
            }
            tick()
          },
          cancel() {
            clearTimeout(timer)
            state.bodyCancelled = true
          },
        })
        resolve(new Response(body, { status: 200 }))
      }, stub.headersAfterMs ?? 0)
      if (signal?.aborted) onAbortBeforeHeaders()
      else signal?.addEventListener("abort", onAbortBeforeHeaders, { once: true })
    })
  }) as typeof fetch
  return state
}

const request = (extra: Partial<Parameters<typeof streamChatEvents>[0]> = {}) => ({
  apiKey: API_KEY,
  apiServerUrl: uniqueHost(),
  modelUid: "swe-2-max",
  messages: [],
  ...extra,
})

const collect = async (events: AsyncGenerator<ChatEvent>) => {
  let text = ""
  for await (const event of events) if (event.kind === "text") text += event.text
  return text
}

const failure = async (events: AsyncGenerator<ChatEvent>): Promise<unknown> => {
  try {
    await collect(events)
  } catch (cause) {
    return cause
  }
  throw new Error("expected the stream to fail")
}

describe("stream timeouts", () => {
  test("a stream that keeps producing output outlives the TTFB timeout", async () => {
    // 10 deltas 40ms apart = ~400ms of output against a 100ms TTFB limit.
    const chat = stubChat({ deltas: 10, intervalMs: 40 })
    const started = Date.now()
    const text = await collect(streamChatEvents(request({ timeouts: { ttfbMs: 100, idleMs: 1000 } })))
    expect(Date.now() - started).toBeGreaterThan(300)
    expect(text).toBe(Array.from({ length: 10 }, (_, i) => `chunk-${i};`).join(""))
    expect(chat.chatRequests).toBe(1)
  })

  test("the real 60s limit does not cut off a stream that is still producing output", async () => {
    // Default timeouts, real clock: output continues past the 60s mark.
    stubChat({ deltas: 14, intervalMs: 5000 })
    const started = Date.now()
    const text = await collect(streamChatEvents(request()))
    expect(Date.now() - started).toBeGreaterThan(60_000)
    expect(text.endsWith("chunk-13;")).toBe(true)
  }, 90_000)

  test("no HTTP response within the TTFB limit fails with ttfb_timeout", async () => {
    const chat = stubChat({ headersAfterMs: 500 })
    const error = await failure(streamChatEvents(request({ timeouts: { ttfbMs: 50 } })))
    expect(error).toBeInstanceOf(CloudChatError)
    expect((error as CloudChatError).code).toBe("ttfb_timeout")
    expect(chat.chatRequests).toBe(1)
  })

  test("a stream that goes silent fails with idle_timeout, not a truncated stream", async () => {
    const chat = stubChat({ deltas: 2, intervalMs: 10, stall: true })
    const error = await failure(streamChatEvents(request({ timeouts: { ttfbMs: 1000, idleMs: 100 } })))
    expect(error).toBeInstanceOf(CloudChatError)
    expect((error as CloudChatError).code).toBe("idle_timeout")
    expect(chat.bodyCancelled).toBe(true)
    expect(chat.chatRequests).toBe(1)
  })

  test("the caller can abort while waiting for the response", async () => {
    stubChat({ headersAfterMs: 500 })
    const abort = new AbortController()
    const reason = new Error("user cancelled")
    setTimeout(() => abort.abort(reason), 30)
    const error = await failure(streamChatEvents(request({ signal: abort.signal, timeouts: { ttfbMs: 1000 } })))
    expect(error).toBe(reason)
  })

  test("the caller can abort mid-stream, after the TTFB timer has been cleared", async () => {
    stubChat({ deltas: 100, intervalMs: 20 })
    const abort = new AbortController()
    const reason = new Error("user cancelled")
    // Well past the 50ms TTFB limit, so only the caller's signal can end it.
    setTimeout(() => abort.abort(reason), 200)
    const started = Date.now()
    const error = await failure(streamChatEvents(request({ signal: abort.signal, timeouts: { ttfbMs: 50, idleMs: 1000 } })))
    expect(error).toBe(reason)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
