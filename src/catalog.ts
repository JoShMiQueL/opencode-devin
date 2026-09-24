/**
 * Model catalog → OpenCode v2 `Model.Info`.
 *
 * The live catalog comes from the per-account `GetCascadeModelConfigs` RPC
 * (via ai-sdk-devin) — every model UID the subscription can use, with pricing
 * and context windows.
 */

import { getCachedCatalog, type ModelCatalogEntry } from "ai-sdk-devin"
import { Model, Provider } from "@opencode/plugin"
import { DEFAULT_RELEASED_MS, PROVIDER_ID } from "./constants.ts"

export async function fetchModels(apiKey: string): Promise<Model.Info[]> {
  const catalog = await getCachedCatalog(apiKey)
  if (!catalog) return []
  return Array.from(catalog.byUid.values())
    .filter((entry) => !entry.disabled)
    .map(toModelInfo)
}

function toModelInfo(entry: ModelCatalogEntry): Model.Info {
  const { pricing } = entry
  const base = Model.Info.default(Provider.ID.make(PROVIDER_ID), Model.ID.make(entry.modelUid))

  return {
    ...base,
    name: entry.label || entry.modelUid,
    enabled: !entry.disabled,
    status: "active",
    capabilities: {
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    },
    cost: [
      {
        input: pricing?.input ?? 0,
        output: pricing?.output ?? 0,
        cache: { read: pricing?.cachedInput ?? 0, write: 0 },
      },
    ],
    limit: {
      context: entry.contextWindow || 256_000,
      output: 128_000,
    },
    time: { released: DEFAULT_RELEASED_MS },
  } as unknown as Model.Info
}
