import { afterEach, describe, expect, test } from "bun:test"
import * as zlib from "node:zlib"
import { APICallError } from "@ai-sdk/provider"
import { clearCachedUserJwt, getCachedUserJwt } from "devin-core"
import { getCachedCatalog } from "devin-core"
import { CloudChatError, statusForCode, streamChatEvents, type StreamChatRequest } from "devin-core"
import { encodeString, iterFields, type ProtoField } from "devin-core"
import { inSeconds, jwt, realFetch, silenceWarn, uniqueHost } from "./helpers.ts"

const API_KEY = "devin-session-token$request"

afterEach(() => {
  globalThis.fetch = realFetch
  clearCachedUserJwt()
})

const mintResponse = () => new Response(new Uint8Array(encodeString(1, jwt(inSeconds(600)))), { status: 200 })

const trailerFrame = (json = "") => {
  const payload = Buffer.from(json, "utf8")
  const header = Buffer.alloc(5)
  header[0] = 0x02
  header.writeUInt32BE(payload.length, 1)
  return new Uint8Array(Buffer.concat([header, payload]))
}

/** Serve the chat endpoint with `reply` and capture the decoded request message. */
const stubChat = (reply: () => Response = () => new Response(trailerFrame(), { status: 200 })) => {
  const captured: { fields: ProtoField[] } = { fields: [] }
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).includes("GetUserJwt")) return Promise.resolve(mintResponse())
    const sent = Buffer.from(init!.body as Uint8Array)
    const body = sent.subarray(5)
    captured.fields = [...iterFields(sent[0]! & 0x01 ? zlib.gunzipSync(body) : body)]
    return Promise.resolve(reply())
  }) as typeof fetch
  return captured
}

const request = (extra: Partial<StreamChatRequest> = {}): StreamChatRequest => ({
  apiKey: API_KEY,
  apiServerUrl: uniqueHost(),
  modelUid: "swe-2-max",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
})

const run = async (req: StreamChatRequest) => {
  for await (const _ of streamChatEvents(req)) void _
}

const failure = async (req: StreamChatRequest): Promise<CloudChatError> => {
  try {
    await run(req)
  } catch (cause) {
    return cause as CloudChatError
  }
  throw new Error("expected the request to fail")
}

const sub = (field: ProtoField | undefined) => [...iterFields(field!.value as Buffer)]
const str = (field: ProtoField | undefined) => (field!.value as Buffer).toString("utf8")
const tool = { name: "get_weather", description: "", parameters: {} }

describe("tool choice", () => {
  const toolChoice = async (extra: Partial<StreamChatRequest>) => {
    const captured = stubChat()
    await run(request(extra))
    return captured.fields.find((field) => field.num === 12)
  }

  test("is omitted for auto and when unset", async () => {
    expect(await toolChoice({ tools: [tool] })).toBeUndefined()
    expect(await toolChoice({ tools: [tool], toolChoice: { type: "auto" } })).toBeUndefined()
  })

  test("sends required and none as the option name", async () => {
    for (const type of ["required", "none"] as const) {
      const [option] = sub(await toolChoice({ tools: [tool], toolChoice: { type } }))
      expect(option!.num).toBe(1)
      expect(str(option)).toBe(type)
    }
  })

  test("sends a specific tool as the tool name", async () => {
    const [name] = sub(await toolChoice({ tools: [tool], toolChoice: { type: "tool", toolName: "get_weather" } }))
    expect(name!.num).toBe(2)
    expect(str(name)).toBe("get_weather")
  })

  test("is omitted when there are no tools to choose from", async () => {
    expect(await toolChoice({ toolChoice: { type: "required" } })).toBeUndefined()
  })
})

describe("completion configuration", () => {
  const config = async (completionOpts: StreamChatRequest["completionOpts"]) => {
    const captured = stubChat()
    await run(request({ completionOpts }))
    const fields = sub(captured.fields.find((field) => field.num === 8))
    const get = (num: number) => fields.find((field) => field.num === num)!
    return { varint: (num: number) => Number(get(num).value), double: (num: number) => (get(num).value as Buffer).readDoubleLE(0) }
  }

  test("sends the output limit as max_tokens (#2) and top_p as #8", async () => {
    const sent = await config({ maxOutputTokens: 32_000, topP: 0.9, temperature: 0.2, topK: 40 })
    expect(sent.varint(2)).toBe(32_000)
    expect(sent.double(8)).toBe(0.9)
    expect(sent.double(5)).toBe(0.2)
    expect(sent.varint(7)).toBe(40)
  })

  test("keeps the previous wire values when nothing is specified", async () => {
    const sent = await config(undefined)
    expect(sent.varint(1)).toBe(1)
    expect(sent.varint(2)).toBe(64_000)
    expect(sent.varint(3)).toBe(128_000)
    expect(sent.double(5)).toBe(0.7)
    expect(sent.double(6)).toBe(0.95)
    expect(sent.varint(7)).toBe(50)
    expect(sent.double(8)).toBe(1.0)
    expect(sent.double(11)).toBe(1.0)
  })
})

