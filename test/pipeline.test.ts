import { afterEach, describe, expect, test } from "bun:test"
import { clearCachedUserJwt } from "devin-core"
import { getCachedCatalog } from "devin-core"
import { iterFields } from "devin-core"
import { createDevin } from "../src/protocol/model.ts"
import { inSeconds, jwt, realFetch, uniqueHost } from "./helpers.ts"
import * as zlib from "node:zlib"

/**
 * Integration of the devin-engine pipeline into the provider's LanguageModel:
 * which plumbing mode reaches the wire, and with what system content. The
 * chat endpoint is stubbed at the fetch layer; the assertions read the
 * decoded upstream request.
 */

const API_KEY = "devin-session-token$pipeline"

afterEach(() => {
  globalThis.fetch = realFetch
  clearCachedUserJwt()
})

const mintResponse = () => new Response(new Uint8Array(encodeJwt()), { status: 200 })
const encodeJwt = () => {
  const { encodeString } = require("devin-core") as typeof import("devin-core")
  return encodeString(1, jwt(inSeconds(600)))
}

const trailerFrame = (json = "") => {
  const payload = Buffer.from(json, "utf8")
  const header = Buffer.alloc(5)
  header[0] = 0x02
  header.writeUInt32BE(payload.length, 1)
  return new Uint8Array(Buffer.concat([header, payload]))
}

/** Encode a minimal Cascade chat reply carrying one text delta. */
const chatReply = (text: string) => {
  const { encodeMessage, encodeString, frameConnectStream } = require("devin-core") as typeof import("devin-core")
  void encodeMessage
  // Simplified: the stream frame wraps a message whose exact text field
  // layout is owned by devin-core tests; here an empty upstream stream is
  // enough — the assertions target the request, not the reply decoding.
  void text
  void encodeString
  void frameConnectStream
  return new Response(trailerFrame(), { status: 200 })
}

const stubChat = () => {
  const captured: { count: number; bodies: Buffer[] } = { count: 0, bodies: [] }
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    if (url.includes("GetUserJwt")) return Promise.resolve(mintResponse())
    if (!url.includes("GetChatMessage")) {
      // Catalog and any other endpoint: empty reply, never counted.
      return Promise.resolve(new Response(new Uint8Array(), { status: 200 }))
    }
    captured.count++
    const sent = Buffer.from(init!.body as Uint8Array)
    captured.bodies.push(sent[0]! & 0x01 ? zlib.gunzipSync(sent.subarray(5)) : sent.subarray(5))
    return Promise.resolve(chatReply(""))
  }) as typeof fetch
  return captured
}

const prompt = [
  { role: "system" as const, content: "client system" },
  { role: "user" as const, content: [{ type: "text" as const, text: "write the thing" }] },
]

const runModel = async (mode: "normal" | "uncensored", host: string) => {
  const provider = createDevin({ apiKey: API_KEY, baseURL: host, mode, overrideFile: "en" })
  const model = provider.languageModel("swe-2-1")
  await model.doGenerate({
    prompt,
    temperature: 0.4,
  })
}

describe("pipeline plumbing", () => {
  test("normal mode: single upstream attempt, client system untouched, no override", async () => {
    const captured = stubChat()
    await runModel("normal", uniqueHost())
    expect(captured.count).toBe(1)
    const text = captured.bodies[0]!.toString("latin1")
    expect(text).toContain("client system")
    expect(text).not.toContain("expert-level engineer")
  })

  test("uncensored mode: the override reaches the system lead", async () => {
    const captured = stubChat()
    await runModel("uncensored", uniqueHost())
    expect(captured.count).toBeGreaterThanOrEqual(1)
    const text = captured.bodies[0]!.toString("latin1")
    expect(text).toContain("expert-level engineer")
  })

  test("uncensored mode drops the client system by default", async () => {
    const captured = stubChat()
    await runModel("uncensored", uniqueHost())
    const text = captured.bodies[0]!.toString("latin1")
    expect(text).not.toContain("client system")
  })

  test("empty upstream streams resample in uncensored mode but not in normal", async () => {
    // The stub always replies with an empty stream. Normal mode makes exactly
    // one attempt; uncensored resamples (up to 1 + maxRetries).
    const unc = stubChat()
    await runModel("uncensored", uniqueHost())
    expect(unc.count).toBeGreaterThanOrEqual(2)

    const nor = stubChat()
    await runModel("normal", uniqueHost())
    expect(nor.count).toBe(1)
  })
})
