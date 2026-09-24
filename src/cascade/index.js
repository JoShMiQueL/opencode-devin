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
import * as crypto from "crypto";
import { streamChatEvents, } from "./chat.js";
import { getCachedCatalog } from "./catalog.js";
export { CloudChatError } from "./chat.js";
export { ModelNotAvailableError, getCachedCatalog, clearCachedCatalog, } from "./catalog.js";
const DEFAULT_HOST = "https://server.codeium.com";
/** Valid reasoning effort levels (encoded as UID suffixes in the catalog). */
const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"];
/**
 * Resolve the actual model UID to send to the gRPC server, applying an optional
 * reasoning effort override from providerOptions.
 *
 * If the caller passes `providerOptions.devin.reasoningEffort` (e.g. "high"),
 * and the current model UID has an effort suffix, the suffix is swapped.
 * If the model has no effort suffix but the base model has effort variants in
 * the catalog, the suffix is appended.
 */
function resolveEffortUid(modelId, catalog, requestedEffort) {
    if (!requestedEffort)
        return modelId;
    const effort = requestedEffort.toLowerCase();
    if (!EFFORT_LEVELS.includes(effort))
        return modelId;
    // Check if model UID already has an effort suffix
    const effortMatch = modelId.match(/-(none|low|medium|high|xhigh|max)$/);
    if (effortMatch) {
        return modelId.slice(0, -effortMatch[1].length - 1) + "-" + effort;
    }
    // No existing suffix — check if the base model has effort variants in the catalog
    if (catalog) {
        const hasVariant = catalog.some((m) => m.baseModelUid === modelId && m.effortLevel === effort);
        if (hasVariant)
            return modelId + "-" + effort;
    }
    return modelId;
}
/**
 * Calculate the dollar cost of a request based on token usage and model pricing.
 */
