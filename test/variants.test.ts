import { afterEach, describe, expect, test } from "bun:test"
import * as zlib from "node:zlib"
import { toModelInfos } from "../src/catalog.ts"
import { clearCachedUserJwt } from "../src/protocol/auth.ts"
import { getCachedCatalog, type ModelCatalogEntry } from "../src/protocol/catalog.ts"
import { createDevin } from "../src/protocol/model.ts"
import { encodeString, iterFields } from "../src/protocol/wire.ts"
import { capability, catalogReply, inSeconds, jwt, modelConfig, realFetch, stubFetch, uniqueHost } from "./helpers.ts"

const API_KEY = "devin-session-token$variants"

afterEach(() => {
  globalThis.fetch = realFetch
  clearCachedUserJwt()
})

/** The reply shape observed live: effort in the uid, and in the capabilities. */
const liveCatalog = () =>
  catalogReply([
    modelConfig("claude-opus-5-5-medium", { label: "Claude Opus 5.5 Medium" }),
    modelConfig("claude-opus-5-5-low", { label: "Claude Opus 5.5 Low" }),
    modelConfig("claude-opus-5-5-max", { label: "Claude Opus 5.5 Max" }),
    modelConfig("claude-opus-5-5-high-fast", { label: "Claude Opus 5.5 High Fast" }),
    modelConfig("claude-opus-5-5-low-fast", { label: "Claude Opus 5.5 Low Fast" }),
    modelConfig("gpt-5-6-sol-none-priority", { label: "GPT-5.6 Sol No Thinking Fast" }),
    modelConfig("gpt-5-6-sol-xhigh-priority", { label: "GPT-5.6 Sol XHigh Thinking Fast" }),
    modelConfig("glm-5-2", { label: "GLM-5.2 High", capabilities: [capability("Effort", { level: 1, value: "High" })] }),
    modelConfig("glm-5-2-max", { label: "GLM-5.2 Max", capabilities: [capability("Effort", { level: 2, value: "Max" })] }),
    modelConfig("glm-5-2-none", { label: "GLM-5.2 No Thinking", capabilities: [capability("Effort", { value: "No Thinking" })] }),
    modelConfig("kimi-k2-6", { label: "Kimi K2.6" }),
    modelConfig("claude-opus-4-6-thinking", { label: "Claude Opus 4.6 Thinking", capabilities: [capability("Thinking", { level: 1 })] }),
    modelConfig("swe-2-max", { label: "SWE-2 Max", disabled: true }),
  ])

const loadEntries = async (): Promise<ModelCatalogEntry[]> => {
  stubFetch({ catalog: () => new Response(liveCatalog(), { status: 200 }) })
  return [...(await getCachedCatalog(API_KEY, uniqueHost()))!.byUid.values()]
}

type Published = { id: string; name: string; status: string; variants: { id: string; settings: unknown }[] }

const all = (entries: ModelCatalogEntry[]) => toModelInfos(entries) as unknown as Published[]

/** The models the picker shows: opencode hides deprecated ones. */
const published = (entries: ModelCatalogEntry[]) =>
  Object.fromEntries(all(entries).filter((model) => model.status === "active").map((model) => [model.id, model]))

describe("capabilities decode (field #30)", () => {
  // Regression: the nested state was read as a string, so `enabled` was always
  // false and `value` was the raw bytes of the message.
  test("reads the nested state", async () => {
    const entries = await loadEntries()
    const byUid = Object.fromEntries(entries.map((entry) => [entry.modelUid, entry]))
    expect(byUid["glm-5-2"]!.capabilities).toEqual([{ name: "Effort", enabled: true, value: "High" }])
    expect(byUid["glm-5-2-none"]!.capabilities).toEqual([{ name: "Effort", enabled: false, value: "No Thinking" }])
    expect(byUid["claude-opus-4-6-thinking"]!.capabilities).toEqual([{ name: "Thinking", enabled: true, value: undefined }])
  })

  test("takes the effort of a uid that names none from the capability", async () => {
    const byUid = Object.fromEntries((await loadEntries()).map((entry) => [entry.modelUid, entry]))
    expect(byUid["glm-5-2"]!.effortLevel).toBe("high")
    expect(byUid["glm-5-2"]!.baseModelUid).toBe("glm-5-2")
    expect(byUid["glm-5-2-none"]!.effortLevel).toBe("none")
    expect(byUid["kimi-k2-6"]!.effortLevel).toBeUndefined()
  })
})

