/**
 * GetCascadeModelConfigs — per-account model catalog from Cognition.
 * Ported from pi-devin-auth (MIT).
 */
export interface ModelPricing {
    /** Price per 1M input tokens (USD), or 0 if free. */
    input: number;
    /** Price per 1M cached input tokens (USD), or 0 if N/A. */
    cachedInput: number;
    /** Price per 1M output tokens (USD), or 0 if free. */
    output: number;
}
export interface ModelCapability {
    /** Feature name, e.g. "Effort", "Thinking", "Fast Mode", "1M Context". */
    name: string;
    /** Whether the feature is enabled for this model. */
    enabled: boolean;
    /** Optional value, e.g. "Medium" for Effort. */
    value?: string;
}
export interface ModelCatalogEntry {
    modelUid: string;
    label: string;
    disabled: boolean;
    contextWindow: number;
    /** Token pricing per 1M tokens (USD). */
    pricing?: ModelPricing;
    /** Capabilities/features advertised for this model. */
    capabilities?: ModelCapability[];
    /** Base model UID without the effort suffix (e.g. "claude-opus-4-8" for "claude-opus-4-8-medium"). */
    baseModelUid?: string;
    /** Reasoning effort level if encoded in the UID (none/low/medium/high/xhigh/max). */
    effortLevel?: string;
}
export interface CacheEntry {
    byUid: Map<string, ModelCatalogEntry>;
    fetchedAt: number;
    apiKey: string;
    host: string;
}
export declare function getCachedCatalog(apiKey: string, host?: string, signal?: AbortSignal): Promise<CacheEntry | null>;
export declare function clearCachedCatalog(): void;
export declare class ModelNotAvailableError extends Error {
    readonly modelUid: string;
    readonly label: string;
    readonly reason: "disabled" | "not_listed";
    constructor(modelUid: string, label: string, reason: "disabled" | "not_listed");
}
