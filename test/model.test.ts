import { describe, expect, test } from "bun:test"
import { collectEvents, convertStreamEvents, resolveEffortUid } from "../src/protocol/model.ts"
import { splitEffortSuffix } from "../src/protocol/effort.ts"
import type { ChatEvent } from "../src/protocol/chat.ts"
import type { ModelCatalogEntry } from "../src/protocol/catalog.ts"

const stream = (...events: ChatEvent[]) =>
  (async function* () {
    for (const event of events) yield event
  })()

/**
 * The decoder only yields `tool_call_start` once it has both an id and a name,
 * so `id` is required on the type. The id-less shapes below are defensive
 * coverage for a future decoder that stops guaranteeing it.
 */
const defensively = (event: Record<string, unknown>) => event as ChatEvent

const drain = async (it: AsyncGenerator<unknown>) => {
  const out: Record<string, unknown>[] = []
  for await (const part of it) out.push(part as Record<string, unknown>)
  return out
}

const toolCalls = (parts: Record<string, unknown>[]) =>
  parts.filter((p) => p.type === "tool-call") as Record<string, unknown>[]

const entry = (over: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  modelUid: "claude-opus-4-8",
  label: "",
  disabled: false,
  contextWindow: 0,
  ...over,
})

describe("interleaved parallel tool calls", () => {
  // Regression: argument deltas used to share one buffer, so two parallel
  // calls produced a single spliced, unparsable string.
  test("keeps each call's arguments separate", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "tool_call_start", id: "A", name: "read" },
          { kind: "tool_call_start", id: "B", name: "write" },
          { kind: "tool_call_args", argsDelta: '{"pa', id: "A" },
          { kind: "tool_call_args", argsDelta: '{"pa', id: "B" },
          { kind: "tool_call_args", argsDelta: 'th":"/a"}', id: "A" },
          { kind: "tool_call_args", argsDelta: 'th":"/b"}', id: "B" },
          { kind: "finish", reason: "tool_calls" },
        ),
        () => "generated",
      ),
    )
    const calls = toolCalls(parts)
    expect(calls).toHaveLength(2)
    const byId = Object.fromEntries(calls.map((c) => [c.toolCallId, c]))
    expect(byId.A!.input).toBe('{"path":"/a"}')
    expect(byId.B!.input).toBe('{"path":"/b"}')
    expect(JSON.parse(byId.A!.input as string)).toEqual({ path: "/a" })
  })

  test("emits calls in the order they started", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "tool_call_start", id: "A", name: "one" },
          { kind: "tool_call_args", argsDelta: '{"x":1}' },
          { kind: "tool_call_start", id: "B", name: "two" },
          { kind: "tool_call_args", argsDelta: '{"y":2}' },
          { kind: "finish", reason: "tool_calls" },
        ),
        () => "generated",
      ),
    )
    expect(toolCalls(parts).map((c) => c.toolCallId)).toEqual(["A", "B"])
  })

  test("attaches id-less deltas to the most recently opened call", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "tool_call_start", id: "A", name: "one" },
          { kind: "tool_call_args", argsDelta: '{"n":' },
          { kind: "tool_call_args", argsDelta: "1}" },
          { kind: "finish", reason: "tool_calls" },
        ),
        () => "generated",
      ),
    )
    expect(toolCalls(parts)[0]!.input).toBe('{"n":1}')
  })

  test("drops an orphan delta rather than inventing a nameless call", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream({ kind: "tool_call_args", argsDelta: '{"orphan":true}', id: "ZZ" }, { kind: "finish", reason: "stop" }),
        () => "generated",
      ),
    )
    expect(toolCalls(parts)).toHaveLength(0)
    expect(parts.at(-1)!.type).toBe("finish")
  })

  test("generates an id when the stream omits one", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          defensively({ kind: "tool_call_start", name: "anon" }),
          { kind: "tool_call_args", argsDelta: "{}" },
          { kind: "finish", reason: "tool_calls" },
        ),
        () => "fallback-id",
      ),
    )
    expect(toolCalls(parts)[0]!.toolCallId).toBe("fallback-id")
  })
})