export function calculateCost(usage, pricing) {
    if (!pricing)
        return undefined;
    const input = (usage.inputTokens ?? 0) / 1_000_000 * pricing.input;
    const cached = (usage.cachedInputTokens ?? 0) / 1_000_000 * pricing.cachedInput;
    const output = (usage.outputTokens ?? 0) / 1_000_000 * pricing.output;
    const total = input + cached + output;
    return total > 0 ? Math.round(total * 1_000_000) / 1_000_000 : 0;
}
// --- Prompt conversion: LanguageModelV3Prompt → ChatHistoryItem[] ---
function convertPrompt(prompt) {
    const items = [];
    for (const msg of prompt) {
        if (msg.role === "system") {
            items.push({ role: "system", content: msg.content });
        }
        else if (msg.role === "user") {
            const parts = [];
            for (const part of msg.content) {
                if (part.type === "text") {
                    parts.push({ type: "text", text: part.text });
                }
                else if (part.type === "file" && part.mediaType?.startsWith("image/")) {
                    const data = typeof part.data === "string" ? part.data : Buffer.from(part.data).toString("base64");
                    parts.push({ type: "image", mimeType: part.mediaType, base64Data: data });
                }
            }
            items.push({ role: "user", content: parts });
        }
        else if (msg.role === "assistant") {
            const parts = [];
            const toolCalls = [];
            for (const part of msg.content) {
                if (part.type === "text") {
                    parts.push({ type: "text", text: part.text });
                }
                else if (part.type === "tool-call") {
                    toolCalls.push({
                        id: part.toolCallId,
                        name: part.toolName,
                        arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
                    });
                }
            }
            items.push({ role: "assistant", content: parts, tool_calls: toolCalls.length > 0 ? toolCalls : undefined });
        }
        else if (msg.role === "tool") {
            for (const part of msg.content) {
                if (part.type === "tool-result") {
                    const output = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
                    items.push({ role: "tool", content: output, tool_call_id: part.toolCallId });
                }
            }
        }
    }
    return items;
}
function convertTools(tools) {
    if (!tools || tools.length === 0)
        return undefined;
    const out = [];
    for (const tool of tools) {
        if (tool.type === "function") {
            out.push({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema });
        }
    }
    return out.length > 0 ? out : undefined;
}
// --- Stream event conversion ---
// Text/reasoning coalescing thresholds — reduces stream events from
// hundreds of 5-byte micro-deltas to a few dozen batched chunks.
const COALESCE_INTERVAL_MS = 32;
const COALESCE_MAX_BYTES = 128;
async function* convertStreamEvents(events, generateId, pricing) {
    let textId = "";
    let reasoningId = "";
    let textOpen = false;
    let reasoningOpen = false;
    let currentToolId = "";
    let currentToolName = "";
    let toolInputOpen = false;
    let pendingToolArgs = "";
    let finishReason = "stop";
    let usage;
    // Coalescing buffers
    let textBuf = "";
    let textLastFlush = 0;
    let reasoningBuf = "";
    let reasoningLastFlush = 0;
    yield { type: "stream-start", warnings: [] };
    for await (const ev of events) {
        switch (ev.kind) {
            case "text":
                if (!textOpen) {
                    textId = generateId();
                    textOpen = true;
                    textLastFlush = Date.now();
                    yield { type: "text-start", id: textId };
                }
                textBuf += ev.text;
                if (textBuf.length >= COALESCE_MAX_BYTES || Date.now() - textLastFlush >= COALESCE_INTERVAL_MS) {
                    yield { type: "text-delta", id: textId, delta: textBuf };
                    textBuf = "";
                    textLastFlush = Date.now();
                }
                break;
            case "reasoning":
                if (!reasoningOpen) {
                    reasoningId = generateId();
                    reasoningOpen = true;
                    reasoningLastFlush = Date.now();
                    yield { type: "reasoning-start", id: reasoningId };
                }
                reasoningBuf += ev.text;
                if (reasoningBuf.length >= COALESCE_MAX_BYTES || Date.now() - reasoningLastFlush >= COALESCE_INTERVAL_MS) {
                    yield { type: "reasoning-delta", id: reasoningId, delta: reasoningBuf };
                    reasoningBuf = "";
                    reasoningLastFlush = Date.now();
                }
                break;
            case "tool_call_start":
                if (textBuf) {
                    yield { type: "text-delta", id: textId, delta: textBuf };
                    textBuf = "";
                }
                if (reasoningBuf) {
                    yield { type: "reasoning-delta", id: reasoningId, delta: reasoningBuf };
                    reasoningBuf = "";
                }
                if (textOpen) {
                    yield { type: "text-end", id: textId };
                    textOpen = false;
                }
                if (reasoningOpen) {
                    yield { type: "reasoning-end", id: reasoningId };
                    reasoningOpen = false;
                }
                if (toolInputOpen) {
                    yield { type: "tool-call", toolCallId: currentToolId, toolName: currentToolName, input: pendingToolArgs };
                }
                currentToolId = ev.id || generateId();
                currentToolName = ev.name;
                toolInputOpen = true;
                pendingToolArgs = "";
                break;
            case "tool_call_args":
                pendingToolArgs += ev.argsDelta;
                break;
            case "finish":
                if (textBuf) {
                    yield { type: "text-delta", id: textId, delta: textBuf };
                    textBuf = "";
                }
                if (reasoningBuf) {
                    yield { type: "reasoning-delta", id: reasoningId, delta: reasoningBuf };
                    reasoningBuf = "";
                }
                if (textOpen) {
                    yield { type: "text-end", id: textId };
                    textOpen = false;
                }
                if (reasoningOpen) {
                    yield { type: "reasoning-end", id: reasoningId };
                    reasoningOpen = false;
                }
                if (toolInputOpen) {
                    yield { type: "tool-call", toolCallId: currentToolId, toolName: currentToolName, input: pendingToolArgs };
                    toolInputOpen = false;
                }
                finishReason = ev.reason;
                break;
            case "usage":
                usage = {
                    inputTokens: {
                        total: ev.promptTokens,
                        noCache: ev.promptTokens !== undefined && ev.cachedInputTokens !== undefined
                            ? ev.promptTokens - ev.cachedInputTokens : undefined,
                        cacheRead: ev.cachedInputTokens,
                        cacheWrite: ev.cacheCreationInputTokens,
                    },
                    outputTokens: {
                        total: ev.completionTokens,
                        text: ev.completionTokens !== undefined && ev.reasoningTokens !== undefined
                            ? ev.completionTokens - ev.reasoningTokens : undefined,
                        reasoning: ev.reasoningTokens,
                    },
                };
                break;
        }
    }
    // Final flush
    if (textBuf) {
        yield { type: "text-delta", id: textId, delta: textBuf };
    }
    if (reasoningBuf) {
        yield { type: "reasoning-delta", id: reasoningId, delta: reasoningBuf };
    }
    if (textOpen) {
        yield { type: "text-end", id: textId };
    }
    if (reasoningOpen) {
        yield { type: "reasoning-end", id: reasoningId };
    }
    if (toolInputOpen) {
        yield { type: "tool-call", toolCallId: currentToolId, toolName: currentToolName, input: pendingToolArgs };
    }
    const finishReasonMap = {
        stop: "stop", length: "length", tool_calls: "tool-calls", content_filter: "content-filter",
    };
    // Calculate cost from usage + pricing
    const inputTotal = usage?.inputTokens?.total;
    const cachedRead = usage?.inputTokens?.cacheRead;
    const outputTotal = usage?.outputTokens?.total;
    const cost = calculateCost({ inputTokens: inputTotal, cachedInputTokens: cachedRead, outputTokens: outputTotal }, pricing);
    yield {
        type: "finish",
        finishReason: finishReasonMap[finishReason] ?? "stop",
        usage: usage ?? { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
        ...(cost !== undefined ? { providerMetadata: { devin: { cost } } } : {}),
    };
}
// --- Collect for doGenerate ---
async function collectEvents(events) {
    const result = { text: "", reasoning: "", toolCalls: [], finishReason: "stop", usage: undefined };
    let currentTool = null;
    for await (const ev of events) {
        switch (ev.kind) {
            case "text":
                result.text += ev.text;
                break;
            case "reasoning":
                result.reasoning += ev.text;
                break;
            case "tool_call_start":
                if (currentTool)
                    result.toolCalls.push(currentTool);
                currentTool = { id: ev.id, name: ev.name, args: "" };
                break;
            case "tool_call_args":
                if (currentTool)
                    currentTool.args += ev.argsDelta;
                break;
            case "finish":
                if (currentTool) {
                    result.toolCalls.push(currentTool);
                    currentTool = null;
                }
                result.finishReason = ev.reason;
                break;
            case "usage":
                result.usage = {
                    inputTokens: { total: ev.promptTokens, noCache: undefined, cacheRead: ev.cachedInputTokens, cacheWrite: ev.cacheCreationInputTokens },
                    outputTokens: { total: ev.completionTokens, text: undefined, reasoning: ev.reasoningTokens },
                };
                break;
        }
    }
    if (currentTool)
        result.toolCalls.push(currentTool);
    return result;
}
function createDevinLanguageModel(opts) {
    return {
        specificationVersion: "v3",
        provider: "devin",
        modelId: opts.modelId,
        supportedUrls: {},
        async doGenerate(options) {
            // Apply reasoning effort override from providerOptions
            const effortOverride = options.providerOptions?.devin?.reasoningEffort;
            const resolvedModelId = resolveEffortUid(opts.modelId, opts.catalog, effortOverride);
            // Look up pricing for the resolved model (O(1) Map lookup)
            const modelEntry = opts.catalogMap?.get(resolvedModelId);
            const pricing = modelEntry?.pricing;
            const events = streamChatEvents({
                apiKey: opts.apiKey,
                apiServerUrl: opts.apiServerUrl,
                modelUid: resolvedModelId,
                messages: convertPrompt(options.prompt),
                tools: convertTools(options.tools),
                completionOpts: { maxOutputTokens: options.maxOutputTokens, temperature: options.temperature, topP: options.topP, topK: options.topK },
                signal: options.abortSignal,
            });
            const collected = await collectEvents(events);
            const content = [];
            if (collected.reasoning)
                content.push({ type: "reasoning", text: collected.reasoning });
            if (collected.text)
                content.push({ type: "text", text: collected.text });
            for (const tc of collected.toolCalls) {
                content.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, input: tc.args });
            }
            const finishReasonMap = {
                stop: "stop", length: "length", tool_calls: "tool-calls", content_filter: "content-filter",
            };
            // Calculate cost from usage + pricing
            const cost = calculateCost({
                inputTokens: collected.usage?.inputTokens?.total,
                cachedInputTokens: collected.usage?.inputTokens?.cacheRead,
                outputTokens: collected.usage?.outputTokens?.total,
            }, pricing);
            return {
                content,
                finishReason: finishReasonMap[collected.finishReason] ?? "stop",
                usage: collected.usage ?? { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
                warnings: [],
                ...(cost !== undefined ? { providerMetadata: { devin: { cost } } } : {}),
            };
        },
        async doStream(options) {
            // Apply reasoning effort override from providerOptions
            const effortOverride = options.providerOptions?.devin?.reasoningEffort;
            const resolvedModelId = resolveEffortUid(opts.modelId, opts.catalog, effortOverride);
            // Look up pricing for the resolved model (O(1) Map lookup)
            const modelEntry = opts.catalogMap?.get(resolvedModelId);
            const pricing = modelEntry?.pricing;
            const events = streamChatEvents({
                apiKey: opts.apiKey,
                apiServerUrl: opts.apiServerUrl,
                modelUid: resolvedModelId,
                messages: convertPrompt(options.prompt),
                tools: convertTools(options.tools),
                completionOpts: { maxOutputTokens: options.maxOutputTokens, temperature: options.temperature, topP: options.topP, topK: options.topK },
                signal: options.abortSignal,
            });
            const generateId = () => crypto.randomUUID();
            const gen = convertStreamEvents(events, generateId, pricing);
            const stream = new ReadableStream({
                async start(controller) {
                    try {
                        for await (const chunk of gen) {
                            controller.enqueue(chunk);
                        }
                        controller.close();
                    }
                    catch (err) {
                        controller.error(err);
                    }
                },
            });
            return { stream };
        },
    };
}
export function createDevin(options) {
    const apiKey = options.apiKey ?? "";
    let cachedCatalog;
    let catalogMap;
    return {
        languageModel(modelId) {
            return createDevinLanguageModel({ modelId, apiKey, apiServerUrl: options.baseURL, catalog: cachedCatalog, catalogMap });
        },
        async models() {
            if (!apiKey)
                return [];
            const catalog = await getCachedCatalog(apiKey, options.baseURL);
            if (!catalog)
                return [];
            const models = Array.from(catalog.byUid.values()).filter((m) => !m.disabled);
            cachedCatalog = models;
            catalogMap = new Map(models.map((m) => [m.modelUid, m]));
            return models;
        },
    };
}
