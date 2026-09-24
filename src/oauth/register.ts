/**
 * Exchange a short-lived firebase_id_token for the long-lived Windsurf api_key.
 *
 * POST https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser
 * Body: { firebase_id_token }  (Connect-RPC accepts plain JSON)
 * Response: { api_key, name, api_server_url }
 *
 * The returned `api_key` (`devin-session-token$<JWT>`) is the credential used
 * by every chat RPC. `api_server_url` is tenant-scoped: empty means the
 * default `server.codeium.com`; EU/FedRAMP/enterprise tenants get their own
 * host, which must be used for inference.
 */

import { DEFAULT_API_SERVER, REGISTER_SERVER } from "../constants.ts"

export interface WindsurfCredentials {
  apiKey: string
  name: string
  apiServerUrl: string
}

export class WindsurfAuthError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "WindsurfAuthError"
    this.status = status
  }
}

interface RegisterUserResponse {
  api_key?: string
  name?: string
  api_server_url?: string
}

/** Exchange the short-lived firebase_id_token for the long-lived api_key. */
export async function registerUser(firebaseIdToken: string, signal?: AbortSignal): Promise<WindsurfCredentials> {
  const response = await fetch(`${REGISTER_SERVER}/exa.seat_management_pb.SeatManagementService/RegisterUser`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify({ firebase_id_token: firebaseIdToken.trim() }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  })

  const text = await response.text()
  if (!response.ok) {
    let message = text || `RegisterUser failed with HTTP ${response.status}`
    try {
      const err = JSON.parse(text) as { message?: string }
      if (err.message) message = err.message
    } catch {
      // non-JSON body — keep the raw text
    }
    throw new WindsurfAuthError(message, response.status)
  }

  const parsed = JSON.parse(text) as RegisterUserResponse
  if (!parsed.api_key || !parsed.name) {
    throw new WindsurfAuthError("RegisterUser returned a malformed response", response.status)
  }

  return {
    apiKey: parsed.api_key,
    name: parsed.name,
    apiServerUrl: parsed.api_server_url || DEFAULT_API_SERVER,
  }
}
