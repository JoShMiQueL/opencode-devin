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
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { streamChatEvents, type ChatEvent, type ChatHistoryItem, type ChatToolDefinition } from "./chat.ts"
import { getCachedCatalog, type Catalog, type ModelCatalogEntry } from "./catalog.ts"
import { DEFAULT_API_SERVER } from "../constants.ts"

/** Valid reasoning effort levels (encoded as UID suffixes in the catalog). */
const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * Resolve the actual model UID to send upstream, applying an optional
 * reasoning-effort override from providerOptions: swap an existing effort
 * suffix, or append one when the catalog lists that variant.
 */
function resolveEffortUid(
  modelId: string,
  catalog: readonly ModelCatalogEntry[] | undefined,
  requestedEffort: unknown,
): string {
  const effort = typeof requestedEffort === "string" ? requestedEffort.toLowerCase() : ""
  if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) return modelId
  const effortMatch = modelId.match(/-(none|low|medium|high|xhigh|max)$/)
  if (effortMatch?.[1]) return modelId.slice(0, -effortMatch[1].length - 1) + "-" + effort
  if (catalog?.some((entry) => entry.baseModelUid === modelId && entry.effortLevel === effort)) {
    return modelId + "-" + effort
  }
  return modelId
}

/** Calculate the dollar cost of a request from token usage and model pricing. */
export function calculateCost(
  usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number },
  pricing?: ModelCatalogEntry["pricing"],
): number | undefined {
  if (!pricing) return undefined
  const input = ((usage.inputTokens ?? 0) / 1_000_000) * pricing.input
  const cached = ((usage.cachedInputTokens ?? 0) / 1_000_000) * pricing.cachedInput
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * pricing.output
  const total = input + cached + output
  return total > 0 ? Math.round(total * 1_000_000) / 1_000_000 : 0
}

// --- Prompt conversion: LanguageModelV3Prompt → ChatHistoryItem[] ---

function convertPrompt(prompt: LanguageModelV3Prompt): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = []
  for (const message of prompt) {
    if (message.role === "system") {
      items.push({ role: "system", content: message.content })
    } else if (message.role === "user") {
      const parts: Exclude<ChatHistoryItem["content"], string> = []
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text })
        } else if (part.type === "file" && part.mediaType.startsWith("image/") && typeof part.data !== "object") {
          const data = typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64")
          parts.push({ type: "image", mimeType: part.mediaType, base64Data: data })
        }
      }
      items.push({ role: "user", content: parts })
    } else if (message.role === "assistant") {
      const parts: Exclude<ChatHistoryItem["content"], string> = []
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
          const output = typeof part.output === "string" ? part.output : JSON.stringify(part.output)
          items.push({ role: "tool", content: output, tool_call_id: part.toolCallId })
        }
      }
    }
  }
  return items
}

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