describe("published models", () => {
  test("one model per family, with its efforts as variants, weakest first", async () => {
    const models = published(await loadEntries())
    expect(Object.keys(models).sort()).toEqual([
      "claude-opus-4-6-thinking",
      "claude-opus-5-5",
      "claude-opus-5-5-fast",
      "glm-5-2",
      "gpt-5-6-sol-priority",
      "kimi-k2-6",
    ])
    expect(models["claude-opus-5-5"]!.variants.map((variant) => variant.id)).toEqual(["low", "medium", "max"])
    expect(models["claude-opus-5-5-fast"]!.variants.map((variant) => variant.id)).toEqual(["low", "high"])
    expect(models["gpt-5-6-sol-priority"]!.variants.map((variant) => variant.id)).toEqual(["none", "xhigh"])
    expect(models["glm-5-2"]!.variants.map((variant) => variant.id)).toEqual(["none", "high", "max"])
    expect(models["claude-opus-5-5"]!.variants[0]!.settings).toEqual({ reasoningEffort: "low" })
  })

  test("names the family without the effort", async () => {
    const models = published(await loadEntries())
    expect(models["claude-opus-5-5"]!.name).toBe("Claude Opus 5.5")
    expect(models["claude-opus-5-5-fast"]!.name).toBe("Claude Opus 5.5 Fast")
    expect(models["gpt-5-6-sol-priority"]!.name).toBe("GPT-5.6 Sol Fast")
    expect(models["glm-5-2"]!.name).toBe("GLM-5.2")
  })

  test("leaves a model without efforts as it was, and drops disabled ones", async () => {
    const models = published(await loadEntries())
    expect(models["kimi-k2-6"]).toMatchObject({ name: "Kimi K2.6", variants: [] })
    expect(models["claude-opus-4-6-thinking"]).toMatchObject({ name: "Claude Opus 4.6 Thinking", variants: [] })
    expect(models["swe-2-max"]).toBeUndefined()
    expect(models["swe-2"]).toBeUndefined()
  })

  test("keeps each per-effort uid resolvable, as a deprecated model", async () => {
    const legacy = all(await loadEntries()).filter((model) => model.status === "deprecated")
    expect(legacy.map((model) => model.id).sort()).toEqual([
      "claude-opus-5-5-high-fast",
      "claude-opus-5-5-low",
      "claude-opus-5-5-low-fast",
      "claude-opus-5-5-max",
      "claude-opus-5-5-medium",
      "glm-5-2-max",
      "glm-5-2-none",
      "gpt-5-6-sol-none-priority",
      "gpt-5-6-sol-xhigh-priority",
    ])
    expect(legacy.every((model) => model.variants.length === 0)).toBe(true)
    expect(legacy.find((model) => model.id === "claude-opus-5-5-low")!.name).toBe("Claude Opus 5.5 Low")
    // No id is published twice: `glm-5-2` is the family and a uid at once.
    const ids = all(await loadEntries()).map((model) => model.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("does not merge members it cannot tell apart by effort", () => {
    const entry = (modelUid: string, baseModelUid: string, effortLevel?: string): ModelCatalogEntry => ({
      modelUid,
      label: modelUid,
      disabled: false,
      contextWindow: 0,
      baseModelUid,
      effortLevel,
    })
    // Two members at the same effort: merging would make one unreachable.
    const models = published([entry("x-high", "x", "high"), entry("x", "x", "high")])
    expect(Object.keys(models).sort()).toEqual(["x", "x-high"])
    expect(models["x"]!.variants).toEqual([])
  })
})

describe("variant selection reaches the wire", () => {
  /** Run one request and return the model uid (field #21) that was sent. */
  const sentUid = async (modelId: string, reasoningEffort?: string) => {
    let uid = ""
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.includes("GetUserJwt")) {
        return Promise.resolve(new Response(new Uint8Array(encodeString(1, jwt(inSeconds(600)))), { status: 200 }))
      }
      if (url.includes("GetCascadeModelConfigs")) return Promise.resolve(new Response(liveCatalog(), { status: 200 }))
      const sent = Buffer.from(init!.body as Uint8Array)
      for (const field of iterFields(zlib.gunzipSync(sent.subarray(5)))) {
        if (field.num === 21) uid = (field.value as Buffer).toString("utf8")
      }
      const trailer = Buffer.alloc(5)
      trailer[0] = 0x02
      return Promise.resolve(new Response(new Uint8Array(trailer), { status: 200 }))
    }) as typeof fetch
    const model = createDevin({ apiKey: API_KEY, baseURL: uniqueHost() }).languageModel(modelId)
    await model.doGenerate({
      prompt: [],
      ...(reasoningEffort ? { providerOptions: { devin: { reasoningEffort } } } : {}),
    } as never)
    return uid
  }

  test("sends the uid for the selected effort", async () => {
    expect(await sentUid("claude-opus-5-5", "max")).toBe("claude-opus-5-5-max")
    expect(await sentUid("claude-opus-5-5-fast", "high")).toBe("claude-opus-5-5-high-fast")
    expect(await sentUid("glm-5-2", "none")).toBe("glm-5-2-none")
    expect(await sentUid("glm-5-2", "high")).toBe("glm-5-2")
  })

  test("sends the family default when no variant is selected", async () => {
    expect(await sentUid("claude-opus-5-5")).toBe("claude-opus-5-5-medium")
    expect(await sentUid("glm-5-2")).toBe("glm-5-2")
  })

  test("a full uid from an older config still works", async () => {
    expect(await sentUid("claude-opus-5-5-low")).toBe("claude-opus-5-5-low")
  })
})
