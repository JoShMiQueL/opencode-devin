/**
 * @ai-sdk/devin — AI SDK provider for Devin/Cognition LLM models.
 *
 * Implements the LanguageModelV3 interface to stream chat completions
 * from Cognition's Codeium gRPC server. Models are discovered dynamically
 * from the per-account catalog (GetCascadeModelConfigs) — 100+ models
 * including SWE-1.7, Claude Opus 4.8, GPT-5.6, GLM-5.2, Gemini, Grok, etc.
 * with reasoning effort levels (none/low/medium/high/xhigh/max), thinking
 * modes, fast/priority variants, and 1M context variants.
 *
 * Auth: pass the long-lived `devin-session-token$<JWT>` API key from
 * Windsurf OAuth as `apiKey`. A short-lived `user_jwt` is minted
 * automatically per session.
 */
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { type ModelCatalogEntry, type ModelPricing } from "./catalog.js";
export { CloudChatError } from "./chat.js";
export { ModelNotAvailableError, getCachedCatalog, clearCachedCatalog, type ModelCatalogEntry, type ModelPricing, type ModelCapability, } from "./catalog.js";
/**
 * Calculate the dollar cost of a request based on token usage and model pricing.
 */
export declare function calculateCost(usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
}, pricing?: ModelPricing): number | undefined;
export interface DevinProviderOptions {
    apiKey: string;
    baseURL?: string;
}
export interface DevinProvider {
    languageModel(modelId: string): LanguageModelV3;
    /** Fetch the live model catalog for this account. Returns all enabled models. */
    models(): Promise<ModelCatalogEntry[]>;
}
export declare function createDevin(options: DevinProviderOptions): DevinProvider;
