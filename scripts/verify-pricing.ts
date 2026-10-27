/** Dump the real catalog pricing to verify PR #3's field-#2 claim end to end. */
const apiKey = process.env.DEVIN_LLM_API_KEY!
const { getCachedCatalog } = await import("../src/protocol/catalog.ts")
const catalog = await getCachedCatalog(apiKey)
if (!catalog) { console.error("catalog fetch failed"); process.exit(1) }

const rows = [...catalog.byUid.values()]
  .filter((e) => !e.disabled)
  .map((e) => ({
    uid: e.modelUid,
    in: e.pricing?.input ?? "—",
    cached: e.pricing?.cachedInput ?? "—",
    out: e.pricing?.output ?? "—",
  }))
  .sort((a, b) => String(a.uid).localeCompare(String(b.uid)))

console.log(`\n${rows.length} enabled models:`)
for (const r of rows) console.log(`  ${String(r.uid).padEnd(42)} in=${r.in} cached=${r.cached} out=${r.out}`)

// Sanity: distinct price sets should be >1 (the bug was "all identical").
const distinct = new Set(rows.filter(r => r.in !== "—").map((r) => `${r.in}/${r.out}`))
console.log(`\nDistinct price pairs: ${distinct.size} — ${[...distinct].join(", ")}`)
