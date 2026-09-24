/**
 * Devin CLI login URL (`{webapp}/auth/cli/continue`).
 *
 * With `redirect_uri` the webapp redirects the browser back to our loopback
 * server; without it, the webapp shows the user a code to paste instead.
 */

import { WEBAPP_URL } from "../constants.ts"

export interface AuthorizeInput {
  state: string
  challenge: string
  redirectUri?: string
}

export function authorizeUrl(input: AuthorizeInput): string {
  const url = new URL("/auth/cli/continue", WEBAPP_URL)
  if (input.redirectUri) url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("state", input.state)
  url.searchParams.set("prompt", "select_account")
  url.searchParams.set("code_challenge", input.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.toString()
}
