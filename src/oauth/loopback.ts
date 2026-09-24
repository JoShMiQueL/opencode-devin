/**
 * Automated browser sign-in over a loopback callback server.
 *
 * The server binds FIRST so the redirect port is known before the sign-in URL
 * is returned, and the callback waiter is pre-registered before the browser
 * opens — a cached windsurf.com session can round-trip fast enough to hit
 * `/auth` before the caller awaits the promise.
 */

import { buildLoginUrl } from "./url.ts"
import { registerUser, type WindsurfCredentials } from "./register.ts"

export interface PreparedLogin {
  url: string
  instructions: string
  awaitToken: () => Promise<WindsurfCredentials>
  cancel: () => void
}

interface CallbackResult {
  token: string
  state: string
}

interface CallbackServer {
  port: number
  close: () => void
  callback: (expectedState: string) => Promise<CallbackResult>
}

/**
 * Bind a one-shot HTTP server on a free ephemeral port. Resolves the
 * `callback(state)` promise the first time `/auth` is hit with a token and a
 * matching state; mismatched or unexpected callbacks are rejected for their
 * own waiter only.
 */
function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let captured: (CallbackResult & { error?: string }) | null = null
    const waiters: Array<{
      state: string
      resolve: (result: CallbackResult) => void
      reject: (error: Error) => void
    }> = []

    const flush = () => {
      if (!captured) return
      const result = captured
      captured = null
      for (const waiter of waiters.splice(0)) {
        if (waiter.state !== result.state) continue
        if (result.error || !result.token) {
          waiter.reject(new Error(result.error || "OAuth callback delivered an empty token"))
        } else {
          waiter.resolve(result)
        }
      }
      // Keep the server alive a beat so the browser can render the page.
      setTimeout(() => server.stop(true), 1_000).unref()
    }

    let server: Bun.Server<unknown>
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname !== "/auth") return new Response("Not Found", { status: 404 })

          const token =
            url.searchParams.get("firebase_id_token") ??
            url.searchParams.get("access_token") ??
            url.searchParams.get("token")
          const state = url.searchParams.get("state") ?? ""
          const error = url.searchParams.get("error") ?? url.searchParams.get("error_description")
          const html = (body: string) =>
            new Response(`<!doctype html><body>${body}</body>`, { headers: { "Content-Type": "text/html" } })

          if (error) {
            if (!waiters.some((w) => w.state === state)) {
              return html("<p>Unexpected error callback — close this tab.</p>")
            }
            captured = { token: "", state, error }
            return html(`<p>Sign-in failed: ${escapeHtml(error)}</p>`)
          }

          if (!token) {
            // Auth0 may deliver the token in the URL fragment; re-emit it as a
            // query string client-side so the server can capture it.
            return new Response(
              `<!doctype html><script>
                if (location.hash.length > 1) location.replace("/auth?" + location.hash.slice(1))
                else document.body.textContent = "Missing token - close this tab and retry."
              </script>`,
              { headers: { "Content-Type": "text/html" } },
            )
          }

          if (!waiters.some((w) => w.state === state)) {
            return html("<p>Unexpected callback — close this tab.</p>")
          }
          captured = { token, state }
          return html("<p>Sign-in complete. You can close this tab.</p>")
        },
      })
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error("Failed to bind loopback callback server"))
      return
    }

    flush()
    resolve({
      // The server is listening at this point, so the port is always set.
      port: server.port!,
      close: () => server.stop(true),
      callback: (expectedState) =>
        new Promise((res, rej) => {
          waiters.push({ state: expectedState, resolve: res, reject: rej })
          if (captured?.state === expectedState) flush()
        }),
    })
  })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url]
  Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
}

/**
 * Start the browser sign-in flow. `awaitToken` resolves once the user
 * completes sign-in and the token has been exchanged for the long-lived
 * api_key; `cancel` tears the loopback down if the caller bails out.
 */
export async function prepareLogin(): Promise<PreparedLogin> {
  const server = await startCallbackServer()
  const { url, state } = buildLoginUrl(`http://127.0.0.1:${server.port}/auth`)

  const callbackPromise = server.callback(state)
  callbackPromise.catch(() => {})

  openBrowser(url)

  return {
    url,
    instructions: `Sign in to Windsurf in the opened browser tab. If it did not open, go to: ${url}`,
    cancel: () => server.close(),
    awaitToken: async () => {
      try {
        const callback = await callbackPromise
        return await registerUser(callback.token)
      } finally {
        server.close()
      }
    },
  }
}