describe("stream shape", () => {
  test("orders text-end before tool calls and tool calls before finish", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "text", text: "hello" },
          { kind: "tool_call_start", id: "A", name: "go" },
          { kind: "tool_call_args", argsDelta: "{}" },
          { kind: "finish", reason: "tool_calls" },
        ),
        () => "generated",
      ),
    )
    const order = parts.map((p) => p.type)
    expect(order[0]).toBe("stream-start")
    expect(order.indexOf("text-end")).toBeLessThan(order.indexOf("tool-call"))
    expect(order.indexOf("tool-call")).toBeLessThan(order.lastIndexOf("finish"))
  })

  test("coalesces text deltas but preserves the content", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "text", text: "a" },
          { kind: "text", text: "b" },
          { kind: "text", text: "c" },
          { kind: "finish", reason: "stop" },
        ),
        () => "text-id",
      ),
    )
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe("abc")
  })

  test("maps Cascade finish reasons onto the AI SDK union", async () => {
    for (const [raw, unified] of [
      ["stop", "stop"],
      ["length", "length"],
      ["tool_calls", "tool-calls"],
      ["content_filter", "content-filter"],
    ] as const) {
      const parts = await drain(convertStreamEvents(stream({ kind: "finish", reason: raw }), () => "g"))
      const fin = parts.at(-1) as { finishReason: { unified: string; raw: string } }
      expect(fin.finishReason.unified).toBe(unified)
      expect(fin.finishReason.raw).toBe(raw)
    }
  })

  test("falls back to stop for an unknown finish reason", async () => {
    const parts = await drain(convertStreamEvents(stream({ kind: "finish", reason: "weird" }), () => "g"))
    expect((parts.at(-1) as { finishReason: { unified: string } }).finishReason.unified).toBe("stop")
  })

  test("splits output tokens into text and reasoning", async () => {
    const parts = await drain(
      convertStreamEvents(
        // Cascade's input count excludes cached tokens: 600 uncached + 400 read.
        stream({ kind: "finish", reason: "stop" }, {
          kind: "usage",
          promptTokens: 600,
          cachedInputTokens: 400,
          completionTokens: 300,
          reasoningTokens: 120,
        }),
        () => "g",
      ),
    )
    const fin = parts.at(-1) as {
      usage: {
        inputTokens: { total: number; noCache: number; cacheRead: number }
        outputTokens: { total: number; text: number; reasoning: number }
      }
    }
    expect(fin.usage.inputTokens.total).toBe(1000)
    expect(fin.usage.inputTokens.noCache).toBe(600)
    expect(fin.usage.inputTokens.cacheRead).toBe(400)
    expect(fin.usage.outputTokens.total).toBe(300)
    expect(fin.usage.outputTokens.text).toBe(180)
    expect(fin.usage.outputTokens.reasoning).toBe(120)
  })

  test("emits a zeroed usage block when the stream reports none", async () => {
    const parts = await drain(convertStreamEvents(stream({ kind: "finish", reason: "stop" }), () => "g"))
    const fin = parts.at(-1) as { usage: { inputTokens: { total: number }; outputTokens: { total: number } } }
    expect(fin.usage.inputTokens.total).toBe(0)
    expect(fin.usage.outputTokens.total).toBe(0)
  })
})

describe("collectEvents (non-streaming path)", () => {
  test("keeps parallel call arguments separate", async () => {
    const result = await collectEvents(
      stream(
        { kind: "tool_call_start", id: "A", name: "read" },
        { kind: "tool_call_start", id: "B", name: "write" },
        { kind: "tool_call_args", argsDelta: '{"p":"/a"}', id: "A" },
        { kind: "tool_call_args", argsDelta: '{"p":"/b"}', id: "B" },
        { kind: "finish", reason: "tool_calls" },
      ),
    )
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0]!.args).toBe('{"p":"/a"}')
    expect(result.toolCalls[1]!.args).toBe('{"p":"/b"}')
    expect(result.finishReason).toBe("tool_calls")
  })

  test("keeps anonymous calls separate", async () => {
    const result = await collectEvents(
      stream(
        defensively({ kind: "tool_call_start", name: "anon1" }),
        { kind: "tool_call_args", argsDelta: '{"a":1}' },
        defensively({ kind: "tool_call_start", name: "anon2" }),
        { kind: "tool_call_args", argsDelta: '{"a":2}' },
        { kind: "finish", reason: "tool_calls" },
      ),
    )
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0]!.args).toBe('{"a":1}')
    expect(result.toolCalls[1]!.args).toBe('{"a":2}')
  })

  test("accumulates text and reasoning separately", async () => {
    const result = await collectEvents(
      stream(
        { kind: "reasoning", text: "think " },
        { kind: "text", text: "answer" },
        { kind: "finish", reason: "stop" },
      ),
    )
    expect(result.reasoning).toBe("think ")
    expect(result.text).toBe("answer")
  })
})

