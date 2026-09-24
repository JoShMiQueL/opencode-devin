/**
 * Token exchange: `POST {authApi}/auth/cli/token {code, code_verifier}`.
 *
 * Returns the token in the `devin-session-token$<jwt>` form opencode stores
 * and sends as the bearer credential. Never echoes the code or token.
 */

import { AUTH_API_URL, TOKEN_PREFIX } from "../constants.ts"

export class DevinAuthError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "DevinAuthError"
    this.status = status
  }
}

/** Exchange a PKCE authorization code for the long-lived session token. */
export async function exchangeCode(input: { code: string; verifier: string }): Promise<string> {
  const response = await fetch(`${AUTH_API_URL}/auth/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code: input.code, code_verifier: input.verifier }),
    signal: AbortSignal.timeout(30_000),
  }).catch((cause: unknown) => {
    throw new DevinAuthError(`Token exchange request to ${AUTH_API_URL} failed: ${String(cause)}`, 0)
  })

  const text = await response.text()
  if (!response.ok) {
    let message = text || `Token exchange failed with HTTP ${response.status}`
    try {
      const err = JSON.parse(text) as { message?: string }
      if (err.message) message = err.message
    } catch {
      // non-JSON body — keep the raw text
    }
    throw new DevinAuthError(message, response.status)
  }

  const token = (JSON.parse(text) as { token?: string }).token
  if (!token) throw new DevinAuthError("Token exchange succeeded but the response had no token", response.status)
  return `${TOKEN_PREFIX}${token}`
}
