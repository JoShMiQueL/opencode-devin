/**
 * Metadata proto builder for Codeium/Cognition gRPC calls.
 * Ported from pi-devin-auth (MIT).
 */
export interface MetadataInput {
    apiKey: string;
    userJwt?: string;
    sessionId: string;
    requestId: bigint;
    triggerId: string;
    windsurfVersion?: string;
    osName?: string;
}
export declare function buildMetadata(input: MetadataInput): Buffer;
