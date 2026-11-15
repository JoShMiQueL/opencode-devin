/**
 * AI SDK `LanguageModelV3` facade over the Cascade chat stream.
 *
 * Models are discovered dynamically from the per-account catalog
 * (GetCascadeModelConfigs). Auth: the long-lived session token
 * (`devin-session-token$<JWT>`) as `apiKey`; a short-lived `user_jwt` is
 * minted automatically per session.
 *
 * Originally ported from ai-sdk-devin / pi-devin-auth (MIT).
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3FunctionTool,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider"
import {
  streamChatEvents,
  type ChatEvent,
  type ChatHistoryItem,
  type ChatToolChoice,
  type ChatToolDefinition,
} from "./chat.ts"
import {
  getCachedCatalog,
  ModelNotAvailableError,
  type CatalogSnapshot,
  type ModelCatalogEntry,
} from "./catalog.ts"
import { defaultMember, splitEffortSuffix, toEffortLevel, withEffortSuffix } from "./effort.ts"
import { DEFAULT_API_SERVER } from "../constants.ts"

/**
 * Resolve the model UID to send upstream.
 *
 * A model is published once per family, under its UID without the effort, and
 * the effort arrives as `providerOptions.devin.reasoningEffort` from the
 * variant the user picked. Upstream has no effort parameter: each effort is a
 * separate UID, so the choice is made here.
 *
 * Exported for tests: this is what the catalog lookup exists for, so it needs
 * to stay covered independently of the network.
 */
export function resolveEffortUid(
  modelId: string,
  catalog: readonly ModelCatalogEntry[] | undefined,
  requestedEffort: unknown,
): string {
  const effort = toEffortLevel(requestedEffort)
  const self = splitEffortSuffix(modelId)
  const family = catalog?.filter((entry) => (entry.baseModelUid ?? entry.modelUid) === self.baseModelUid) ?? []
  if (effort) {
    const match = family.find((entry) => entry.effortLevel === effort)
    if (match) return match.modelUid
    // The catalog is not a contract, so an effort it does not list is still
    // tried on a UID that already carries one.
    if (self.effortLevel) return withEffortSuffix(modelId, effort)
  }
  if (!catalog || catalog.some((entry) => entry.modelUid === modelId)) return modelId
  // A family id that is not itself a UID, e.g. `claude-opus-5-5`.
  return defaultMember(family)?.modelUid ?? modelId
}

// --- Prompt conversion: LanguageModelV3Prompt → ChatHistoryItem[] ---

type ContentParts = Exclude<ChatHistoryItem["content"], string>

/** Base64 payload of a file part, or `undefined` when it is not inline data. */
function inlineBase64(data: unknown): string | undefined {
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64")
  if (typeof data !== "string") return undefined
  const dataUrl = /^data:[^,]*;base64,(.*)$/s.exec(data)
  if (dataUrl) return dataUrl[1]
  return /^[a-z][a-z0-9+.-]*:/i.test(data) ? undefined : data
}

/**
 * Cascade carries images and nothing else. Anything else is replaced by a
 * note, so the model can say the attachment is missing instead of answering as
 * if it had never been sent, and is reported to the caller as a warning.
 */
function pushFile(
  parts: ContentParts,
  warnings: SharedV3Warning[],
  file: { mediaType: string; data: unknown; filename?: string },
): void {
  const base64 = file.mediaType.startsWith("image/") ? inlineBase64(file.data) : undefined
  if (base64 !== undefined) {
    parts.push({ type: "image", mimeType: file.mediaType, base64Data: base64 })
    return
  }
  const what = file.filename ? `${file.mediaType} file "${file.filename}"` : `${file.mediaType} file`
  const why = file.mediaType.startsWith("image/") ? "only inline image data can be sent" : "only images can be sent"
  parts.push({ type: "text", text: `[Attachment omitted: ${what}. The Devin provider could not send it; ${why}.]` })
  warnings.push({ type: "unsupported", feature: `${file.mediaType} file input`, details: `Omitted: ${why}.` })
}

/**
 * Flatten a tool result to what the model should read.
 *
 * The output is a tagged union, not the content itself: serialising it whole
 * sends the model `{"type":"text","value":"line1\\nline2"}` in place of the two
 * lines, which costs tokens on every tool call and is harder to read.
 */
