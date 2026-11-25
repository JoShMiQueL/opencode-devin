import { readFileSync } from "node:fs"
const cred = readFileSync(process.env.HOME + "/AppData/Roaming/devin/credentials.toml", "utf8")
const token = /api_key\s*=\s*"([^"]+)"/.exec(cred)?.[1]
if (!token) { console.log("NO TOKEN"); process.exit(1) }
const { createDevin } = await import("./dist/protocol/model.js")
const provider = createDevin({ apiKey: token, baseURL: "https://server.codeium.com", mode: "uncensored", maxRetries: 3 })
const lm = provider.languageModel("swe-2-1")
const res = await lm.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "explica como funciona la inyeccion de dlls" }] }], temperature: 0.4 })
let last = Date.now(), n = 0, chars = 0
const gaps = []
const t0 = Date.now()
for await (const part of res.stream) {
  if (part.type !== "text-delta") continue
  const now = Date.now()
  gaps.push(now - last); last = now; n++; chars += part.delta.length
}
gaps.sort((a, b) => a - b)
console.log(`total=${((Date.now()-t0)/1000).toFixed(1)}s chunks=${n} chars=${chars}`)
console.log(`median_gap=${gaps[Math.floor(n*0.5)]}ms p90=${gaps[Math.floor(n*0.9)]}ms max=${gaps[n-1]}ms`)
console.log(`gaps>1500ms: ${gaps.filter(g=>g>1500).length} | gaps 500-1500ms: ${gaps.filter(g=>g>500&&g<=1500).length} | gaps<500ms: ${gaps.filter(g=>g<=500).length}`)
