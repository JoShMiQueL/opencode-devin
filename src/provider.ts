/**
 * Provider package entrypoint for OpenCode v2.
 *
 * With the `aisdk:` package prefix, opencode's dynamic provider loader imports
 * this module, calls the first `create*` export with the provider settings,
 * and uses `sdk.languageModel(modelID)` as the AI SDK `LanguageModelV3`.
 *
 * The Cascade protocol implementation lives in `src/protocol/` — vendored,
 * audited, and owned in this repository (see `src/protocol/ATTRIBUTION.md`).
 */

import { createDevin } from "./protocol/model.ts"

export interface DevinProviderSettings {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly name?: string
  /**
   * "normal" (default) streams the model's answer through unchanged.
   * "uncensored" runs every request through the devin-engine guarded-retry
   * pipeline: an override system prompt, history sanitizing, and a refusal
   * guard that transparently resamples when the model starts a refusal.
   */
  readonly mode?: "normal" | "uncensored"
  /** Refusal-detection window in chars (devin-engine default: 700). */
  readonly guardChars?: number
  /** Guard the full response instead of only the head window. */
  readonly guardFull?: boolean
  /** Resample attempts after the first one (devin-engine default: 3). */
  readonly maxRetries?: number
  /** Override prompt file: a path, or "en" / "es" for the bundled variants. */
  readonly overrideFile?: string
  /** Keep the client system prompt ahead of the override. */
  readonly keepClientSystem?: boolean
}

export function createDevinProvider(options: DevinProviderSettings) {
  const provider = createDevin({
    apiKey: options.apiKey ?? "",
    baseURL: options.baseURL,
    mode: options.mode,
    guardChars: options.guardChars,
    guardFull: options.guardFull,
    maxRetries: options.maxRetries,
    overrideFile: options.overrideFile,
    keepClientSystem: options.keepClientSystem,
  })
  return {
    languageModel: (modelID: string) => provider.languageModel(modelID),
  }
}