function convertToolOutput(
  output: LanguageModelV3ToolResultOutput,
  warnings: SharedV3Warning[],
): { content: ContentParts; isError: boolean } {
  const text = (value: string): ContentParts => [{ type: "text", text: value }]
  switch (output.type) {
    case "text":
      return { content: text(output.value), isError: false }
    case "json":
      return { content: text(JSON.stringify(output.value)), isError: false }
    case "error-text":
      return { content: text(output.value), isError: true }
    case "error-json":
      return { content: text(JSON.stringify(output.value)), isError: true }
    case "execution-denied":
      return {
        content: text(output.reason ? `Tool execution was denied: ${output.reason}` : "Tool execution was denied."),
        isError: true,
      }
    case "content": {
      const content: ContentParts = []
      for (const part of output.value) {
        if (part.type === "text") content.push({ type: "text", text: part.text })
        else if (part.type === "image-data" || part.type === "file-data") pushFile(content, warnings, part)
        else {
          content.push({ type: "text", text: `[Attachment omitted: the Devin provider cannot send a ${part.type} part.]` })
          warnings.push({ type: "unsupported", feature: `${part.type} tool output` })
        }
      }
      return { content, isError: false }
    }
    default:
      return { content: text(JSON.stringify(output)), isError: false }
  }
}

/** Exported for tests. */
export function convertPrompt(prompt: LanguageModelV3Prompt): { messages: ChatHistoryItem[]; warnings: SharedV3Warning[] } {
  const items: ChatHistoryItem[] = []
  const warnings: SharedV3Warning[] = []
  for (const message of prompt) {
    if (message.role === "system") {
      items.push({ role: "system", content: message.content })
    } else if (message.role === "user") {
      const parts: ContentParts = []
      for (const part of message.content) {
        if (part.type === "text") parts.push({ type: "text", text: part.text })
        else if (part.type === "file") pushFile(parts, warnings, part)
      }
      items.push({ role: "user", content: parts })
    } else if (message.role === "assistant") {
      const parts: ContentParts = []
      const toolCalls: ChatHistoryItem["tool_calls"] = []
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text })
        } else if (part.type === "tool-call") {
          toolCalls?.push({
            id: part.toolCallId,
            name: part.toolName,
            arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
          })
        }
      }
      items.push({ role: "assistant", content: parts, tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined })
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          const { content, isError } = convertToolOutput(part.output, warnings)
          items.push({
            role: "tool",
            content,
            tool_call_id: part.toolCallId,
            ...(isError ? { is_error: true } : {}),
          })
        }
      }
    }
  }
  return { messages: items, warnings }
}

/**
 * Cascade reports uncached input, cache reads and cache writes as separate
 * counts: against the live API a repeated 165k-token prompt came back as
 * `input_tokens=4, cached_input_tokens=165031`. The total is their sum, and
 * `promptTokens` is already the uncached share.
 */
function toUsage(event: Extract<ChatEvent, { kind: "usage" }>): LanguageModelV3Usage {
  const { promptTokens, cachedInputTokens, cacheCreationInputTokens, completionTokens, reasoningTokens } = event
  return {
    inputTokens: {
      total:
        promptTokens === undefined
          ? undefined
          : promptTokens + (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0),
      noCache: promptTokens,
      cacheRead: cachedInputTokens,
      cacheWrite: cacheCreationInputTokens,
    },
    outputTokens: {
      total: completionTokens,
      text:
        completionTokens !== undefined && reasoningTokens !== undefined ? completionTokens - reasoningTokens : undefined,
      reasoning: reasoningTokens,
    },
  }
}

/**
 * Some upstream models end a turn that made tool calls with a plain stop, or
 * with no stop reason at all. The caller has to run the tools either way.
 */
const finishReasonFor = (reason: string, madeToolCalls: boolean): string =>
  madeToolCalls && reason === "stop" ? "tool_calls" : reason

function convertTools(tools: LanguageModelV3CallOptions["tools"]): ChatToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const out: ChatToolDefinition[] = []
  for (const tool of tools) {
    if (tool.type === "function") {
      out.push({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema })
    }
  }
  return out.length > 0 ? out : undefined
}

// --- Stream event conversion ---

// Text/reasoning coalescing thresholds — reduces stream events from
// hundreds of 5-byte micro-deltas to a few dozen batched chunks.
const COALESCE_INTERVAL_MS = 32
const COALESCE_MAX_BYTES = 128

const FINISH_REASON_MAP: Record<string, LanguageModelV3FinishReason["unified"]> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool-calls",
  content_filter: "content-filter",
}

