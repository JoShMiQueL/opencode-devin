/**
 * GetUserJwt — mint short-lived user_jwt for chat RPCs.
 * Ported from pi-devin-auth (MIT).
 */
export interface MintedUserJwt {
    jwt: string;
    expiresAt: number;
}
export declare class CloudAuthError extends Error {
    readonly status?: number | undefined;
    constructor(message: string, status?: number | undefined);
}
export declare function mintUserJwt(apiKey: string, host?: string, signal?: AbortSignal): Promise<MintedUserJwt>;
export declare function getCachedUserJwt(apiKey: string, host?: string, signal?: AbortSignal): Promise<string>;
export declare function clearCachedUserJwt(): void;
