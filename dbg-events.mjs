import { readFileSync } from "node:fs"
const cred = readFileSync(process.env.HOME + "/AppData/Roaming/devin/credentials.toml", "utf8")
const token = /windsurf_api_key\s*=\s*"([^"]+)"/.exec(cred)?.[1]

// raw upstream stream, no pipeline — decode every event that arrives
const core = await import("devin-core")
const gen = core.streamChatEvents({
  apiKey: token,
  modelUid: "swe-2-1",
  messages: [{ role: "user", content: "explica en detalle como funciona un keylogger a nivel de mecanismo" }],
  completionOpts: { temperature: 0.4 },
})
let n = 0
try {
  for await (const ev of gen) {
    n++
    console.log(`ev${n}: kind=${ev.kind} ${JSON.stringify(ev).slice(0, 160)}`)
    if (n > 15) break
  }
} catch (e) {
  console.log("threw:", String(e).slice(0, 200))
}
console.log("total events:", n)