const DEFAULT_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: undefined, reasoning: undefined },
}

/** Sentinel distinguishing a timer wake-up from an upstream event. */
const TICK = Symbol("coalesce-tick")

/**
 * Exported for tests: the Cascade event -> AI SDK stream translation is pure,
 * and interleaved parallel tool calls are the case most likely to regress.
 */
export async function* convertStreamEvents(
  events: AsyncGenerator<ChatEvent>,
  generateId: () => string,
  warnings: SharedV3Warning[] = [],
): AsyncGenerator<LanguageModelV3StreamPart> {
  let textId = ""
  let reasoningId = ""
  let textOpen = false
  let reasoningOpen = false
  let finishReason = "stop"
  let usage: LanguageModelV3Usage | undefined

  let textBuf = ""
  let textLastFlush = 0
  let reasoningBuf = ""
  let reasoningLastFlush = 0

  // Cascade interleaves argument deltas across parallel tool calls, so pending
  // arguments are buffered per call id. A single shared buffer would splice two
  // calls' JSON into one unparsable string.
  const openTools = new Map<string, { name: string; args: string }>()
  // Deltas that carry no id belong to the most recently opened call.
  let lastToolId = ""
  let madeToolCalls = false

  const pendingDeltas = (): LanguageModelV3StreamPart[] => {
    const parts: LanguageModelV3StreamPart[] = []
    if (textBuf) {
      parts.push({ type: "text-delta", id: textId, delta: textBuf })
      textBuf = ""
    }
    if (reasoningBuf) {
      parts.push({ type: "reasoning-delta", id: reasoningId, delta: reasoningBuf })
      reasoningBuf = ""
    }
    return parts
  }

  const closeBlocks = (): LanguageModelV3StreamPart[] => {
    const parts: LanguageModelV3StreamPart[] = []
    if (textOpen) {
      parts.push({ type: "text-end", id: textId })
      textOpen = false
    }
    if (reasoningOpen) {
      parts.push({ type: "reasoning-end", id: reasoningId })
      reasoningOpen = false
    }
    return parts
  }

  // The protocol has no end-of-tool-call marker, so a call cannot be completed
  // until the stream ends. They are emitted in the order they were started.
  // The arguments themselves are streamed as they arrive, see `tool_call_args`.
  const completedToolCalls = (): LanguageModelV3StreamPart[] => {
    const parts: LanguageModelV3StreamPart[] = []
    for (const [id, tool] of openTools) {
      parts.push({ type: "tool-input-end", id })
      parts.push({ type: "tool-call", toolCallId: id, toolName: tool.name, input: tool.args })
    }
    openTools.clear()
    return parts
  }

  /** Flush only the buffers that have been waiting longer than the interval. */
  const staleDeltas = (): LanguageModelV3StreamPart[] => {
    const now = Date.now()
    const parts: LanguageModelV3StreamPart[] = []
    if (textBuf && now - textLastFlush >= COALESCE_INTERVAL_MS) {
      parts.push({ type: "text-delta", id: textId, delta: textBuf })
      textBuf = ""
      textLastFlush = now
    }
    if (reasoningBuf && now - reasoningLastFlush >= COALESCE_INTERVAL_MS) {
      parts.push({ type: "reasoning-delta", id: reasoningId, delta: reasoningBuf })
      reasoningBuf = ""
      reasoningLastFlush = now
    }
    return parts
  }

  const handleEvent = (event: ChatEvent): LanguageModelV3StreamPart[] => {
    const parts: LanguageModelV3StreamPart[] = []
    switch (event.kind) {
      case "text": {
        // Flush the other block before opening this one, so the parts stay in
        // causal order. Without this, text buffered right before the model
        // starts thinking would stay invisible until more text, a tool call, or
        // the end of the stream.
        if (reasoningOpen && reasoningBuf) {
          parts.push({ type: "reasoning-delta", id: reasoningId, delta: reasoningBuf })
          reasoningBuf = ""
          reasoningLastFlush = Date.now()
        }
        if (!textOpen) {
          textId = generateId()
          textOpen = true
          textLastFlush = Date.now()
          parts.push({ type: "text-start", id: textId })
        }
        textBuf += event.text
        if (textBuf.length >= COALESCE_MAX_BYTES || Date.now() - textLastFlush >= COALESCE_INTERVAL_MS) {
          parts.push({ type: "text-delta", id: textId, delta: textBuf })
          textBuf = ""
          textLastFlush = Date.now()
        }
        break
      }
      case "reasoning": {
        if (textOpen && textBuf) {
          parts.push({ type: "text-delta", id: textId, delta: textBuf })
          textBuf = ""
          textLastFlush = Date.now()
        }
        if (!reasoningOpen) {
          reasoningId = generateId()
          reasoningOpen = true
          reasoningLastFlush = Date.now()
          parts.push({ type: "reasoning-start", id: reasoningId })
        }
        reasoningBuf += event.text
        if (reasoningBuf.length >= COALESCE_MAX_BYTES || Date.now() - reasoningLastFlush >= COALESCE_INTERVAL_MS) {
          parts.push({ type: "reasoning-delta", id: reasoningId, delta: reasoningBuf })
          reasoningBuf = ""
          reasoningLastFlush = Date.now()
        }
        break
      }
      case "tool_call_start": {
        parts.push(...pendingDeltas())
        parts.push(...closeBlocks())
        const id = event.id || generateId()
        // A repeated start keeps the first name: the call was already announced
        // under it, and a host rejects a call whose name changes midway.
        if (!openTools.has(id)) {
          openTools.set(id, { name: event.name, args: "" })
          madeToolCalls = true
          parts.push({ type: "tool-input-start", id, toolName: event.name })
        }
        lastToolId = id
        break
      }
      case "tool_call_args": {
        const id = event.id ?? lastToolId
        const open = openTools.get(id)
        // An orphan delta has no call to attach to; dropping it beats inventing
        // a nameless tool call.
        if (open && event.argsDelta) {
          open.args += event.argsDelta
          // Streamed so a long call, such as writing a file, shows progress
          // instead of looking stalled until the whole turn has arrived.
          parts.push({ type: "tool-input-delta", id, delta: event.argsDelta })
        }
        break
      }
      case "finish": {
        parts.push(...pendingDeltas())
        parts.push(...closeBlocks())
        finishReason = event.reason
        break
      }
      case "usage": {
        usage = toUsage(event)
        break
      }
    }
    return parts
  }

  // The loop is woken by a timer as well as by upstream events, so text that
  // arrives and is then followed by silence is still delivered promptly instead
  // of waiting for the next event or the end of the stream.
  //
  // A single `next()` is kept in flight across iterations: when the timer wins
  // the race the pending read is handed to the next iteration rather than
  // dropped, which is what keeps this from losing events.
  const upstream = events[Symbol.asyncIterator]()
  let inFlight: Promise<IteratorResult<ChatEvent>> | null = null
  const nextEvent = () => (inFlight ??= upstream.next())
  let wake: (() => void) | undefined
  const ticker = setInterval(() => wake?.(), COALESCE_INTERVAL_MS)
  const tick = () =>
    new Promise<typeof TICK>((resolve) => {
      wake = () => {
        wake = undefined
        resolve(TICK)
      }
    })
  // With nothing buffered there is nothing to flush, so the timer race — and its
  // allocation — is skipped entirely for the common fast-streaming path.
  const nextStep = (): Promise<IteratorResult<ChatEvent> | typeof TICK> =>
    textBuf || reasoningBuf ? Promise.race([nextEvent(), tick()]) : nextEvent()

  yield { type: "stream-start", warnings }

  try {
    for (;;) {
      const step = await nextStep()
      if (step === TICK) {
        // The upstream read is still in flight; keep it for the next iteration.
        yield* staleDeltas()
        continue
      }
      // Consume the read. Without clearing it here, the same settled promise
      // would be handed back on the next iteration and the same event replayed
      // forever.
      inFlight = null
      if (step.done) break
      yield* handleEvent(step.value)
    }
  } finally {
    clearInterval(ticker)
    inFlight = null
    // Let the upstream generator finish so its own cleanup runs.
    void upstream.return?.(undefined)
  }

  // Final flush
  yield* pendingDeltas()
  yield* closeBlocks()
  yield* completedToolCalls()

  finishReason = finishReasonFor(finishReason, madeToolCalls)
  const rawReason = FINISH_REASON_MAP[finishReason] ?? "stop"
  yield {
    type: "finish",
    finishReason: { unified: rawReason, raw: finishReason },
    usage: usage ?? DEFAULT_USAGE,
  } as LanguageModelV3StreamPart
}

