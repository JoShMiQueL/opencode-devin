/**
 * `GetChatMessage` — chat streaming over Cognition's Connect-RPC endpoint.
 *
 * Field layouts come from mitm captures of the Windsurf language_server.
 * Originally ported from pi-devin-auth (MIT, Copyright (c) 2026 nmzpy).
 */

import * as zlib from "node:zlib"
import {
  encodeMessage,
  encodeString,
  encodeVarintField,
  frameConnectStream,
  iterFields,
} from "./wire.ts"
import { buildMetadata } from "./metadata.ts"
import { getCachedUserJwt } from "./auth.ts"
import { DEFAULT_API_SERVER } from "../constants.ts"

const STREAM_IDLE_MS = 120_000
const STREAM_TTFB_MS = 60_000
const MAX_TOOL_DESC_LEN = 6998

export class CloudChatError extends Error {
  readonly code?: string
  readonly traceId?: string
  constructor(message: string, code?: string, traceId?: string) {
    super(message)
    this.name = "CloudChatError"
    this.code = code
    this.traceId = traceId
  }
}

// --- Request encoding ---

/** Cognition rejects source=3 for system; system content is inlined into user turns. */
const SOURCE_BY_ROLE = { user: 1, assistant: 2, system: 1, tool: 4 } as const

export type ChatRole = keyof typeof SOURCE_BY_ROLE

export interface ChatImage {
  mimeType: string
  base64Data: string
  caption?: string
}

export type ChatContent = string | Array<{ type: "text"; text: string } | ({ type: "image" } & ChatImage)>

export interface ChatToolCall {
  id: string
  name: string
  arguments: string
}

export interface ChatHistoryItem {
  role: ChatRole
  content: ChatContent
  tool_call_id?: string
  tool_calls?: ChatToolCall[]
}

export interface ChatToolDefinition {
  name: string
  description?: string
  parameters?: unknown
}

export interface CompletionOptions {
  maxInputTokens?: number
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
}

export type ChatEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call_start"; id: string; name: string }
  | { kind: "tool_call_args"; argsDelta: string; id?: string }
  | { kind: "finish"; reason: string }
  | {
      kind: "usage"
      promptTokens?: number
      completionTokens?: number
      totalTokens?: number
      cachedInputTokens?: number
      cacheCreationInputTokens?: number
      reasoningTokens?: number
    }

export interface StreamChatRequest {
  apiKey: string
  apiServerUrl?: string
  modelUid: string
  messages: ChatHistoryItem[]
  tools?: ChatToolDefinition[]
  cascadeId?: string
  completionOpts?: CompletionOptions
  signal?: AbortSignal
}

function encodeImageData(image: ChatImage): Buffer {
  const parts = [encodeString(1, image.base64Data), encodeString(2, image.mimeType)]
  if (image.caption) parts.push(encodeString(3, image.caption))
  return Buffer.concat(parts)
}

function encodeToolCall(call: ChatToolCall): Buffer {
  return Buffer.concat([encodeString(1, call.id), encodeString(2, call.name), encodeString(3, call.arguments)])
}

function encodePrompt(
  content: Exclude<ChatContent, string>,
  source: number,
  opts?: { toolCallId?: string; toolCalls?: ChatToolCall[] },
): Buffer {
  const text = content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const images = content.filter((part): part is { type: "image" } & ChatImage => part.type === "image")
  const parts = [
    encodeVarintField(2, source),
    encodeString(3, text),
    encodeVarintField(4, Math.max(1, Math.floor(text.length / 4))),
    encodeVarintField(5, 1),
  ]
  if (opts?.toolCallId) parts.push(encodeString(7, opts.toolCallId))
  if (opts?.toolCalls) for (const call of opts.toolCalls) parts.push(encodeMessage(6, encodeToolCall(call)))
  for (const image of images) parts.push(encodeMessage(10, encodeImageData(image)))
  return Buffer.concat(parts)
}

