/**
 * GetChatMessage streaming via Codeium Connect-RPC.
 * Ported from pi-devin-auth (MIT), adapted for AI SDK LanguageModelV2.
 */
import * as crypto from "crypto";
import * as zlib from "zlib";
import { encodeMessage, encodeString, encodeVarintField, frameConnectStream, iterFields, } from "./wire.js";
import { buildMetadata } from "./metadata.js";
import { getCachedUserJwt } from "./auth.js";
const DEFAULT_HOST = "https://server.codeium.com";
const CLOUD_STREAM_IDLE_MS = 120_000;
const CLOUD_STREAM_TTFB_MS = 60_000;
const MAX_TOOL_DESC_LEN = 6998;
export class CloudChatError extends Error {
    code;
    traceId;
    constructor(message, code, traceId) {
        super(message);
        this.code = code;
        this.traceId = traceId;
        this.name = "CloudChatError";
    }
}
// --- Encoding helpers ---
const SOURCE_BY_ROLE = {
    user: 1,
    assistant: 2,
    system: 1, // Cognition rejects source=3; inline into user turn
    tool: 4,
};
function encodeImageData(img) {
    const parts = [encodeString(1, img.base64Data), encodeString(2, img.mimeType)];
    if (img.caption)
        parts.push(encodeString(3, img.caption));
    return Buffer.concat(parts);
}
function encodeChatToolCall(tc) {
    return Buffer.concat([encodeString(1, tc.id), encodeString(2, tc.name), encodeString(3, tc.arguments)]);
}
function encodeChatMessagePrompt(content, source, opts) {
    const textParts = content.filter((p) => p.type === "text");
    const imageParts = content.filter((p) => p.type === "image");
    const joined = textParts.map((p) => p.text).join("\n");
    const parts = [
        encodeVarintField(2, source),
        encodeString(3, joined),
        encodeVarintField(4, Math.max(1, Math.floor(joined.length / 4))),
        encodeVarintField(5, 1),
    ];
    if (opts?.toolCallId)
        parts.push(encodeString(7, opts.toolCallId));
    if (opts?.toolCalls) {
        for (const tc of opts.toolCalls)
            parts.push(encodeMessage(6, encodeChatToolCall(tc)));
    }
    for (const img of imageParts)
        parts.push(encodeMessage(10, encodeImageData(img)));
    return Buffer.concat(parts);
}
function collapseSystemIntoUser(messages) {
    // Fast path: if no system messages, skip entirely.
    if (!messages.some((m) => m.role === "system"))
        return messages;
    const out = [];
    let pendingSystem = [];
    const flushText = (content) => {
        if (typeof content === "string")
            return content;
        return content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    };
    for (const m of messages) {
        if (m.role === "system") {
            const text = flushText(normalizeContent(m.content));
            if (text)
                pendingSystem.push(text);
        }
        else if (m.role === "user" && pendingSystem.length > 0) {
            const userParts = normalizeContent(m.content);
            const userText = flushText(userParts);
            const userImages = userParts.filter((p) => p.type === "image");
            const wrapped = `<system>\n${pendingSystem.join("\n\n")}\n</system>\n${userText}`;
            out.push({ role: "user", content: [{ type: "text", text: wrapped }, ...userImages] });
            pendingSystem = [];
        }
        else {
            out.push(m);
        }
    }
    if (pendingSystem.length > 0) {
        out.push({ role: "user", content: [{ type: "text", text: `<system>\n${pendingSystem.join("\n\n")}\n</system>` }] });
    }
    return out;
}
function normalizeContent(content) {
    if (typeof content === "string")
        return [{ type: "text", text: content }];
    if (!Array.isArray(content))
        return [];
    const out = [];
    const parts = content;
    for (const p of parts) {
        if (!p || typeof p !== "object")
            continue;
        if (p.type === "text" && typeof p.text === "string") {
            out.push({ type: "text", text: p.text });
        }
        else if (p.type === "image" && typeof p.base64Data === "string") {
            out.push({ type: "image", mimeType: p.mimeType ?? "image/png", base64Data: p.base64Data, caption: p.caption });
        }
        else if (p.type === "image_url" && p.image_url) {
            const imgRef = p.image_url;
            const url = typeof imgRef === "string" ? imgRef : (imgRef.url ?? "");
            const m = url.match(/^data:([^;]+);base64,(.+)$/);
            if (m)
                out.push({ type: "image", mimeType: m[1], base64Data: m[2] });
        }
    }
    return out;
}
function encodeToolDef(tool) {
    const rawDesc = tool.description ?? "";
    const desc = rawDesc.length > MAX_TOOL_DESC_LEN
        ? rawDesc.slice(0, MAX_TOOL_DESC_LEN - 24) + "\n…(truncated for cloud)"
        : rawDesc;
    return Buffer.concat([
        encodeString(1, tool.name),
        encodeString(2, desc),
        encodeString(3, JSON.stringify(tool.parameters ?? {})),
    ]);
}
function encodeCompletionConfiguration(opts) {
    const enc64 = (fieldNum, n) => {
        const b = Buffer.alloc(8);
        b.writeDoubleLE(n, 0);
        return Buffer.concat([Buffer.from([(fieldNum << 3) | 1]), b]);
    };
    return Buffer.concat([
        encodeVarintField(1, 1),
        encodeVarintField(2, opts.maxInputTokens ?? 64000),
        encodeVarintField(3, opts.maxOutputTokens ?? 128_000),
        enc64(5, opts.temperature ?? 0.7),
        enc64(6, opts.topP ?? 0.95),
        encodeVarintField(7, opts.topK ?? 50),
        enc64(8, 1.0),
        enc64(11, 1.0),
    ]);
}
const sessionCache = new Map();
function allocateCascadeId() { return crypto.randomUUID(); }
function getOrAllocateSessionIds(apiKey, host, cascadeIdOverride) {
    const key = `${host}\x1f${apiKey}`;
    let ids = sessionCache.get(key);
    if (!ids) {
        ids = { sessionId: crypto.randomUUID(), cascadeId: cascadeIdOverride ?? allocateCascadeId() };
        sessionCache.set(key, ids);
    }
    else if (cascadeIdOverride && ids.cascadeId !== cascadeIdOverride) {
        ids = { sessionId: ids.sessionId, cascadeId: cascadeIdOverride };
        sessionCache.set(key, ids);
    }
    return ids;
}
function buildGetChatMessageRequest(args) {
    const metadata = buildMetadata({
        apiKey: args.apiKey,
        userJwt: args.userJwt,
        sessionId: args.sessionId,
        requestId: args.requestId,
        triggerId: args.triggerId,
    });
    const collapsed = collapseSystemIntoUser(args.messages);
    const promptParts = collapsed.map((m) => encodeMessage(3, encodeChatMessagePrompt(normalizeContent(m.content), SOURCE_BY_ROLE[m.role] ?? 1, { toolCallId: m.tool_call_id, toolCalls: m.tool_calls })));
    // Field layout from mitm capture of the Windsurf language_server:
    //   #1  metadata (message)
    //   #3  chat_message_prompts (repeated — one element per history turn)
    //   #7  request_type (varint enum, 5 = CASCADE)
    //   #8  completion_configuration (message)
    //   #10 tools (repeated ChatToolDefinition)
    //   #16 cascade_id (string)
    //   #21 chat_model_uid (string)
    //   #22 prompt_id (string)
    const toolParts = (args.tools ?? []).map((t) => encodeMessage(10, encodeToolDef(t)));
    // Pre-allocate the concat array (avoid spread + intermediate array)
    const parts = [
        encodeMessage(1, metadata),
        ...promptParts,
        encodeVarintField(7, 5),
        encodeMessage(8, encodeCompletionConfiguration(args.completionOpts ?? {})),
        ...toolParts,
        encodeString(16, args.cascadeId),
        encodeString(21, args.modelUid),
        encodeString(22, args.promptId),
    ];
    return Buffer.concat(parts);
}
// --- Response decoder ---
function* decodeChatFrame(buf) {
    for (const f of iterFields(buf)) {
        const wire = f.wire;
        const value = f.value;
        if (f.num === 5 && wire === 0) {
            // Finish reason (varint) — StopReason enum
            // 0 UNSPECIFIED → stop, 1 INCOMPLETE → length, 2 STOP_PATTERN → stop,
            // 3 MAX_TOKENS → length, 10 FUNCTION_CALL → tool_calls,
            // 11 CONTENT_FILTER → content_filter
            const v = Number(value);
            let reason = "stop";
            if (v === 10)
                reason = "tool_calls";
            else if (v === 11)
                reason = "content_filter";
            else if (v === 1 || v === 3)
                reason = "length";
            yield { kind: "finish", reason };
            continue;
        }
        if (wire !== 2 || !Buffer.isBuffer(value))
            continue;
        if (f.num === 3) {
            // delta_text — visible text content
            const s = value.toString("utf8");
            if (s)
                yield { kind: "text", text: s };
        }
        else if (f.num === 6) {
            // ToolCallDelta { #1 id, #2 name, #3 arguments_delta }
            let id;
            let name;
            let argsDelta;
            for (const sf of iterFields(value)) {
                if (sf.wire === 2 && Buffer.isBuffer(sf.value)) {
                    const s = sf.value.toString("utf8");
                    if (sf.num === 1)
                        id = s;
                    else if (sf.num === 2)
                        name = s;
                    else if (sf.num === 3)
                        argsDelta = s;
                }
            }
            if (id !== undefined && name !== undefined) {
                yield { kind: "tool_call_start", id, name };
            }
            if (argsDelta !== undefined) {
                yield { kind: "tool_call_args", argsDelta, ...(id !== undefined ? { id } : {}) };
            }
        }
        else if (f.num === 9) {
            // Internal thinking / chain-of-thought
            const s = value.toString("utf8");
            if (s)
                yield { kind: "reasoning", text: s };
        }
        else if (f.num === 28) {
            const usage = decodeUsageBlock(value);
            if (usage)
                yield usage;
        }
    }
}
function decodeUsageBlock(buf) {
    let promptTokens;
    let completionTokens;
    let cachedInputTokens;
    let cacheCreationInputTokens;
    let reasoningTokens;
    for (const f of iterFields(buf)) {
        if (f.num !== 2 || f.wire !== 2 || !Buffer.isBuffer(f.value))
            continue;
        let entryMetric;
        let entryValue;
        for (const sf of iterFields(f.value)) {
            if (sf.num === 5 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
                entryMetric = sf.value.toString("utf8");
            }
            else if (sf.num === 4 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
                for (const ssf of iterFields(sf.value)) {
                    if (ssf.num === 2 && ssf.wire === 5 && Buffer.isBuffer(ssf.value)) {
                        entryValue = ssf.value.readFloatLE(0);
                        break;
                    }
                }
            }
        }
        if (entryMetric && entryValue !== undefined && Number.isFinite(entryValue)) {
            const n = Math.round(entryValue);
            if (entryMetric === "input_tokens")
                promptTokens = n;
            else if (entryMetric === "output_tokens")
                completionTokens = n;
            else if (entryMetric === "cached_input_tokens" || entryMetric === "cache_read_input_tokens")
                cachedInputTokens = (cachedInputTokens ?? 0) + n;
            else if (entryMetric === "cache_creation_input_tokens")
                cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + n;
            else if (entryMetric === "reasoning_tokens" || entryMetric === "output_reasoning_tokens")
                reasoningTokens = (reasoningTokens ?? 0) + n;
        }
    }
    if (promptTokens === undefined && completionTokens === undefined)
        return null;
    const total = (promptTokens ?? 0) + (completionTokens ?? 0);
    return {
        kind: "usage",
        promptTokens,
        completionTokens,
        totalTokens: total > 0 ? total : undefined,
        cachedInputTokens,
        cacheCreationInputTokens,
        reasoningTokens,
    };
}
function anySignal(signals) {
    const builtin = AbortSignal.any;
    if (typeof builtin === "function")
        return builtin(signals);
    const controller = new AbortController();
    for (const s of signals) {
        if (s.aborted) {
            controller.abort(s.reason);
            break;
        }
        s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
    }
    return controller.signal;
}
const TRACE_ID_RE = /\(trace ID: ([0-9a-f]+)\)/i;
export async function* streamChatEvents(req) {
    const host = (req.apiServerUrl ?? DEFAULT_HOST).replace(/\/$/, "");
    const userJwt = await getCachedUserJwt(req.apiKey, host, req.signal);
    const sessionIds = getOrAllocateSessionIds(req.apiKey, host, req.cascadeId);
    const proto = buildGetChatMessageRequest({
        apiKey: req.apiKey,
        userJwt,
        modelUid: req.modelUid,
        messages: req.messages,
        tools: req.tools,
        cascadeId: sessionIds.cascadeId,
        promptId: crypto.randomUUID(),
        sessionId: sessionIds.sessionId,
        requestId: BigInt(Date.now()),
        triggerId: crypto.randomUUID(),
        completionOpts: req.completionOpts,
    });
    const body = frameConnectStream(proto, true);
    const ttfbController = new AbortController();
    const ttfbTimer = setTimeout(() => ttfbController.abort(new Error(`TTFB timeout (${CLOUD_STREAM_TTFB_MS}ms)`)), CLOUD_STREAM_TTFB_MS);
    const initialSignal = req.signal ? anySignal([req.signal, ttfbController.signal]) : ttfbController.signal;
    let resp;
    try {
        resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
            method: "POST",
            headers: {
                "Content-Type": "application/connect+proto",
                "Connect-Protocol-Version": "1",
                "Connect-Content-Encoding": "gzip",
                "Connect-Accept-Encoding": "gzip",
            },
            body,
            signal: initialSignal,
        });
    }
    finally {
        clearTimeout(ttfbTimer);
    }
    if (!resp.ok) {
        const text = await resp.text();
        throw new CloudChatError(`GetChatMessage HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    if (!resp.body)
        throw new CloudChatError("GetChatMessage response had no body stream");
    const chunkQueue = [];
    let queuedBytes = 0;
    const reader = resp.body.getReader();
    let trailerError = null;
    let sawEos = false;
    function peek(n) {
        if (queuedBytes < n)
            return null;
        if (chunkQueue.length === 1 && chunkQueue[0].length >= n)
            return chunkQueue[0].slice(0, n);
        const parts = [];
        let remaining = n;
        for (const c of chunkQueue) {
            if (remaining <= 0)
                break;
            if (c.length <= remaining) {
                parts.push(c);
                remaining -= c.length;
            }
            else {
                parts.push(c.slice(0, remaining));
                remaining = 0;
            }
        }
        return Buffer.concat(parts, n);
    }
    function drop(n) {
        queuedBytes -= n;
        let remaining = n;
        while (remaining > 0 && chunkQueue.length > 0) {
            const head = chunkQueue[0];
            if (head.length <= remaining) {
                chunkQueue.shift();
                remaining -= head.length;
            }
            else {
                chunkQueue[0] = head.slice(remaining);
                remaining = 0;
            }
        }
    }
    let idleTimer = null;
    try {
        // Set up external abort handling once (instead of per-read AbortControllers)
        const onAbort = (reason) => {
            try {
                void resp.body?.cancel(reason);
            }
            catch { }
        };
        if (req.signal?.aborted)
            throw req.signal.reason;
        req.signal?.addEventListener("abort", () => onAbort(req.signal?.reason), { once: true });
        while (true) {
            // Reset idle timer per read, but reuse a single timer (no per-read AbortController/Promise)
            if (idleTimer)
                clearTimeout(idleTimer);
            idleTimer = setTimeout(() => onAbort(new Error(`idle timeout (${CLOUD_STREAM_IDLE_MS}ms)`)), CLOUD_STREAM_IDLE_MS);
            const { value, done } = await reader.read();
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
            if (done)
                break;
            if (value) {
                chunkQueue.push(Buffer.from(value));
                queuedBytes += value.length;
            }
            while (queuedBytes >= 5) {
                const header = peek(5);
                if (!header)
                    break;
                const flags = header[0];
                const len = header.readUInt32BE(1);
                if (queuedBytes < 5 + len)
                    break;
                drop(5);
                const raw = peek(len) ?? Buffer.alloc(0);
                drop(len);
                let payload = raw;
                if (flags & 0x01) {
                    try {
                        payload = zlib.gunzipSync(raw);
                    }
                    catch (e) {
                        throw new CloudChatError(`Connect frame gunzip failed: ${e.message}`);
                    }
                }
                const eos = (flags & 0x02) !== 0;
                if (eos) {
                    sawEos = true;
                    const text = payload.toString("utf8");
                    if (text && text.includes('"error"')) {
                        let code;
                        let message = text;
                        try {
                            const j = JSON.parse(text);
                            code = j.error?.code;
                            if (j.error?.message)
                                message = j.error.message;
                        }
                        catch { }
                        const traceMatch = message.match(TRACE_ID_RE);
                        trailerError = { code, message, traceId: traceMatch?.[1] };
                    }
                    continue;
                }
                yield* decodeChatFrame(payload);
            }
        }
    }
    finally {
        if (idleTimer)
            clearTimeout(idleTimer);
        try {
            reader.releaseLock();
        }
        catch { }
        try {
            void resp.body?.cancel();
        }
        catch { }
    }
    if (trailerError) {
        const isOpaque = trailerError.code === "permission_denied" && /an internal error occurred/i.test(trailerError.message);
        if (isOpaque) {
            throw new CloudChatError(`Cognition denied model access for "${req.modelUid}". Check your account tier. (trace: ${trailerError.traceId ?? "n/a"})`, trailerError.code, trailerError.traceId);
        }
        throw new CloudChatError(trailerError.message, trailerError.code, trailerError.traceId);
    }
    if (!sawEos) {
        throw new CloudChatError("Cloud stream ended without EOS trailer. Connection likely dropped.", "truncated_stream");
    }
}