// --- Collect for doGenerate ---

interface CollectedResult {
  text: string
  reasoning: string
  toolCalls: { id: string; name: string; args: string }[]
  finishReason: string
  usage?: LanguageModelV3Usage
}

/** Exported for tests; mirrors `convertStreamEvents` for the non-streaming path. */
export async function collectEvents(events: AsyncGenerator<ChatEvent>): Promise<CollectedResult> {
  const result: CollectedResult = { text: "", reasoning: "", toolCalls: [], finishReason: "stop" }
  // Keyed by call id for the same reason as the streaming path: parallel tool
  // calls interleave their argument deltas.
  const openTools = new Map<string, { id: string; name: string; args: string }>()
  let lastToolId = ""
  let anonymous = 0

  const commit = () => {
    for (const tool of openTools.values()) result.toolCalls.push(tool)
    openTools.clear()
  }

  for await (const event of events) {
    switch (event.kind) {
      case "text":
        result.text += event.text
        break
      case "reasoning":
        result.reasoning += event.text
        break
      case "tool_call_start": {
        // A start without an id still needs its own buffer, otherwise two
        // anonymous calls would share one.
        const id = event.id ?? `__anonymous_${anonymous++}`
        const open = openTools.get(id)
        if (open) open.name = event.name
        else openTools.set(id, { id: event.id ?? id, name: event.name, args: "" })
        lastToolId = id
        break
      }
      case "tool_call_args": {
        const open = openTools.get(event.id ?? lastToolId)
        if (open) open.args += event.argsDelta
        break
      }
      case "finish":
        result.finishReason = event.reason
        break
      case "usage":
        result.usage = toUsage(event)
        break
    }
  }
  commit()
  result.finishReason = finishReasonFor(result.finishReason, result.toolCalls.length > 0)
  return result
}

