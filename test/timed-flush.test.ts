import { describe, expect, test } from "bun:test"
import { convertStreamEvents } from "../src/protocol/model.ts"
import type { ChatEvent } from "../src/protocol/chat.ts"

/**
 * The stream is woken by a timer as well as by upstream events. These tests pin
 * the timer behaviour, including the two hazards it introduces: replaying an
 * already-consumed read, and losing the read that was in flight when the timer
 * won the race.
 */

const gen = () => "generated"

/** An upstream that yields the given events, then goes silent for `silenceMs`. */
const slowStream = (events: ChatEvent[], silenceMs: number) =>
  (async function* () {
    for (const event of events) yield event
    await new Promise((r) => setTimeout(r, silenceMs))
  })()

const readUntil = async (it: AsyncGenerator<unknown>, predicate: (p: Record<string, unknown>) => boolean, timeoutMs = 3000) => {
  const out: Record<string, unknown>[] = []
  const deadline = Date.now() + timeoutMs
  for await (const part of it) {
    out.push(part as Record<string, unknown>)
    if (predicate(part as Record<string, unknown>)) break
    if (Date.now() > deadline) break
  }
  return out
}

describe("timed flush", () => {
  // Without a timer these arrive only when the 5s upstream silence ends, so the
  // deadline is what turns a slow path into a real failure.
  const SILENCE_MS = 5_000
  const DEADLINE_MS = 1_000

  test("delivers a buffered delta during upstream silence", async () => {
    // One short text event, then the model goes quiet. Without a timer the delta
    // would sit in the buffer until the stream ended.
    const started = Date.now()
    const it = convertStreamEvents(slowStream([{ kind: "text", text: "hi" }], SILENCE_MS), gen)
    const parts = await readUntil(it, (p) => p.type === "text-delta")
    const elapsed = Date.now() - started

    const delta = parts.find((p) => p.type === "text-delta")
    expect(delta).toBeDefined()
    expect(delta!.delta).toBe("hi")
    expect(elapsed).toBeLessThan(DEADLINE_MS)
    await it.return(undefined)
  }, 10_000)

  test("reasoning is flushed on the timer too", async () => {
    const started = Date.now()
    const it = convertStreamEvents(slowStream([{ kind: "reasoning", text: "pondering" }], SILENCE_MS), gen)
    const parts = await readUntil(it, (p) => p.type === "reasoning-delta")
    expect(parts.find((p) => p.type === "reasoning-delta")!.delta).toBe("pondering")
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS)
    await it.return(undefined)
  }, 10_000)

  test("does not replay an event while the timer races the read", async () => {
    // Regression: an uncleared in-flight read made the same event loop forever.
    const events: ChatEvent[] = []
    for (let i = 0; i < 50; i++) events.push({ kind: "text", text: "a" })
    events.push({ kind: "finish", reason: "stop" })

    const out: Record<string, unknown>[] = []
    for await (const part of convertStreamEvents(slowStream(events, 60), gen)) {
      out.push(part as Record<string, unknown>)
    }
    // Every input text must appear exactly once, and the stream must terminate.
    const text = out
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta as string)
      .join("")
    expect(text).toBe("a".repeat(50))
    expect(out.at(-1)!.type).toBe("finish")
  }, 10_000)

  test("loses no event when the timer wins mid-stream", async () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"]
    const events: ChatEvent[] = words.map((w) => ({ kind: "text", text: w }))
    events.push({ kind: "finish", reason: "stop" })

    const out: Record<string, unknown>[] = []
    // A long silence before the rest forces several timer wake-ups to interleave
    // with the reads.
    const upstream = (async function* () {
      yield events[0]!
      await new Promise((r) => setTimeout(r, 120))
      for (const event of events.slice(1)) yield event
    })()

    for await (const part of convertStreamEvents(upstream, gen)) out.push(part as Record<string, unknown>)

    const text = out
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta as string)
      .join("")
    expect(text).toBe(words.join(""))
  }, 10_000)

  test("closes the text block before the finish part", async () => {
    const events: ChatEvent[] = [
      { kind: "text", text: "x".repeat(200) },
      { kind: "finish", reason: "stop" },
    ]
    const out: Record<string, unknown>[] = []
    for await (const part of convertStreamEvents(slowStream(events, 0), gen)) {
      out.push(part as Record<string, unknown>)
    }
    const order = out.map((p) => p.type)
    expect(order.indexOf("text-end")).toBeLessThan(order.lastIndexOf("finish"))
  }, 10_000)

  test("abandoning the generator clears its timer", async () => {
    // A leaked interval would keep the event loop alive after the stream is
    // dropped, so the process would never exit.
    const started = Date.now()
    const it = convertStreamEvents(slowStream([{ kind: "text", text: "y" }], 5_000), gen)
    for await (const _part of it) {
      void _part
      break
    }
    await it.return(undefined)
    // The tick interval is 32ms, so a leaked one would still be pending here.
    await new Promise((r) => setTimeout(r, 120))
    expect(Date.now() - started).toBeLessThan(3_000)
  }, 10_000)
})
