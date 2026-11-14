import { describe, expect, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { collectEvents, convertPrompt, convertStreamEvents } from "../src/protocol/model.ts"
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

const toolResult = (output: unknown): LanguageModelV3Prompt =>
  [{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "shell", output }] }] as LanguageModelV3Prompt

const textOf = (content: unknown) =>
  (content as { type: string; text?: string }[]).filter((part) => part.type === "text").map((part) => part.text)

describe("tool results", () => {
  // Regression: the tagged union was serialised whole, so the model read
  // {"type":"text","value":"line1\nline2"} instead of the two lines.
  test("sends text output as the text itself", () => {
    const { messages } = convertPrompt(toolResult({ type: "text", value: "line1\nline2" }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe("tool")
    expect(messages[0]!.tool_call_id).toBe("c1")
    expect(textOf(messages[0]!.content)).toEqual(["line1\nline2"])
    expect(messages[0]!.is_error).toBeUndefined()
  })

  test("sends json output as the bare value", () => {
    const { messages } = convertPrompt(toolResult({ type: "json", value: { ok: true, n: 2 } }))
    expect(textOf(messages[0]!.content)).toEqual(['{"ok":true,"n":2}'])
  })

  test("marks error outputs and a denied execution as failures", () => {
    const errorText = convertPrompt(toolResult({ type: "error-text", value: "boom" })).messages[0]!
    expect(textOf(errorText.content)).toEqual(["boom"])
    expect(errorText.is_error).toBe(true)

    const errorJson = convertPrompt(toolResult({ type: "error-json", value: { code: 7 } })).messages[0]!
    expect(textOf(errorJson.content)).toEqual(['{"code":7}'])
    expect(errorJson.is_error).toBe(true)

    const denied = convertPrompt(toolResult({ type: "execution-denied", reason: "not allowed" })).messages[0]!
    expect(textOf(denied.content)[0]).toContain("not allowed")
    expect(denied.is_error).toBe(true)
  })

  test("keeps text parts separate and forwards images in content output", () => {
    const { messages, warnings } = convertPrompt(
      toolResult({
        type: "content",
        value: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
          { type: "image-data", data: "QUJD", mediaType: "image/png" },
        ],
      }),
    )
    expect(textOf(messages[0]!.content)).toEqual(["first", "second"])
    expect(messages[0]!.content).toContainEqual({ type: "image", mimeType: "image/png", base64Data: "QUJD" })
    expect(warnings).toHaveLength(0)
  })

  test("replaces a file it cannot send with a note and a warning", () => {
    const { messages, warnings } = convertPrompt(
      toolResult({
        type: "content",
        value: [{ type: "file-data", data: "QUJD", mediaType: "application/pdf", filename: "report.pdf" }],
      }),
    )
    expect(textOf(messages[0]!.content)[0]).toContain('application/pdf file "report.pdf"')
    expect(warnings).toEqual([expect.objectContaining({ type: "unsupported", feature: "application/pdf file input" })])
  })
})

describe("user attachments", () => {
  const user = (...files: { mediaType: string; data: unknown }[]): LanguageModelV3Prompt =>
    [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }, ...files.map((file) => ({ type: "file", ...file }))],
      },
    ] as LanguageModelV3Prompt

  const images = (content: unknown) => (content as Record<string, unknown>[]).filter((part) => part.type === "image")

  test("sends images given as base64, bytes or a data URL", () => {
    const { messages, warnings } = convertPrompt(
      user(
        { mediaType: "image/png", data: "QUJD" },
        // Regression: binary image data was skipped without a word.
        { mediaType: "image/png", data: new Uint8Array([65, 66, 67]) },
        { mediaType: "image/jpeg", data: "data:image/jpeg;base64,QUJD" },
      ),
    )
    expect(images(messages[0]!.content)).toEqual([
      { type: "image", mimeType: "image/png", base64Data: "QUJD" },
      { type: "image", mimeType: "image/png", base64Data: "QUJD" },
      { type: "image", mimeType: "image/jpeg", base64Data: "QUJD" },
    ])
    expect(warnings).toHaveLength(0)
  })

  test("says so when an attachment cannot be sent", () => {
    const { messages, warnings } = convertPrompt(
      user(
        { mediaType: "application/pdf", data: "QUJD" },
        { mediaType: "image/png", data: new URL("https://example.test/a.png") },
      ),
    )
    const text = textOf(messages[0]!.content)
    expect(text[0]).toBe("hi")
    expect(text[1]).toContain("application/pdf")
    expect(text[2]).toContain("image/png")
    expect(images(messages[0]!.content)).toHaveLength(0)
    expect(warnings).toHaveLength(2)
  })

  test("passes the warnings on at the start of the stream", async () => {
    const warnings = [{ type: "unsupported" as const, feature: "application/pdf file input" }]
    const parts = await drain(convertStreamEvents(stream({ kind: "finish", reason: "stop" }), () => "g", warnings))
    expect(parts[0]).toEqual({ type: "stream-start", warnings })
  })
})

