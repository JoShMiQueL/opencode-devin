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
}

export function createDevinProvider(options: DevinProviderSettings) {
  const provider = createDevin({
    apiKey: options.apiKey ?? "",
    baseURL: options.baseURL,
  })
  return {
    languageModel: (modelID: string) => provider.languageModel(modelID),
  }
}
