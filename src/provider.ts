/**
 * Provider package entrypoint for OpenCode v2.
 *
 * With the `aisdk:` package prefix, opencode's dynamic provider loader imports
 * this module, calls the first `create*` export with the provider settings,
 * and uses `sdk.languageModel(modelID)` as the AI SDK `LanguageModelV3`.
 *
 * `ai-sdk-devin` implements the Codeium gRPC wire protocol (GetUserJwt
 * handshake + GetChatMessage streaming). This wrapper adapts its stream to the
 * `@ai-sdk/provider` v3 shape opencode expects — notably `finishReason`, which
 * moved from a plain string to `{ unified, raw? }`.
 */

import { createDevin } from "ai-sdk-devin"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"

export interface DevinProviderSettings {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly name?: string
}

const FINISH_REASONS = new Set(["stop", "length", "tool-calls", "content-filter", "error", "other", "unknown"])

function normalizeFinishReason(value: unknown): unknown {
  if (typeof value !== "string") return value
  return { unified: FINISH_REASONS.has(value) ? value : "unknown", raw: value }
}

function adaptStreamPart(part: LanguageModelV3StreamPart): LanguageModelV3StreamPart {
  const finish = part as { type?: string; finishReason?: unknown }
  if (finish.type === "finish" && typeof finish.finishReason === "string") {
    return { ...part, finishReason: normalizeFinishReason(finish.finishReason) } as LanguageModelV3StreamPart
  }
  return part
}

export function createDevinProvider(options: DevinProviderSettings) {
  const provider = createDevin({
    apiKey: options.apiKey ?? "",
    baseURL: options.baseURL,
  })

  const wrap = (model: LanguageModelV3): LanguageModelV3 => ({
    ...model,
    doStream: async (input) => {
      const result = await model.doStream.call(model, input)
      const reader = result.stream.getReader()
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            return
          }
          controller.enqueue(adaptStreamPart(value))
        },
        cancel: (reason) => reader.cancel(reason),
      })
      return { ...result, stream }
    },
  })

  return {
    languageModel: (modelID: string) => wrap(provider.languageModel(modelID)),
  }
}
