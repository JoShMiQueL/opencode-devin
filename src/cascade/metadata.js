/**
 * Metadata proto builder for Codeium/Cognition gRPC calls.
 * Ported from pi-devin-auth (MIT).
 */
import { encodeMessage, encodeString, encodeTimestampBody, encodeVarintField, } from "./wire.js";
const WINDSURF_VERSION_STRING = "2.0.0";
function osString() {
    switch (process.platform) {
        case "darwin": return "darwin";
        case "linux": return "linux";
        case "win32": return "windows";
        default: return String(process.platform);
    }
}
export function buildMetadata(input) {
    const version = input.windsurfVersion ?? WINDSURF_VERSION_STRING;
    const os = input.osName ?? osString();
    const parts = [
        encodeString(1, "windsurf"),
        encodeString(2, version),
        encodeString(3, input.apiKey),
        encodeString(4, "en"),
        encodeString(5, os),
        encodeString(7, version),
        encodeVarintField(9, input.requestId),
        encodeString(10, input.sessionId),
        encodeString(12, "windsurf"),
        encodeMessage(16, encodeTimestampBody()),
        encodeString(25, input.triggerId),
        encodeString(26, "Unset"),
        encodeString(28, "windsurf"),
    ];
    if (input.userJwt)
        parts.push(encodeString(21, input.userJwt));
    return Buffer.concat(parts);
}