describe("resolveEffortUid", () => {
  const member = (modelUid: string, baseModelUid: string, effortLevel?: string) =>
    entry({ modelUid, baseModelUid, effortLevel })
  const catalog: ModelCatalogEntry[] = [
    member("claude-opus-4-8-medium", "claude-opus-4-8", "medium"),
    member("claude-opus-4-8-high", "claude-opus-4-8", "high"),
    member("claude-opus-4-8-medium-fast", "claude-opus-4-8-fast", "medium"),
    member("claude-opus-4-8-high-fast", "claude-opus-4-8-fast", "high"),
    // The bare uid is the family's high effort, as the catalog reports it.
    member("glm-5-2", "glm-5-2", "high"),
    member("glm-5-2-max", "glm-5-2", "max"),
    member("kimi-k2-6", "kimi-k2-6"),
  ]

  test("picks the family member for the requested effort", () => {
    expect(resolveEffortUid("claude-opus-4-8", catalog, "high")).toBe("claude-opus-4-8-high")
    expect(resolveEffortUid("glm-5-2", catalog, "max")).toBe("glm-5-2-max")
    expect(resolveEffortUid("glm-5-2", catalog, "high")).toBe("glm-5-2")
  })

  test("keeps a modifier that follows the effort", () => {
    expect(resolveEffortUid("claude-opus-4-8-fast", catalog, "high")).toBe("claude-opus-4-8-high-fast")
    expect(resolveEffortUid("claude-opus-4-8-medium-fast", catalog, "high")).toBe("claude-opus-4-8-high-fast")
  })

  test("falls back to the family default when no effort is requested", () => {
    // Medium when the family id is not a uid; the bare uid when it is.
    expect(resolveEffortUid("claude-opus-4-8", catalog, undefined)).toBe("claude-opus-4-8-medium")
    expect(resolveEffortUid("claude-opus-4-8-fast", catalog, undefined)).toBe("claude-opus-4-8-medium-fast")
    expect(resolveEffortUid("glm-5-2", catalog, undefined)).toBe("glm-5-2")
  })

  test("falls back to the family default for an effort the family lacks", () => {
    expect(resolveEffortUid("claude-opus-4-8", catalog, "xhigh")).toBe("claude-opus-4-8-medium")
    expect(resolveEffortUid("claude-opus-4-8", catalog, "turbo")).toBe("claude-opus-4-8-medium")
  })

  test("still accepts a full uid, with or without an override", () => {
    expect(resolveEffortUid("claude-opus-4-8-medium", catalog, undefined)).toBe("claude-opus-4-8-medium")
    expect(resolveEffortUid("claude-opus-4-8-medium", catalog, "high")).toBe("claude-opus-4-8-high")
    // An effort the catalog does not list is still tried on a uid that has one.
    expect(resolveEffortUid("claude-opus-4-8-high", catalog, "none")).toBe("claude-opus-4-8-none")
  })

  test("leaves a model without efforts alone", () => {
    expect(resolveEffortUid("kimi-k2-6", catalog, "high")).toBe("kimi-k2-6")
    expect(resolveEffortUid("kimi-k2-6", catalog, undefined)).toBe("kimi-k2-6")
  })

  test("accepts an effort in any case", () => {
    expect(resolveEffortUid("claude-opus-4-8", catalog, "HIGH")).toBe("claude-opus-4-8-high")
  })

  test("without a catalog, sends the id as given", () => {
    expect(resolveEffortUid("claude-opus-4-8", undefined, "high")).toBe("claude-opus-4-8")
    expect(resolveEffortUid("claude-opus-4-8-medium", undefined, "high")).toBe("claude-opus-4-8-high")
  })
})

describe("splitEffortSuffix", () => {
  test("splits a uid that carries an effort", () => {
    expect(splitEffortSuffix("claude-opus-4-8-high")).toEqual({
      baseModelUid: "claude-opus-4-8",
      effortLevel: "high",
    })
  })

  test("finds an effort that is followed by a modifier", () => {
    expect(splitEffortSuffix("claude-opus-5-5-high-fast")).toEqual({
      baseModelUid: "claude-opus-5-5-fast",
      effortLevel: "high",
    })
    expect(splitEffortSuffix("gpt-5-6-sol-none-priority")).toEqual({
      baseModelUid: "gpt-5-6-sol-priority",
      effortLevel: "none",
    })
    expect(splitEffortSuffix("glm-5-2-max-1m")).toEqual({ baseModelUid: "glm-5-2-1m", effortLevel: "max" })
    expect(splitEffortSuffix("gemini-3-5-flash-minimal")).toEqual({
      baseModelUid: "gemini-3-5-flash",
      effortLevel: "minimal",
    })
  })

  test("leaves a uid without an effort alone", () => {
    expect(splitEffortSuffix("claude-opus-4-8")).toEqual({ baseModelUid: "claude-opus-4-8" })
    expect(splitEffortSuffix("claude-opus-4-6-thinking-1m")).toEqual({ baseModelUid: "claude-opus-4-6-thinking-1m" })
  })

  test("requires a whole segment, and never the first", () => {
    expect(splitEffortSuffix("model-highs")).toEqual({ baseModelUid: "model-highs" })
    expect(splitEffortSuffix("high-claude-opus")).toEqual({ baseModelUid: "high-claude-opus" })
  })

  test("needs the separator, so a bare effort word is not a suffix", () => {
    expect(splitEffortSuffix("high")).toEqual({ baseModelUid: "high" })
  })
})