function textOf(content: ChatContent): string {
  if (typeof content === "string") return content
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

/** Cascade has no system role: fold system content into the next user turn. */
function collapseSystemIntoUser(messages: ChatHistoryItem[]): ChatHistoryItem[] {
  if (!messages.some((message) => message.role === "system")) return messages
  const out: ChatHistoryItem[] = []
  let pendingSystem: string[] = []
  for (const message of messages) {
    if (message.role === "system") {
      const text = textOf(message.content)
      if (text) pendingSystem.push(text)
    } else if (message.role === "user" && pendingSystem.length > 0) {
      const content = normalizeContent(message.content)
      const images = content.filter((part): part is { type: "image" } & ChatImage => part.type === "image")
      const wrapped = `<system>\n${pendingSystem.join("\n\n")}\n</system>\n${textOf(content)}`
      out.push({ role: "user", content: [{ type: "text", text: wrapped }, ...images] })
      pendingSystem = []
    } else {
      out.push(message)
    }
  }
  if (pendingSystem.length > 0) {
    out.push({ role: "user", content: [{ type: "text", text: `<system>\n${pendingSystem.join("\n\n")}\n</system>` }] })
  }
  return out
}

type NormalizedPart = { type: "text"; text: string } | ({ type: "image" } & ChatImage)

function normalizeContent(content: ChatContent): NormalizedPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  const out: NormalizedPart[] = []
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      out.push({ type: "text", text: part.text })
    } else if (part.type === "image" && typeof part.base64Data === "string") {
      out.push({ type: "image", mimeType: part.mimeType ?? "image/png", base64Data: part.base64Data, caption: part.caption })
    }
  }
  return out
}

function encodeToolDef(tool: ChatToolDefinition): Buffer {
  const raw = tool.description ?? ""
  const description =
    raw.length > MAX_TOOL_DESC_LEN ? `${raw.slice(0, MAX_TOOL_DESC_LEN - 24)}\n…(truncated for cloud)` : raw
  return Buffer.concat([
    encodeString(1, tool.name),
    encodeString(2, description),
    encodeString(3, JSON.stringify(tool.parameters ?? {})),
  ])
}

function encodeCompletionConfiguration(opts: CompletionOptions): Buffer {
  const float64 = (fieldNum: number, value: number) => {
    const buf = Buffer.alloc(8)
    buf.writeDoubleLE(value, 0)
    return Buffer.concat([Buffer.from([(fieldNum << 3) | 1]), buf])
  }
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeVarintField(2, opts.maxInputTokens ?? 64_000),
    encodeVarintField(3, opts.maxOutputTokens ?? 128_000),
    float64(5, opts.temperature ?? 0.7),
    float64(6, opts.topP ?? 0.95),
    encodeVarintField(7, opts.topK ?? 50),
    float64(8, 1.0),
    float64(11, 1.0),
  ])
}

interface SessionIds {
  sessionId: string
  cascadeId: string
}

const sessionCache = new Map<string, SessionIds>()

function getOrAllocateSessionIds(apiKey: string, host: string, cascadeIdOverride?: string): SessionIds {
  const key = `${host}${apiKey}`
  let ids = sessionCache.get(key)
  if (!ids) {
    ids = { sessionId: crypto.randomUUID(), cascadeId: cascadeIdOverride ?? crypto.randomUUID() }
    sessionCache.set(key, ids)
  } else if (cascadeIdOverride && ids.cascadeId !== cascadeIdOverride) {
    ids = { sessionId: ids.sessionId, cascadeId: cascadeIdOverride }
    sessionCache.set(key, ids)
  }
  return ids
}

function buildGetChatMessageRequest(args: {
  apiKey: string
  userJwt: string
  modelUid: string
  messages: ChatHistoryItem[]
  tools?: ChatToolDefinition[]
  cascadeId: string
  promptId: string
  sessionId: string
  requestId: bigint
  triggerId: string
  completionOpts?: CompletionOptions
}): Buffer {
  const metadata = buildMetadata({
    apiKey: args.apiKey,
    userJwt: args.userJwt,
    sessionId: args.sessionId,
    requestId: args.requestId,
    triggerId: args.triggerId,
  })
  const collapsed = collapseSystemIntoUser(args.messages)
  const promptParts = collapsed.map((message) =>
    encodeMessage(
      3,
      encodePrompt(normalizeContent(message.content), SOURCE_BY_ROLE[message.role] ?? 1, {
        toolCallId: message.tool_call_id,
        toolCalls: message.tool_calls,
      }),
    ),
  )
  // Field layout from mitm capture of the Windsurf language_server:
  //   #1  metadata (message)
  //   #3  chat_message_prompts (repeated — one element per history turn)
  //   #7  request_type (varint enum, 5 = CASCADE)
  //   #8  completion_configuration (message)
  //   #10 tools (repeated ChatToolDefinition)
  //   #16 cascade_id (string)
  //   #21 chat_model_uid (string)
  //   #22 prompt_id (string)
  const toolParts = (args.tools ?? []).map((tool) => encodeMessage(10, encodeToolDef(tool)))
  return Buffer.concat([
    encodeMessage(1, metadata),
    ...promptParts,
    encodeVarintField(7, 5),
    encodeMessage(8, encodeCompletionConfiguration(args.completionOpts ?? {})),
    ...toolParts,
    encodeString(16, args.cascadeId),
    encodeString(21, args.modelUid),
    encodeString(22, args.promptId),
  ])
}