async function* convertStreamEvents(
  events: AsyncGenerator<ChatEvent>,
  generateId: () => string,
  pricing?: ModelCatalogEntry["pricing"],
): AsyncGenerator<LanguageModelV3StreamPart> {
  let textId = ""
  let reasoningId = ""
  let textOpen = false
  let reasoningOpen = false
  let currentToolId = ""
  let currentToolName = ""
  let toolInputOpen = false
  let pendingToolArgs = ""
  let finishReason = "stop"
  let usage: LanguageModelV3Usage | undefined

  let textBuf = ""
  let textLastFlush = 0
  let reasoningBuf = ""
  let reasoningLastFlush = 0

  yield { type: "stream-start", warnings: [] }

  for await (const event of events) {
    switch (event.kind) {
      case "text": {
        if (!textOpen) {
          textId = generateId()
          textOpen = true
          textLastFlush = Date.now()
          yield { type: "text-start", id: textId }
        }
        textBuf += event.text
        if (textBuf.length >= COALESCE_MAX_BYTES || Date.now() - textLastFlush >= COALESCE_INTERVAL_MS) {
          yield { type: "text-delta", id: textId, delta: textBuf }
          textBuf = ""
          textLastFlush = Date.now()
        }
        break
      }
      case "reasoning": {
        if (!reasoningOpen) {
          reasoningId = generateId()
          reasoningOpen = true
          reasoningLastFlush = Date.now()
          yield { type: "reasoning-start", id: reasoningId }
        }
        reasoningBuf += event.text
        if (reasoningBuf.length >= COALESCE_MAX_BYTES || Date.now() - reasoningLastFlush >= COALESCE_INTERVAL_MS) {
          yield { type: "reasoning-delta", id: reasoningId, delta: reasoningBuf }
          reasoningBuf = ""
          reasoningLastFlush = Date.now()
        }
        break
      }
      case "tool_call_start": {
        if (textBuf) {
          yield { type: "text-delta", id: textId, delta: textBuf }
          textBuf = ""
        }
        if (reasoningBuf) {
          yield { type: "reasoning-delta", id: reasoningId, delta: reasoningBuf }
          reasoningBuf = ""
        }
        if (textOpen) {
          yield { type: "text-end", id: textId }
          textOpen = false
        }
        if (reasoningOpen) {
          yield { type: "reasoning-end", id: reasoningId }
          reasoningOpen = false
        }
        if (toolInputOpen) {
          yield { type: "tool-call", toolCallId: currentToolId, toolName: currentToolName, input: pendingToolArgs }
        }
        currentToolId = event.id || generateId()
        currentToolName = event.name
        toolInputOpen = true
        pendingToolArgs = ""
        break
      }
      case "tool_call_args": {
        pendingToolArgs += event.argsDelta
        break
      }
      case "finish": {
        if (textBuf) {
          yield { type: "text-delta", id: textId, delta: textBuf }
          textBuf = ""
        }
        if (reasoningBuf) {
          yield { type: "reasoning-delta", id: reasoningId, delta: reasoningBuf }
          reasoningBuf = ""
        }
        if (textOpen) {
          yield { type: "text-end", id: textId }
          textOpen = false
        }
        if (reasoningOpen) {
          yield { type: "reasoning-end", id: reasoningId }
          reasoningOpen = false
        }
        if (toolInputOpen) {
          yield { type: "tool-call", toolCallId: currentToolId, toolName: currentToolName, input: pendingToolArgs }
          toolInputOpen = false
        }
        finishReason = event.reason
        break
      }
      case "usage": {
        usage = {
          inputTokens: {
            total: event.promptTokens,
            noCache:
              event.promptTokens !== undefined && event.cachedInputTokens !== undefined
                ? event.promptTokens - event.cachedInputTokens
                : undefined,
            cacheRead: event.cachedInputTokens,
            cacheWrite: event.cacheCreationInputTokens,
          },
          outputTokens: {
            total: event.completionTokens,
            text:
              event.completionTokens !== undefined && event.reasoningTokens !== undefined
                ? event.completionTokens - event.reasoningTokens
                : undefined,
            reasoning: event.reasoningTokens,
          },
        }
        break
      }
    }
  }

  // Final flush
  if (textBuf) yield { type: "text-delta", id: textId, delta: textBuf }
  if (reasoningBuf) yield { type: "reasoning-delta", id: reasoningId, delta: reasoningBuf }
  if (textOpen) yield { type: "text-end", id: textId }
  if (reasoningOpen) yield { type: "reasoning-end", id: reasoningId }
  if (toolInputOpen) {
    yield { type: "tool-call", toolCallId: currentToolId, toolName: currentToolName, input: pendingToolArgs }
  }

  const inputTotal = usage?.inputTokens?.total
  const cachedRead = usage?.inputTokens?.cacheRead
  const outputTotal = usage?.outputTokens?.total
  const cost = calculateCost(
    { inputTokens: inputTotal, cachedInputTokens: cachedRead, outputTokens: outputTotal },
    pricing,
  )
  const rawReason = FINISH_REASON_MAP[finishReason] ?? "stop"
  yield {
    type: "finish",
    finishReason: { unified: rawReason, raw: finishReason },
    usage: usage ?? DEFAULT_USAGE,
    ...(cost !== undefined ? { providerMetadata: { devin: { cost } } } : {}),
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

async function collectEvents(events: AsyncGenerator<ChatEvent>): Promise<CollectedResult> {
  const result: CollectedResult = { text: "", reasoning: "", toolCalls: [], finishReason: "stop" }
  let currentTool: { id: string; name: string; args: string } | null = null
  for await (const event of events) {
    switch (event.kind) {
      case "text":
        result.text += event.text
        break
      case "reasoning":
        result.reasoning += event.text
        break
      case "tool_call_start":
        if (currentTool) result.toolCalls.push(currentTool)
        currentTool = { id: event.id, name: event.name, args: "" }
        break
      case "tool_call_args":
        if (currentTool) currentTool.args += event.argsDelta
        break
      case "finish":
        if (currentTool) {
          result.toolCalls.push(currentTool)
          currentTool = null
        }
        result.finishReason = event.reason
        break
      case "usage":
        result.usage = {
          inputTokens: {
            total: event.promptTokens,
            noCache: undefined,
            cacheRead: event.cachedInputTokens,
            cacheWrite: event.cacheCreationInputTokens,
          },
          outputTokens: { total: event.completionTokens, text: undefined, reasoning: event.reasoningTokens },
        }
        break
    }
  }
  if (currentTool) result.toolCalls.push(currentTool)
  return result
}

interface LanguageModelOptions {
  modelId: string
  apiKey: string
  apiServerUrl?: string
  catalog?: readonly ModelCatalogEntry[]
  catalogMap?: Map<string, ModelCatalogEntry>
}

function createLanguageModel(options: LanguageModelOptions): LanguageModelV3 {
  const run = (callOptions: LanguageModelV3CallOptions) => {
    const effortOverride = callOptions.providerOptions?.devin?.reasoningEffort
    const resolvedModelId = resolveEffortUid(options.modelId, options.catalog, effortOverride)
    const pricing = options.catalogMap?.get(resolvedModelId)?.pricing
    return {
      resolvedModelId,
      pricing,
      events: streamChatEvents({
        apiKey: options.apiKey,
        apiServerUrl: options.apiServerUrl,
        modelUid: resolvedModelId,
        messages: convertPrompt(callOptions.prompt),
        tools: convertTools(callOptions.tools),
        completionOpts: {
          maxOutputTokens: callOptions.maxOutputTokens,
          temperature: callOptions.temperature,
          topP: callOptions.topP,
          topK: callOptions.topK,
        },
        signal: callOptions.abortSignal,
      }),
    }
  }

  return {
    specificationVersion: "v3",
    provider: "devin",
    modelId: options.modelId,
    supportedUrls: {},
    async doGenerate(callOptions): Promise<LanguageModelV3GenerateResult> {
      const { pricing, events } = run(callOptions)
      const collected = await collectEvents(events)
      const content: LanguageModelV3GenerateResult["content"] = []
      if (collected.reasoning) content.push({ type: "reasoning", text: collected.reasoning })
      if (collected.text) content.push({ type: "text", text: collected.text })
      for (const call of collected.toolCalls) {
        content.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.args })
      }
      const cost = calculateCost(
        {
          inputTokens: collected.usage?.inputTokens?.total,
          cachedInputTokens: collected.usage?.inputTokens?.cacheRead,
          outputTokens: collected.usage?.outputTokens?.total,
        },
        pricing,
      )
      return {
        content,
        finishReason: {
          unified: FINISH_REASON_MAP[collected.finishReason] ?? "stop",
          raw: collected.finishReason,
        },
        usage: collected.usage ?? DEFAULT_USAGE,
        warnings: [],
        ...(cost !== undefined ? { providerMetadata: { devin: { cost } } } : {}),
      }
    },
    async doStream(callOptions) {
      const { pricing, events } = run(callOptions)
      const generateId = () => crypto.randomUUID()
      const generator = convertStreamEvents(events, generateId, pricing)
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          try {
            for await (const chunk of generator) {
              controller.enqueue(chunk)
            }
            controller.close()
          } catch (cause) {
            controller.error(cause)
          }
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
  /** Fetch the live model catalog for this account. Returns all enabled models. */
  models(): Promise<ModelCatalogEntry[]>
}

export function createDevin(options: DevinProviderOptions): DevinProvider {
  const apiKey = options.apiKey ?? ""
  let cachedModels: ModelCatalogEntry[] | undefined
  let catalogMap: Map<string, ModelCatalogEntry> | undefined

  return {
    languageModel(modelId: string): LanguageModelV3 {
      return createLanguageModel({
        modelId,
        apiKey,
        apiServerUrl: options.baseURL,
        catalog: cachedModels,
        catalogMap,
      })
    },
    async models(): Promise<ModelCatalogEntry[]> {
      if (!apiKey) return []
      const catalog: Catalog | null = await getCachedCatalog(apiKey, options.baseURL)
      if (!catalog) return []
      const models = Array.from(catalog.byUid.values()).filter((entry) => !entry.disabled)
      cachedModels = models
      catalogMap = new Map(models.map((entry) => [entry.modelUid, entry]))
      return models
    },
  }
}