interface LanguageModelOptions {
  modelId: string
  apiKey: string
  apiServerUrl?: string
  /**
   * Resolves the per-account catalog on demand. The reasoning-effort override
   * needs it to tell "this variant exists" from "this model has no such
   * variant", so the UID cannot be resolved without it.
   */
  loadCatalog: () => Promise<CatalogSnapshot | undefined>
}

/**
 * Refuse a request the catalog says cannot succeed, and warn about one it cannot
 * vouch for.
 *
 * Disabled is a hard stop because the account cannot use it. Absent is only a
 * warning: the catalog is not a contract that it enumerates every uid Cascade
 * accepts, so the upstream response stays the authority.
 */
function checkModelUsable(modelId: string, catalog: CatalogSnapshot | undefined): void {
  if (!catalog) return
  const entry = catalog.entries.find((candidate) => candidate.modelUid === modelId)
  if (!entry) {
    console.warn(
      `[opencode-devin] model "${modelId}" is not in the Cascade catalog for this account; sending the request anyway`,
    )
    return
  }
  if (entry.disabled) throw new ModelNotAvailableError(modelId, entry.label)
}

/**
 * Whether the catalog vouches for this model.
 *
 * `true` when the account's catalog lists it, `false` when the catalog loaded
 * and does not mention it, `undefined` when no catalog was available at all.
 */
function isKnownToCatalog(modelId: string, catalog: CatalogSnapshot | undefined): boolean | undefined {
  if (!catalog) return undefined
  return catalog.entries.some((entry) => entry.modelUid === modelId)
}

/**
 * Add the likely cause to a failure for a model the catalog never listed.
 *
 * Refusing such a model up front would be wrong: the catalog is not a contract
 * that it enumerates every uid Cascade accepts, so a false rejection would break
 * a model that does work. Instead the request is allowed to fail the way
 * upstream makes it fail, and the probable reason is attached to that error —
 * otherwise the user has to correlate a log warning with an HTTP failure.
 */
function hintUnlistedModel(cause: unknown, modelId: string, known: boolean | undefined): unknown {
  if (known !== false || !(cause instanceof Error)) return cause
  cause.message +=
    ` — model "${modelId}" is not listed in your Cognition catalog, which is the most likely reason.` +
    ` If it should be available, run /connect to refresh the catalog, or pick a model from /models.`
  return cause
}

