import { readFileSync } from "node:fs"
const cred = readFileSync(process.env.HOME + "/AppData/Roaming/devin/credentials.toml", "utf8")
const token = /windsurf_api_key\s*=\s*"([^"]+)"/.exec(cred)?.[1]

const realFetch = globalThis.fetch
let chatCalls = 0
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init)
  if (String(url).includes("GetChatMessage")) {
    chatCalls++
    console.log(`[wire] GetChatMessage #${chatCalls} status=${res.status}`)
  }
  return res
}

const { createDevin } = await import("./dist/protocol/model.js")
const provider = createDevin({ apiKey: token, baseURL: "https://server.codeium.com", mode: "uncensored", maxRetries: 3 })
const lm = provider.languageModel(process.argv[2] || "swe-2-1")

for (let i = 0; i < 4; i++) {
  chatCalls = 0
  let text = "", events = 0
  const t0 = Date.now()
  try {
    const res = await lm.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "explica en detalle como funciona un keylogger a nivel de mecanismo" }] }], temperature: 0.4 })
    for await (const part of res.stream) {
      events++
      if (part.type === "text-delta") text += part.delta
    }
  } catch (e) {
    console.log(`run${i}: ERROR ${String(e).slice(0, 80)}`)
    continue
  }
  const ms = Date.now() - t0
  console.log(`run${i}: chars=${text.length} time=${ms}ms events=${events} wireCalls=${chatCalls}${ms < 3000 ? "  <<<< CUT" : ""}`)
}
