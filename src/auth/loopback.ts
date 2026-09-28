/**
 * Loopback callback server for the Devin CLI login flow.
 *
 * Binds first so the redirect port is known before the sign-in URL is
 * returned, and pre-registers the waiter before the browser opens — a cached
 * app.devin.ai session can round-trip fast enough to hit `/callback` before
 * the caller awaits the promise.
 */

import { CALLBACK_PATH } from "../constants.ts"

export interface CallbackServer {
  redirectUri: string
  code: Promise<string>
  close: () => void
}

/**
 * How long the loopback listener stays armed waiting for the browser redirect.
 *
 * The integration method registration has no cancellation hook, so an
 * abandoned sign-in (tab closed, user picked the paste-code method instead)
 * would otherwise leave the port bound and the HTTP server running for the
 * life of the process. This timer is the only place that can be cleaned up
 * from, so it is the backstop. Long enough for a real interactive login
 * including any second factor.
 */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

/** Bind a one-shot HTTP server and wait for the authorization code. */
export function startCallbackServer(state: string, timeoutMs = CALLBACK_TIMEOUT_MS): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let settle: ((code: string) => void) | undefined
    let fail: ((error: Error) => void) | undefined
    const code = new Promise<string>((res, rej) => {
      settle = res
      fail = rej
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const clearTimer = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      clearTimer()
      server.stop(true)
    }

    let server: Bun.Server<unknown>
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const url = new URL(req.url)
          const page = (title: string, body: string, status = 200) =>
            new Response(
              `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
                `<body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>${body}</p></body></html>`,
              { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
            )

          if (url.pathname !== CALLBACK_PATH) {
            return page("Not found", "", 404)
          }
          if (url.searchParams.get("state") !== state) {
            return page("Invalid state parameter", "This may indicate a security issue. Please try again.", 400)
          }
          const received = url.searchParams.get("code")
          if (!received) {
            return page("No authorization code received", "Please return to the terminal and try again.", 400)
          }
          settle?.(received)
          // Stopping here would kill the listener before this response is
          // delivered, so the success page would never reach the browser.
          // The caller closes the server once the code is exchanged.
          clearTimer()
          return page("Signed in to Devin", "You can close this tab and return to opencode.")
        },
      })
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error("Failed to bind loopback callback server"))
      return
    }

    // Armed before the caller can learn the redirect URI, so there is no
    // window in which a completed redirect would leave the timer running.
    timer = setTimeout(() => {
      const label = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
      fail?.(new Error(`Login timed out after ${label}`))
      stop()
    }, timeoutMs)

    resolve({
      // The server is listening at this point, so the port is always set.
      redirectUri: `http://127.0.0.1:${server.port!}${CALLBACK_PATH}`,
      code,
      close: () => {
        fail?.(new Error("Login cancelled"))
        stop()
      },
    })
  })
}
