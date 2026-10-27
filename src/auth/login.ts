/**
 * Devin CLI login flow (PKCE), shared by the plugin's `/connect` methods and
 * the standalone `scripts/devin.ts login` command.
 *
 * Two modes, matching what the webapp supports:
 *   - "auto": loopback callback — browser redirects to 127.0.0.1, we capture
 *     the code. Hands-free once the user finishes the web login.
 *   - "code": no redirect_uri — the webapp shows a code the user pastes back.
 *     Fallback for headless machines and environments where loopback
 *     redirects can't reach the browser.
 */
import { authorizeUrl } from "./url.ts"
import { exchangeCode } from "./exchange.ts"
import { startCallbackServer, type CallbackServer } from "./loopback.ts"
import { challengeFor, generateState, generateVerifier } from "./pkce.ts"

export interface LoginFlow {
  /** URL to open in the browser. */
  url: string
  /** Resolve with the authorization code (auto: wait for redirect; code: pass the pasted code). */
  finish: (code?: string) => Promise<string>
  /** Abort the flow and release resources. */
  close: () => void
}

/** Start an automatic login: binds the loopback server and returns the URL to open. */
export async function loginAuto(): Promise<LoginFlow & { server: CallbackServer }> {
  const verifier = generateVerifier()
  const state = generateState()
  const server = await startCallbackServer(state)
  const url = authorizeUrl({ state, challenge: await challengeFor(verifier), redirectUri: server.redirectUri })
  return {
    url,
    server,
    finish: async () => {
      try {
        const code = await server.code
        return await exchangeCode({ code, verifier })
      } finally {
        server.close()
      }
    },
    close: () => server.close(),
  }
}

/** Start a manual login: no loopback; the webapp displays the code for pasting. */
export async function loginManual(): Promise<LoginFlow> {
  const verifier = generateVerifier()
  const state = generateState()
  const url = authorizeUrl({ state, challenge: await challengeFor(verifier) })
  return {
    url,
    finish: async (code?: string) => {
      if (!code?.trim()) throw new Error("Manual login requires the pasted authorization code")
      return exchangeCode({ code: code.trim(), verifier })
    },
    close: () => {},
  }
}
