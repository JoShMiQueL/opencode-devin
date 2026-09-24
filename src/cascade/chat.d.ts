/**
 * GetChatMessage streaming via Codeium Connect-RPC.
 * Ported from pi-devin-auth (MIT), adapted for AI SDK LanguageModelV2.
 */
export type ContentPart = {
    type: "text";
    text: string;
} | {
    type: "image";
    mimeType: string;
    base64Data: string;
    caption?: string;
};
export interface ChatHistoryItem {
    role: "user" | "assistant" | "system" | "tool";
    content: string | ContentPart[];
    tool_call_id?: string;
    tool_calls?: Array<{
        id: string;
        name: string;
        arguments: string;
    }>;
}
export interface ToolDef {
    name: string;
    description: string;
    parameters: unknown;
}
export type CloudChatEvent = {
    kind: "text";
    text: string;
} | {
    kind: "reasoning";
    text: string;
} | {
    kind: "tool_call_start";
    id: string;
    name: string;
} | {
    kind: "tool_call_args";
    argsDelta: string;
    id?: string;
} | {
    kind: "finish";
    reason: "stop" | "tool_calls" | "length" | "content_filter";
} | {
    kind: "usage";
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
};
export declare class CloudChatError extends Error {
    readonly code?: string | undefined;
    readonly traceId?: string | undefined;
    constructor(message: string, code?: string | undefined, traceId?: string | undefined);
}
interface BuildArgs {
    apiKey: string;
    userJwt: string;
    modelUid: string;
    messages: ChatHistoryItem[];
    cascadeId: string;
    promptId: string;
    sessionId: string;
    requestId: bigint;
    triggerId: string;
    tools?: ToolDef[];
    completionOpts?: {
        maxOutputTokens?: number;
        maxInputTokens?: number;
        temperature?: number;
        topK?: number;
        topP?: number;
    };
}
export interface CloudChatRequest {
    apiKey: string;
    apiServerUrl?: string;
    modelUid: string;
    messages: ChatHistoryItem[];
    tools?: ToolDef[];
    cascadeId?: string;
    completionOpts?: BuildArgs["completionOpts"];
    signal?: AbortSignal;
}
export declare function streamChatEvents(req: CloudChatRequest): AsyncGenerator<CloudChatEvent>;
export {};