function createLanguageModel(options: LanguageModelOptions): LanguageModelV3 {
  const run = async (callOptions: LanguageModelV3CallOptions, signal: AbortSignal | undefined) => {
    const catalog = await options.loadCatalog()
    const effortOverride = callOptions.providerOptions?.devin?.reasoningEffort
    const resolvedModelId = resolveEffortUid(options.modelId, catalog?.enabled, effortOverride)
    // Checked on the UID that is sent: a family id is not a UID of its own.
    checkModelUsable(resolvedModelId, catalog)
    const { messages, warnings } = convertPrompt(callOptions.prompt)
    return {
      resolvedModelId,
      warnings,
      knownToCatalog: isKnownToCatalog(resolvedModelId, catalog),
      events: streamChatEvents({
        apiKey: options.apiKey,
        apiServerUrl: options.apiServerUrl,
        modelUid: resolvedModelId,
        messages,
        tools: convertTools(callOptions.tools),
        toolChoice: callOptions.toolChoice as ChatToolChoice | undefined,
        completionOpts: {
          maxOutputTokens: callOptions.maxOutputTokens,
          temperature: callOptions.temperature,
          topP: callOptions.topP,
          topK: callOptions.topK,
        },
        signal,
      }),
    }
  }

  return {
    specificationVersion: "v3",
    provider: "devin",
    modelId: options.modelId,
    supportedUrls: {},
    async doGenerate(callOptions): Promise<LanguageModelV3GenerateResult> {
      const { events, knownToCatalog, warnings } = await run(callOptions, callOptions.abortSignal)
      const collected = await collectEvents(events).catch((cause: unknown) => {
        throw hintUnlistedModel(cause, options.modelId, knownToCatalog)
      })
      const content: LanguageModelV3GenerateResult["content"] = []
      if (collected.reasoning) content.push({ type: "reasoning", text: collected.reasoning })
      if (collected.text) content.push({ type: "text", text: collected.text })
      for (const call of collected.toolCalls) {
        content.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.args })
      }
      return {
        content,
        finishReason: {
          unified: FINISH_REASON_MAP[collected.finishReason] ?? "stop",
          raw: collected.finishReason,
        },
        usage: collected.usage ?? DEFAULT_USAGE,
        warnings,
      }
    },
    async doStream(callOptions) {
      // Owned so that cancelling the stream can tear the request down; the
      // caller's signal is honoured alongside it.
      const abort = new AbortController()
      const signal = callOptions.abortSignal
        ? AbortSignal.any([callOptions.abortSignal, abort.signal])
        : abort.signal
      const { events, knownToCatalog, warnings } = await run(callOptions, signal)
      const generateId = () => crypto.randomUUID()
      const generator = convertStreamEvents(events, generateId, warnings)
      const modelId = options.modelId
      let cancelled = false
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          try {
            for await (const chunk of generator) {
              if (cancelled) break
              controller.enqueue(chunk)
            }
            if (!cancelled) controller.close()
          } catch (cause) {
            if (!cancelled) controller.error(hintUnlistedModel(cause, modelId, knownToCatalog))
          }
        },
        async cancel() {
          cancelled = true
          // Aborting is what actually releases the connection. `generator.return()`
          // alone is not enough: it is queued behind the in-flight read, so the
          // request would stay open until the idle timeout fired.
          abort.abort(new Error("Stream cancelled by the consumer"))
          await generator.return(undefined).catch(() => {})
        },
      })
      return { stream }
    },
  }
}

export interface DevinProviderOptions {
  apiKey: string
  baseURL?: string
}

export interface DevinProvider {
  languageModel(modelId: string): LanguageModelV3
}

export function createDevin(options: DevinProviderOptions): DevinProvider {
  const apiKey = options.apiKey ?? ""
  let catalog: CatalogSnapshot | undefined
  let pending: Promise<CatalogSnapshot | undefined> | undefined

  /**
   * Per-account catalog, memoized for the life of the provider.
   *
   * `getCachedCatalog` already dedupes concurrent fetches and caches the result
   * for 10 minutes, so this is normally a cache hit — the plugin's `publish()`
   * warms the same module-level cache before any chat happens. On failure it
   * resolves `undefined`, and the request proceeds uncatalogued rather than being
   * rejected on a guess.
   */
  const loadCatalog = (): Promise<CatalogSnapshot | undefined> => {
    if (!apiKey) return Promise.resolve(undefined)
    if (catalog) return Promise.resolve(catalog)
    pending ??= getCachedCatalog(apiKey, options.baseURL)
      .then((result) => {
        if (result) {
          const entries = Array.from(result.byUid.values())
          catalog = { entries, enabled: entries.filter((entry) => !entry.disabled) }
        }
        return catalog
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  return {
    languageModel(modelId: string): LanguageModelV3 {
      return createLanguageModel({
        modelId,
        apiKey,
        apiServerUrl: options.baseURL,
        loadCatalog,
      })
    },
  }
}