describe("streamed tool input", () => {
  test("streams the arguments as they arrive, then completes the call", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "tool_call_start", id: "A", name: "write" },
          { kind: "tool_call_args", argsDelta: '{"path":', id: "A" },
          { kind: "tool_call_args", argsDelta: '"/a"}', id: "A" },
          { kind: "finish", reason: "tool_calls" },
        ),
        () => "generated",
      ),
    )
    const tool = parts.filter((part) => String(part.type).startsWith("tool-"))
    expect(tool).toEqual([
      { type: "tool-input-start", id: "A", toolName: "write" },
      { type: "tool-input-delta", id: "A", delta: '{"path":' },
      { type: "tool-input-delta", id: "A", delta: '"/a"}' },
      { type: "tool-input-end", id: "A" },
      { type: "tool-call", toolCallId: "A", toolName: "write", input: '{"path":"/a"}' },
    ])
  })

  test("keeps interleaved parallel calls on their own ids, each started before its deltas", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "tool_call_start", id: "A", name: "read" },
          { kind: "tool_call_start", id: "B", name: "write" },
          { kind: "tool_call_args", argsDelta: '{"a":', id: "A" },
          { kind: "tool_call_args", argsDelta: '{"b":', id: "B" },
          { kind: "tool_call_args", argsDelta: "1}", id: "A" },
          { kind: "tool_call_args", argsDelta: "2}", id: "B" },
          { kind: "finish", reason: "tool_calls" },
        ),
        () => "generated",
      ),
    )
    for (const id of ["A", "B"]) {
      const own = parts.filter((part) => part.id === id || part.toolCallId === id).map((part) => part.type)
      expect(own).toEqual(["tool-input-start", "tool-input-delta", "tool-input-delta", "tool-input-end", "tool-call"])
    }
    const deltas = (id: string) =>
      parts.filter((part) => part.type === "tool-input-delta" && part.id === id).map((part) => part.delta).join("")
    expect(deltas("A")).toBe('{"a":1}')
    expect(deltas("B")).toBe('{"b":2}')
  })

  test("announces a call once, under its first name", async () => {
    const parts = await drain(
      convertStreamEvents(
        stream(
          { kind: "tool_call_start", id: "A", name: "read" },
          { kind: "tool_call_start", id: "A", name: "renamed" },
          { kind: "tool_call_args", argsDelta: "{}", id: "A" },
          { kind: "finish", reason: "tool_calls" },
        ),
        () => "generated",
      ),
    )
    expect(parts.filter((part) => part.type === "tool-input-start")).toHaveLength(1)
    expect(parts.find((part) => part.type === "tool-call")!.toolName).toBe("read")
  })
})

describe("finish reason with tool calls", () => {
  // Some upstream models stop a tool-calling turn with a plain stop, or with no
  // stop reason at all, which reaches here as the default "stop".
  const toolTurn = (reason?: string): ChatEvent[] => [
    { kind: "tool_call_start", id: "A", name: "read" },
    { kind: "tool_call_args", argsDelta: "{}", id: "A" },
    ...(reason ? [{ kind: "finish", reason } as ChatEvent] : []),
  ]

  test("reports tool-calls when the stream made tool calls but said stop or nothing", async () => {
    for (const reason of ["stop", undefined]) {
      const parts = await drain(convertStreamEvents(stream(...toolTurn(reason)), () => "g"))
      expect((parts.at(-1) as { finishReason: { unified: string } }).finishReason.unified).toBe("tool-calls")
      expect((await collectEvents(stream(...toolTurn(reason)))).finishReason).toBe("tool_calls")
    }
  })

  test("leaves other reasons alone", async () => {
    const parts = await drain(convertStreamEvents(stream(...toolTurn("length")), () => "g"))
    expect((parts.at(-1) as { finishReason: { unified: string } }).finishReason.unified).toBe("length")
    const plain = await drain(convertStreamEvents(stream({ kind: "text", text: "hi" }, { kind: "finish", reason: "stop" }), () => "g"))
    expect((plain.at(-1) as { finishReason: { unified: string } }).finishReason.unified).toBe("stop")
  })
})

describe("usage", () => {
  test("counts cached input on top of the uncached count Cascade reports", async () => {
    // Shape observed live for a repeated prompt: input_tokens=4, cached=165031.
    const events = (): ChatEvent[] => [
      { kind: "finish", reason: "stop" },
      { kind: "usage", promptTokens: 4, cachedInputTokens: 165_031, cacheCreationInputTokens: 10, completionTokens: 26 },
    ]
    const expected = { total: 165_045, noCache: 4, cacheRead: 165_031, cacheWrite: 10 }
    const parts = await drain(convertStreamEvents(stream(...events()), () => "g"))
    expect((parts.at(-1) as { usage: { inputTokens: unknown } }).usage.inputTokens).toEqual(expected)
    // The non-streaming path used to leave the uncached count out entirely.
    expect((await collectEvents(stream(...events()))).usage!.inputTokens).toEqual(expected)
  })
})
