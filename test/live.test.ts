import { describe, expect, test } from "bun:test"

/**
 * Opt-in end-to-end check against Cognition's live Cascade API.
 *
 * This is the only test that can catch a field number drifting, because it is
 * the only one that talks to the real server. Everything else either round-trips
 * our own encoder against our own decoder or compares against protobufjs, so it
 * proves the wire format is genuine protobuf but says nothing about whether
 * Cognition still uses these numbers.
 *
 * It needs a real credential and is therefore skipped unless one is present:
 *
 *   DEVIN_LLM_API_KEY=devin-session-token$... bun test test/live.test.ts
 *
 * See test/fixtures/README.md for how to turn a passing run into a committed
 * capture, which is what makes this checkable in CI without a secret.
 */
const API_KEY = process.env.DEVIN_LLM_API_KEY
const HOST = process.env.DEVIN_API_SERVER ?? "https://server.codeium.com"
const RUN_LIVE = Boolean(API_KEY?.startsWith("devin-session-token$"))

// bun's `describe` takes no options, so skip by not registering a live test.
const maybe = RUN_LIVE ? test : test.skip

if (!RUN_LIVE) {
  console.log("[live] skipped: set DEVIN_LLM_API_KEY to a devin-session-token$... value to run")
}

describe("live Cascade API", () => {
  maybe("mints a user_jwt and reads a non-empty model catalog", async () => {
    const { mintUserJwt } = await import("../src/protocol/auth.ts")
    const { getCachedCatalog } = await import("../src/protocol/catalog.ts")

    const { jwt, expiresAt } = await mintUserJwt(API_KEY!, HOST)
    expect(jwt.split(".")).toHaveLength(3)
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))

    const catalog = await getCachedCatalog(API_KEY!, HOST)
    // getCachedCatalog swallows failures and returns null, so this distinguishes
    // "the request worked" from "the field numbers are wrong".
    expect(catalog).not.toBeNull()

    const entries = [...catalog!.byUid.values()]
    expect(entries.length).toBeGreaterThan(0)

    // Every entry must have carried the fields the decoder reads.
    for (const entry of entries) {
      expect(typeof entry.modelUid).toBe("string")
      expect(entry.modelUid.length).toBeGreaterThan(0)
      expect(typeof entry.disabled).toBe("boolean")
      expect(typeof entry.contextWindow).toBe("number")
    }

    const enabled = entries.filter((e) => !e.disabled)
    expect(enabled.length).toBeGreaterThan(0)

    // Pricing is field 32 in a repeated message; if that number drifted, the
    // decoder would silently leave it undefined.
    const priced = entries.filter((e) => e.pricing)
    console.log(
      `  live catalog: ${entries.length} models, ${enabled.length} enabled, ${priced.length} with pricing`,
    )
  }, 60_000)

  maybe("streams a chat completion end to end", async () => {
    const { streamChatEvents } = await import("../src/protocol/chat.ts")
    const { createDevinProvider } = await import("../src/provider.ts")

    const sdk = createDevinProvider({ apiKey: API_KEY!, baseURL: HOST })
    const catalog = await import("../src/protocol/catalog.ts").then((m) =>
      m.getCachedCatalog(API_KEY!, HOST),
    )
    const modelId = [...catalog!.byUid.values()].find((e) => !e.disabled)?.modelUid
    expect(modelId).toBeTruthy()

    const model = sdk.languageModel(modelId!)
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: pong" }] }],
    } as never)

    const text: string[] = []
    let sawFinish = false
    for await (const part of stream) {
      if (part.type === "text-delta") text.push(part.delta)
      if (part.type === "finish") sawFinish = true
    }

    expect(sawFinish).toBe(true)
    expect(text.join("").length).toBeGreaterThan(0)
    console.log(`  live reply: ${JSON.stringify(text.join("").slice(0, 120))}`)
  }, 120_000)
})