// --- Response decoding ---

type DecodedEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call_start"; id: string; name: string }
  | { kind: "tool_call_args"; argsDelta: string; id?: string }
  | { kind: "finish"; reason: string }
  | {
      kind: "usage"
      promptTokens?: number
      completionTokens?: number
      totalTokens?: number
      cachedInputTokens?: number
      cacheCreationInputTokens?: number
      reasoningTokens?: number
    }

function* decodeChatFrame(buf: Buffer): Generator<DecodedEvent> {
  for (const field of iterFields(buf)) {
    if (field.num === 5 && field.wire === 0) {
      // Finish reason (varint) — StopReason enum:
      // 0 UNSPECIFIED → stop, 1 INCOMPLETE → length, 2 STOP_PATTERN → stop,
      // 3 MAX_TOKENS → length, 10 FUNCTION_CALL → tool_calls, 11 CONTENT_FILTER → content_filter
      const value = Number(field.value)
      let reason = "stop"
      if (value === 10) reason = "tool_calls"
      else if (value === 11) reason = "content_filter"
      else if (value === 1 || value === 3) reason = "length"
      yield { kind: "finish", reason }
      continue
    }
    if (field.wire !== 2 || !Buffer.isBuffer(field.value)) continue

    if (field.num === 3) {
      // delta_text — visible text content
      const text = field.value.toString("utf8")
      if (text) yield { kind: "text", text }
    } else if (field.num === 6) {
      // ToolCallDelta { #1 id, #2 name, #3 arguments_delta }
      let id: string | undefined
      let name: string | undefined
      let argsDelta: string | undefined
      for (const part of iterFields(field.value)) {
        if (part.wire !== 2 || !Buffer.isBuffer(part.value)) continue
        const text = part.value.toString("utf8")
        if (part.num === 1) id = text
        else if (part.num === 2) name = text
        else if (part.num === 3) argsDelta = text
      }
      if (id !== undefined && name !== undefined) yield { kind: "tool_call_start", id, name }
      if (argsDelta !== undefined) yield { kind: "tool_call_args", argsDelta, ...(id !== undefined ? { id } : {}) }
    } else if (field.num === 9) {
      // Internal thinking / chain-of-thought
      const text = field.value.toString("utf8")
      if (text) yield { kind: "reasoning", text }
    } else if (field.num === 28) {
      const usage = decodeUsageBlock(field.value)
      if (usage) yield usage
    }
  }
}

