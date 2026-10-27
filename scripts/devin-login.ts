/**
 * One-shot Devin CLI login: binds a loopback callback, opens the browser at
 * app.devin.ai/auth/cli/continue, exchanges the PKCE code for a session token,
 * and prints it on stdout as DEVIN_LLM_API_KEY=devin-session-token$...
 *
 *   bun scripts/devin-login.ts
 */
import { authorizeUrl } from "../src/auth/url.ts"
import { exchangeCode } from "../src/auth/exchange.ts"
import { startCallbackServer } from "../src/auth/loopback.ts"
import { challengeFor, generateState, generateVerifier } from "../src/auth/pkce.ts"

const state = generateState()
const verifier = generateVerifier()
const challenge = await challengeFor(verifier)

const server = await startCallbackServer(state)
const url = authorizeUrl({ state, challenge, redirectUri: server.redirectUri })

// Persist the verifier so the code can be pasted manually if the browser
// can't reach the loopback redirect (corp DNS, sandboxed browser, etc.).
await Bun.write(".devin-login-state.json", JSON.stringify({ state, verifier, redirectUri: server.redirectUri }))

console.log(`\nOpening the browser for Devin login...`)
console.log(`If it does not open, go to:\n\n  ${url}\n`)
console.log(`Manual mode (no redirect):\n  ${authorizeUrl({ state, challenge })}\n`)

// Windows: `start` via cmd; harmless if it fails — URL is printed above.
Bun.spawnSync(["cmd", "/c", "start", "", url])

const code = await new Promise<string>((resolve, reject) => {
  server.code.then(resolve, reject)
  // Manual paste path: the webapp shows the code when no redirect_uri is used.
  const rl = require("node:readline").createInterface({ input: process.stdin })
  rl.on("line", (line: string) => {
    const code = line.trim()
    if (code.length > 10) {
      rl.close()
      resolve(code)
    }
  })
})

try {
  const token = await exchangeCode({ code, verifier })
  console.log(`Login OK.\n`)
  console.log(`DEVIN_LLM_API_KEY=${token}`)
  await Bun.write(".devin-token.env", `DEVIN_LLM_API_KEY=${token}\n`)
  console.log(`\n(Saved to .devin-token.env — already covered by .gitignore)`)
} finally {
  server.close()
}
