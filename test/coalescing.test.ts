import { describe, expect, test } from "bun:test"
import { convertStreamEvents } from "../src/protocol/model.ts"
import type { ChatEvent } from "../src/protocol/chat.ts"

const stream = (...events: ChatEvent[]) =>
  (async function* () {
    for (const event of events) yield event
  })()

const drain = async (it: AsyncGenerator<unknown>) => {
  const out: Record<string, unknown>[] = []
  for await (const part of it) out.push(part as Record<string, unknown>)
  return out
}

const gen = () => "generated"

describe("coalescing", () => {
  test("emits a text delta promptly when reasoning follows", async () => {
    // Without a cross-type flush, text buffered just before the model starts
    // thinking stays invisible until more text or a tool call arrives.
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "text", text: "short" },
          { kind: "reasoning", text: "thinking" },
          { kind: "finish", reason: "stop" },
        ),
        gen,
      ),
    )
    const order = parts.map((p) => p.type)
    const textDelta = order.indexOf("text-delta")
    const reasoningStart = order.indexOf("reasoning-start")
    expect(textDelta).toBeGreaterThanOrEqual(0)
    expect(reasoningStart).toBeGreaterThanOrEqual(0)
    // The text must land before the reasoning block starts, not only at the end.
    expect(textDelta).toBeLessThan(reasoningStart)
  })

  test("emits a reasoning delta promptly when text follows", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "reasoning", text: "think" },
          { kind: "text", text: "answer" },
          { kind: "finish", reason: "stop" },
        ),
        gen,
      ),
    )
    const order = parts.map((p) => p.type)
    expect(order.indexOf("reasoning-delta")).toBeLessThan(order.indexOf("text-start"))
  })

  test("preserves all content across the flush points", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "text", text: "one " },
          { kind: "reasoning", text: "hmm " },
          { kind: "text", text: "two " },
          { kind: "reasoning", text: "hmm2 " },
          { kind: "text", text: "three" },
          { kind: "finish", reason: "stop" },
        ),
        gen,
      ),
    )
    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("")
    const reasoning = parts
      .filter((p) => p.type === "reasoning-delta")
      .map((p) => p.delta)
      .join("")
    expect(text).toBe("one two three")
    expect(reasoning).toBe("hmm hmm2 ")
  })

  test("closes blocks exactly once each", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "text", text: "a" },
          { kind: "reasoning", text: "b" },
          { kind: "text", text: "c" },
          { kind: "finish", reason: "stop" },
        ),
        gen,
      ),
    )
    const count = (type: string) => parts.filter((p) => p.type === type).length
    // Interleaving must not close the text block when reasoning opens.
    expect(count("text-end")).toBe(1)
    expect(count("reasoning-end")).toBe(1)
  })

  test("still batches many micro-deltas into far fewer events", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ kind: "text", text: `t${i}` }) as ChatEvent)
    const parts = await drain(convertStreamEvents(stream(...many, { kind: "finish", reason: "stop" }), gen))
    const deltas = parts.filter((p) => p.type === "text-delta").length
    // 200 input events should not become 200 output events.
    expect(deltas).toBeLessThan(50)
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe(
      many.map((e) => (e as { text: string }).text).join(""),
    )
  })
})