describe("tool result error flag", () => {
  test("sets tool_result_is_error (#9) only on a failed tool result", async () => {
    const captured = stubChat()
    await run(
      request({
        messages: [
          { role: "user", content: "go" },
          { role: "tool", content: "ok", tool_call_id: "c1" },
          { role: "tool", content: "boom", tool_call_id: "c2", is_error: true },
        ],
      }),
    )
    const prompts = captured.fields.filter((field) => field.num === 3).map(sub)
    const flag = (fields: ProtoField[]) => fields.find((field) => field.num === 9)?.value
    expect(prompts.map(flag)).toEqual([undefined, undefined, 1n])
  })
})

describe("error classification", () => {
  const trailerError = (code: string, message: string) =>
    failure(
      (stubChat(() => new Response(trailerFrame(JSON.stringify({ error: { code, message } })), { status: 200 })), request()),
    )

  test("is an APICallError carrying the Connect code as an HTTP status", async () => {
    const error = await trailerError("invalid_argument", "There is an issue with this request")
    expect(error).toBeInstanceOf(CloudChatError)
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error.code).toBe("invalid_argument")
    expect(error.statusCode).toBe(400)
    expect(error.isRetryable).toBe(false)
    expect(error.url).toContain("GetChatMessage")
  })

  test("maps the codes that decide whether a retry can help", async () => {
    const cases: [string, string, number, boolean][] = [
      ["permission_denied", "This model is only in Devin Local.", 403, false],
      ["resource_exhausted", "Your daily usage quota has been exhausted.", 402, false],
      ["resource_exhausted", "Too many requests", 429, true],
      ["unavailable", "upstream unavailable", 503, true],
      ["internal", "something broke", 500, true],
    ]
    for (const [code, message, status, retryable] of cases) {
      const error = await trailerError(code, message)
      expect([code, error.statusCode, error.isRetryable]).toEqual([code, status, retryable])
    }
  })

  test("a rejected user_jwt is retryable, since the next attempt mints a fresh one", async () => {
    const midStream = await trailerError("unauthenticated", "token rejected")
    expect(midStream.statusCode).toBe(401)
    expect(midStream.isRetryable).toBe(true)
    expect(midStream.responseHeaders).toEqual({ "x-should-retry": "true" })

    stubChat(() => new Response("unauthorized", { status: 401 }))
    const http = await failure(request())
    expect(http.statusCode).toBe(401)
    expect(http.isRetryable).toBe(true)
  })

  test("an HTTP failure keeps the server's status", async () => {
    stubChat(() => new Response("boom", { status: 500 }))
    const error = await failure(request())
    expect(error.statusCode).toBe(500)
    expect(error.message).toContain("500")
  })

  test("a dropped stream and the client's own timeouts are retryable", () => {
    expect(statusForCode("truncated_stream", "")).toBe(502)
    expect(statusForCode("ttfb_timeout", "")).toBe(504)
    expect(statusForCode("idle_timeout", "")).toBe(504)
    expect(statusForCode(undefined, "")).toBe(500)
  })
})

describe("shared user_jwt mint", () => {
  // Regression: the shared mint ran on the first caller's signal, so cancelling
  // that request failed every other request waiting on the same token.
  test("cancelling one waiter does not fail the others", async () => {
    let release!: () => void
    let mints = 0
    globalThis.fetch = ((_input: Parameters<typeof fetch>[0]) => {
      mints++
      return new Promise<Response>((resolve) => {
        release = () => resolve(mintResponse())
      })
    }) as typeof fetch

    const host = uniqueHost()
    const first = new AbortController()
    const reason = new Error("first request cancelled")
    const a = getCachedUserJwt(API_KEY, host, first.signal)
    const b = getCachedUserJwt(API_KEY, host)
    first.abort(reason)
    await expect(a).rejects.toBe(reason)

    release()
    expect((await b).split(".")).toHaveLength(3)
    expect(mints).toBe(1)
  })
})

describe("catalog failures", () => {
  test("are logged, since the only other symptom is an empty model list", async () => {
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) =>
      Promise.resolve(
        String(input).includes("GetUserJwt") ? mintResponse() : new Response("catalog down", { status: 503 }),
      )) as typeof fetch
    const warn = silenceWarn()
    try {
      expect(await getCachedCatalog(API_KEY, uniqueHost())).toBeNull()
      await Bun.sleep(0)
      const logged = warn.captured().join("\n")
      expect(logged).toContain("could not load the model catalog")
      expect(logged).toContain("503")
    } finally {
      warn.restore()
    }
  })
})
