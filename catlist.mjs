import { readFileSync } from "node:fs"
const cred = readFileSync(process.env.HOME + "/AppData/Roaming/devin/credentials.toml", "utf8")
const token = /windsurf_api_key\s*=\s*"([^"]+)"/.exec(cred)?.[1]
const { getCachedCatalog } = await import("devin-core")
const cat = await getCachedCatalog(token, "https://server.codeium.com")
console.log("entries:", cat.length)
const fams = {}
for (const m of cat) {
  const uid = m.modelUid
  const base = uid.replace(/-(none|minimal|low|medium|high|xhigh|max)(?=-|$)/, "")
  ;(fams[base] = fams[base] || []).push(uid === base ? "(bare)" : uid.slice(base.length + 1))
}
for (const [f, lanes] of Object.entries(fams).sort()) console.log(`${f}: ${lanes.join(", ")}`)
