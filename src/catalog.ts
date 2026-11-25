/**
 * Model catalog from Cognition's Cascade gRPC API.
 *
 * The live catalog comes from the per-account `GetCascadeModelConfigs` RPC
 * (via ai-sdk-devin) — every model UID the subscription can use, with pricing
 * and context windows. This is the same source the Devin CLI uses
 * (`GetCliModelConfigs`); the REST gateway (`/api/v1/models`) is not
 * provisioned for most accounts.
 *
 * Upstream lists one UID per reasoning effort. They are published as one model
 * per family with the efforts as variants, so the effort is picked with the
 * variant switcher instead of by choosing a different model.
 *
 * The per-effort UIDs stay published as deprecated models. opencode leaves
 * those out of the model picker but still resolves them, so a config, a
 * favourite or a session that names `devin/claude-opus-5-5-high` keeps working.
 */

import { getCachedCatalog, type ModelCatalogEntry } from "devin-core"
import { defaultMember, EFFORT_LEVELS, toEffortLevel } from "devin-core"
import { Model, Provider } from "@opencode/plugin"
import { DEFAULT_RELEASED_MS, PROVIDER_ID } from "./constants.ts"

export async function fetchModels(apiKey: string, apiServerUrl?: string): Promise<Model.Info[]> {
  const catalog = await getCachedCatalog(apiKey, apiServerUrl || undefined)
  if (!catalog) return []
  return toModelInfos(Array.from(catalog.byUid.values()))
}

/** Exported for tests. */
export function toModelInfos(entries: readonly ModelCatalogEntry[]): Model.Info[] {
  const families = new Map<string, ModelCatalogEntry[]>()
  for (const entry of entries) {
    if (entry.disabled) continue
    const key = entry.baseModelUid ?? entry.modelUid
    const family = families.get(key)
    if (family) family.push(entry)
    else families.set(key, [entry])
  }
  const models: Model.Info[] = []
  for (const [baseModelUid, family] of families) {
    // Members carrying a resolvable effort (suffix or capability) are the
    // variant candidates; members without one are bare uids. A bare uid whose
    // modelUid equals the family key is the family's default member — the
    // model the picker shows. Any other bare uid is a distinct model (e.g.
    // `-fast` speed variants sit in their own family key, so this is rare).
    const effortful = family.filter((entry) => toEffortLevel(entry.effortLevel) !== undefined)
    const distinctEfforts = new Set(effortful.map((entry) => toEffortLevel(entry.effortLevel)))

    // Merge when every effortful member maps to a distinct effort. The old
    // rule also required zero bare members — but the bare uid IS the default
    // variant, so a family of bare+effortful must merge too, not explode into
    // one model per uid. Only a family with more than one unresolvable bare
    // member (ambiguous default) falls back to one-model-per-uid.
    const bareCount = family.length - effortful.length
    if (effortful.length > 0 && distinctEfforts.size === effortful.length && bareCount <= 1) {
      const primary = defaultMember(family)!
      models.push(toModelInfo(primary, baseModelUid, effortful))
      for (const entry of family) {
        if (entry.modelUid !== baseModelUid) models.push(toModelInfo(entry, entry.modelUid, [], "deprecated"))
      }
    } else {
      for (const entry of family) models.push(toModelInfo(entry, entry.modelUid, []))
    }
  }
  return models
}

/** "Claude Opus 5.5 High Fast" and "GPT-6 Sol No Thinking" without the effort. */
function familyName(label: string): string {
  const efforts = EFFORT_LEVELS.join("|")
  const stripped = label
    .replace(/\s+No Thinking\b/i, "")
    .replace(new RegExp(`\\s+(?:${efforts})(?:\\s+Thinking)?(?=\\s|$)(?!.*\\s(?:${efforts})(?:\\s|$))`, "i"), "")
    .trim()
  return stripped || label
}

function toModelInfo(
  entry: ModelCatalogEntry,
  id: string,
  family: readonly ModelCatalogEntry[],
  status: "active" | "deprecated" = "active",
): Model.Info {
  const { pricing } = entry
  const base = Model.Info.default(Provider.ID.make(PROVIDER_ID), Model.ID.make(id))
  const rank = (candidate: ModelCatalogEntry) => EFFORT_LEVELS.indexOf(toEffortLevel(candidate.effortLevel)!)

  return {
    ...base,
    name: family.length > 0 ? familyName(entry.label || id) : entry.label || id,
    enabled: !entry.disabled,
    status,
    capabilities: {
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    },
    // Read by the provider as `providerOptions.devin.reasoningEffort`.
    variants: [...family]
      .sort((a, b) => rank(a) - rank(b))
      .map((member) => ({ id: member.effortLevel, settings: { reasoningEffort: member.effortLevel } })),
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
