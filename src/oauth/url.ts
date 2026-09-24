/**
 * Windsurf sign-in URL builders (implicit grant, reverse-engineered from the
 * Windsurf desktop extension).
 *
 * Two redirect strategies:
 *
 *   - Loopback (`http://127.0.0.1:<port>/auth`, `redirect_parameters_type=query`):
 *     the SPA hands the token to our local server. Requires the user to
 *     complete an authentication event, so it suits fresh logins.
 *   - `show-auth-token`: the SPA renders the raw token in a `<code>` block for
 *     manual copy. Works with an existing browser session — the reliable path
 *     for users who are already logged in.
 *
 * `redirect_parameters_type=query` is REQUIRED for both: with `fragment` the
 * token lands in the URL hash, which browsers never send to a server.
 */

import { AUTH0_CLIENT_ID, SIGNIN_URL } from "../constants.ts"

function signinUrl(redirectUri: string, state: string): string {
  const url = new URL(SIGNIN_URL)
  url.searchParams.set("response_type", "token")
  url.searchParams.set("client_id", AUTH0_CLIENT_ID)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("state", crypto.randomUUID())
  url.searchParams.set("redirect_parameters_type", "query")
  return url.toString()
}

/** Loopback sign-in URL for the automated browser flow, with its CSRF state. */
export function buildLoginUrl(callbackUrl: string): { url: string; state: string } {
  const state = crypto.randomUUID()
  return { url: signinUrl(callbackUrl, state), state }
}

/** Manual-paste sign-in URL: the token renders on the page for the user to copy. */
export function buildTokenUrl(): string {
  return signinUrl("show-auth-token", crypto.randomUUID())
}
