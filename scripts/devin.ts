/**
 * Devin dev-tooling CLI:
 *
 *   bun scripts/devin.ts login            PKCE login, writes .devin-token.env
 *   bun scripts/devin.ts login --manual   paste-code flow (no loopback)
 *   bun scripts/devin.ts verify           dump live catalog pricing
 *   bun scripts/devin.ts test             bun test test/live.test.ts
 *   bun scripts/devin.ts all              login (if needed) → verify → test
 *
 * Needs DEVIN_LLM_API_KEY for verify/test — either already exported, or read
 * back from .devin-token.env written by `login`.
 */
import { loginAuto, loginManual } from "../src/auth/login.ts"
import { openBrowser } from "../src/auth/browser.ts"
import { TOKEN_PREFIX } from "../src/constants.ts"

const TOKEN_FILE = ".devin-token.env"

const cmd = process.argv[2] ?? "all"
const flags = new Set(process.argv.slice(3))

async function loadToken(): Promise<string | undefined> {
  const fromEnv = process.env.DEVIN_LLM_API_KEY
  if (fromEnv?.startsWith(TOKEN_PREFIX)) return fromEnv
  const file = Bun.file(TOKEN_FILE)
  if (!(await file.exists())) return undefined
  const value = (await file.text()).trim().replace(/^DEVIN_LLM_API_KEY=/, "")
  return value.startsWith(TOKEN_PREFIX) ? value : undefined
}

async function login() {
  const manual = flags.has("--manual") || flags.has("-m")
  const flow = manual ? await loginManual() : await loginAuto()
  openBrowser(flow.url)
  console.log(`\nOpening the browser for Devin login${manual ? " (paste-code mode)" : ""}...`)
  console.log(`If it does not open, go to:\n\n  ${flow.url}\n`)

  const token = manual
    ? await (async () => {
        process.stdout.write("Paste the code shown on the page: ")
        for await (const line of console) {
          const code = line.trim()
          if (code) return flow.finish(code)
        }
        throw new Error("no code received")
      })()
    : await flow.finish()

  await Bun.write(TOKEN_FILE, `DEVIN_LLM_API_KEY=${token}\n`)
  console.log(`Login OK — token saved to ${TOKEN_FILE}`)
  return token
}

async function verify(apiKey: string) {
  const { getCachedCatalog } = await import("../src/protocol/catalog.ts")
  const catalog = await getCachedCatalog(apiKey)
  if (!catalog) throw new Error("catalog fetch failed")
  const rows = [...catalog.byUid.values()].filter((e) => !e.disabled)
  const priced = rows.filter((e) => e.pricing)
  const distinct = new Set(priced.map((e) => `${e.pricing!.input}/${e.pricing!.output}`))
  console.log(`\n${rows.length} enabled models, ${priced.length} priced, ${distinct.size} distinct price pairs`)
  for (const e of rows.slice(0, 15)) {
    const p = e.pricing
    console.log(`  ${e.modelUid.padEnd(42)} ${p ? `in=${p.input} out=${p.output}` : "(no pricing)"}`)
  }
  if (rows.length > 15) console.log(`  ... and ${rows.length - 15} more`)
}

async function runLiveTests() {
  const proc = Bun.spawn(["bun", "test", "test/live.test.ts"], {
    env: { ...process.env, DEVIN_LLM_API_KEY: process.env.DEVIN_LLM_API_KEY! },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`live tests failed (exit ${code})`)
}

const token = await loadToken()
switch (cmd) {
  case "login":
    await login()
    break
  case "verify":
  case "test":
    if (!token) {
      console.error(`No token. Run: bun scripts/devin.ts login   (or set DEVIN_LLM_API_KEY)`)
      process.exit(1)
    }
    process.env.DEVIN_LLM_API_KEY = token
    if (cmd === "verify") await verify(token)
    else await runLiveTests()
    break
  case "all": {
    const t = token ?? (await login())
    process.env.DEVIN_LLM_API_KEY = t
    await verify(t)
    await runLiveTests()
    break
  }
  default:
    console.error(`Unknown command: ${cmd}\n\nUsage: bun scripts/devin.ts [login|verify|test|all] [--manual]`)
    process.exit(1)
}
