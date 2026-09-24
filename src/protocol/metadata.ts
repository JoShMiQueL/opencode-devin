/**
 * `Metadata` proto builder sent with every Codeium/Cognition RPC.
 *
 * Field layout reverse-engineered from the Windsurf language_server; originally
 * ported from pi-devin-auth (MIT, Copyright (c) 2026 nmzpy).
 */

import { encodeMessage, encodeString, encodeTimestampBody, encodeVarintField } from "./wire.ts"

const VERSION_STRING = "2.0.0"

function osName(): string {
  switch (process.platform) {
    case "darwin":
      return "darwin"
    case "linux":
      return "linux"
    case "win32":
      return "windows"
    default:
      return process.platform
  }
}

export interface MetadataInput {
  apiKey: string
  sessionId: string
  requestId: bigint
  triggerId: string
  /** Short-lived JWT from GetUserJwt, required for catalog and chat RPCs. */
  userJwt?: string
  osName?: string
  version?: string
}

export function buildMetadata(input: MetadataInput): Buffer {
  const version = input.version ?? VERSION_STRING
  const os = input.osName ?? osName()
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
  ]
  if (input.userJwt) parts.push(encodeString(21, input.userJwt))
  return Buffer.concat(parts)
}