function decodeUsageBlock(buf: Buffer): Extract<DecodedEvent, { kind: "usage" }> | null {
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let cachedInputTokens: number | undefined
  let cacheCreationInputTokens: number | undefined
  let reasoningTokens: number | undefined

  for (const field of iterFields(buf)) {
    if (field.num !== 2 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue
    let metric: string | undefined
    let value: number | undefined
    for (const entry of iterFields(field.value)) {
      if (entry.num === 5 && entry.wire === 2 && Buffer.isBuffer(entry.value)) {
        metric = entry.value.toString("utf8")
      } else if (entry.num === 4 && entry.wire === 2 && Buffer.isBuffer(entry.value)) {
        for (const inner of iterFields(entry.value)) {
          if (inner.num === 2 && inner.wire === 5 && Buffer.isBuffer(inner.value)) {
            value = inner.value.readFloatLE(0)
            break
          }
        }
      }
    }
    if (metric && value !== undefined && Number.isFinite(value)) {
      const tokens = Math.round(value)
      if (metric === "input_tokens") promptTokens = tokens
      else if (metric === "output_tokens") completionTokens = tokens
      else if (metric === "cached_input_tokens" || metric === "cache_read_input_tokens")
        cachedInputTokens = (cachedInputTokens ?? 0) + tokens
      else if (metric === "cache_creation_input_tokens") cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + tokens
      else if (metric === "reasoning_tokens" || metric === "output_reasoning_tokens") reasoningTokens = tokens
    }
  }

  if (promptTokens === undefined && completionTokens === undefined) return null
  const total = (promptTokens ?? 0) + (completionTokens ?? 0)
  return {
    kind: "usage",
    promptTokens,
    completionTokens,
    totalTokens: total > 0 ? total : undefined,
    cachedInputTokens,
    cacheCreationInputTokens,
    reasoningTokens,
  }
}

const TRACE_ID_RE = /\(trace ID: ([0-9a-f]+)\)/i

/** Stream decoded chat events from the GetChatMessage Connect-RPC endpoint. */
export async function* streamChatEvents(request: StreamChatRequest): AsyncGenerator<ChatEvent> {
  const host = (request.apiServerUrl ?? DEFAULT_API_SERVER).replace(/\/$/, "")
  const userJwt = await getCachedUserJwt(request.apiKey, host, request.signal)
  const sessionIds = getOrAllocateSessionIds(request.apiKey, host, request.cascadeId)
  const proto = buildGetChatMessageRequest({
    apiKey: request.apiKey,
    userJwt,
    modelUid: request.modelUid,
    messages: request.messages,
    tools: request.tools,
    cascadeId: sessionIds.cascadeId,
    promptId: crypto.randomUUID(),
    sessionId: sessionIds.sessionId,
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
    completionOpts: request.completionOpts,
  })
  const body = frameConnectStream(proto, true)
  const ttfbTimeout = AbortSignal.timeout(STREAM_TTFB_MS)
  const response = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      "Connect-Content-Encoding": "gzip",
      "Connect-Accept-Encoding": "gzip",
    },
    body: new Uint8Array(body),
    signal: request.signal ? AbortSignal.any([request.signal, ttfbTimeout]) : ttfbTimeout,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new CloudChatError(`GetChatMessage HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  if (!response.body) throw new CloudChatError("GetChatMessage response had no body stream")

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let queuedBytes = 0
  let trailerError: { code?: string; message: string; traceId?: string } | null = null
  let sawEos = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const cancelBody = (reason?: unknown) => {
    try {
      void response.body?.cancel(reason)
    } catch {
      // already cancelled
    }
  }

  const peek = (n: number): Buffer | null => {
    if (queuedBytes < n) return null
    if (chunks.length === 1 && chunks[0]!.length >= n) return chunks[0]!.slice(0, n)
    const parts: Buffer[] = []
    let remaining = n
    for (const chunk of chunks) {
      if (remaining <= 0) break
      if (chunk.length <= remaining) {
        parts.push(chunk)
        remaining -= chunk.length
      } else {
        parts.push(chunk.slice(0, remaining))
        remaining = 0
      }
    }
    return Buffer.concat(parts, n)
  }

  const drop = (n: number) => {
    queuedBytes -= n
    let remaining = n
    while (remaining > 0 && chunks.length > 0) {
      const head = chunks[0]!
      if (head.length <= remaining) {
        chunks.shift()
        remaining -= head.length
      } else {
        chunks[0] = head.slice(remaining)
        remaining = 0
      }
    }
  }

  try {
    if (request.signal?.aborted) throw request.signal.reason
    request.signal?.addEventListener("abort", () => cancelBody(request.signal?.reason), { once: true })

    while (true) {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => cancelBody(new Error(`idle timeout (${STREAM_IDLE_MS}ms)`)), STREAM_IDLE_MS)
      const { value, done } = await reader.read()
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      if (done) break
      if (value) {
        chunks.push(Buffer.from(value))
        queuedBytes += value.length
      }
      while (queuedBytes >= 5) {
        const header = peek(5)
        if (!header) break
        const flags = header[0]!
        const length = header.readUInt32BE(1)
        if (queuedBytes < 5 + length) break
        drop(5)
        const raw = peek(length) ?? Buffer.alloc(0)
        drop(length)
        let payload = raw
        if (flags & 0x01) {
          try {
            payload = zlib.gunzipSync(raw)
          } catch (cause) {
            throw new CloudChatError(`Connect frame gunzip failed: ${(cause as Error).message}`)
          }
        }
        if ((flags & 0x02) !== 0) {
          // End-of-stream trailer: JSON {error} on failure, empty on success.
          sawEos = true
          const text = payload.toString("utf8")
          if (text && text.includes('"error"')) {
            let code: string | undefined
            let message = text
            try {
              const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
              code = parsed.error?.code
              if (parsed.error?.message) message = parsed.error.message
            } catch {
              // non-JSON trailer — keep the raw text
            }
            const traceId = message.match(TRACE_ID_RE)?.[1]
            trailerError = { code, message, traceId }
          }
          continue
        }
        yield* decodeChatFrame(payload)
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    try {
      reader.releaseLock()
    } catch {
      // lock already released
    }
    cancelBody()
  }

  if (trailerError) {
    const isOpaque = trailerError.code === "permission_denied" && /an internal error occurred/i.test(trailerError.message)
    if (isOpaque) {
      throw new CloudChatError(
        `Cognition denied model access for "${request.modelUid}". Check your account tier. (trace: ${trailerError.traceId ?? "n/a"})`,
        trailerError.code,
        trailerError.traceId,
      )
    }
    throw new CloudChatError(trailerError.message, trailerError.code, trailerError.traceId)
  }
  if (!sawEos) {
    throw new CloudChatError("Cloud stream ended without EOS trailer. Connection likely dropped.", "truncated_stream")
  }
}
