/**
 * `GetCascadeModelConfigs` — per-account model catalog from Cognition.
 *
 * Returns every model UID the subscription can use, with pricing and context
 * windows. This is the same source the Devin CLI uses (`GetCliModelConfigs`).
 * Originally ported from pi-devin-auth (MIT, Copyright (c) 2026 nmzpy).
 */

import { encodeMessage, iterFields } from "./wire.ts"
import { buildMetadata } from "./metadata.ts"
import { getCachedUserJwt } from "./auth.ts"
import { DEFAULT_API_SERVER } from "../constants.ts"

const CATALOG_TTL_MS = 10 * 60 * 1000
const CATALOG_FETCH_TIMEOUT_MS = 10_000

export interface ModelPricing {
  /** Price per 1M input tokens (USD), or 0 if free. */
  input: number
  /** Price per 1M cached input tokens (USD), or 0 if N/A. */
  cachedInput: number
  /** Price per 1M output tokens (USD), or 0 if free. */
  output: number
}

export interface ModelCapability {
  /** Feature name, e.g. "Effort", "Thinking", "Fast Mode", "1M Context". */
  name: string
  enabled: boolean
  /** Optional value, e.g. "Medium" for Effort. */
  value?: string
}

export interface ModelCatalogEntry {
  modelUid: string
  label: string
  disabled: boolean
  contextWindow: number
  pricing?: ModelPricing
  capabilities?: ModelCapability[]
  /** Base model UID without the effort suffix (e.g. "claude-opus-4-8" for "claude-opus-4-8-medium"). */
  baseModelUid?: string
  /** Reasoning effort level if encoded in the UID (none/low/medium/high/xhigh/max). */
  effortLevel?: string
}

export interface Catalog {
  byUid: Map<string, ModelCatalogEntry>
  fetchedAt: number
  apiKey: string
  host: string
}

async function fetchCatalog(apiKey: string, host: string, signal?: AbortSignal): Promise<Catalog> {
  const userJwt = await getCachedUserJwt(apiKey, host, signal)
  const metadata = buildMetadata({
    apiKey,
    userJwt,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  })
  const request = encodeMessage(1, metadata)
  const timeout = AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS)
  const response = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs`, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body: new Uint8Array(request),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GetCascadeModelConfigs HTTP ${response.status}: ${text.slice(0, 200)}`)
  }

  const buf = Buffer.from(await response.arrayBuffer())
  const byUid = new Map<string, ModelCatalogEntry>()
  for (const field of iterFields(buf)) {
    if (field.num !== 1 || field.wire !== 2 || !Buffer.isBuffer(field.value)) continue
    const entry = decodeModelConfig(field.value)
    if (entry) byUid.set(entry.modelUid, entry)
  }
  return { byUid, fetchedAt: Date.now(), apiKey, host }
}

function decodeModelConfig(buf: Buffer): ModelCatalogEntry | undefined {
  let label = ""
  let modelUid = ""
  let disabled = false
  let contextWindow = 0
  let pricing: ModelPricing | undefined
  let capabilities: ModelCapability[] | undefined

  for (const field of iterFields(buf)) {
    if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      label = field.value.toString("utf8")
    } else if (field.num === 4 && field.wire === 0) {
      disabled = field.value === 1n
    } else if (field.num === 18 && field.wire === 0) {
      contextWindow = Number(field.value)
    } else if (field.num === 22 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      modelUid = field.value.toString("utf8")
    } else if (field.num === 30 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      // Capabilities message: #1 display name, #2 (repeated) feature { #1 name, #2 { #1 enabled, #2 value } }
      capabilities = []
      for (const feature of iterFields(field.value)) {
        if (feature.num !== 2 || feature.wire !== 2 || !Buffer.isBuffer(feature.value)) continue
        let name = ""
        let enabled = false
        let value: string | undefined
        for (const part of iterFields(feature.value)) {
          if (part.num === 1 && part.wire === 2 && Buffer.isBuffer(part.value)) {
            name = part.value.toString("utf8")
          } else if (part.num === 1 && part.wire === 0) {
            enabled = part.value === 1n
          } else if (part.num === 2 && part.wire === 2 && Buffer.isBuffer(part.value)) {
            value = part.value.toString("utf8")
          }
        }
        if (name) capabilities.push({ name, enabled, value })
      }
    } else if (field.num === 32 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      // Pricing message (repeated): #1 type, #4 price (float32 LE)
      pricing ??= { input: 0, cachedInput: 0, output: 0 }
      let type = ""
      let price = 0
      for (const part of iterFields(field.value)) {
        if (part.num === 1 && part.wire === 2 && Buffer.isBuffer(part.value)) {
          type = part.value.toString("utf8").toLowerCase()
        } else if (part.num === 4 && Buffer.isBuffer(part.value) && part.value.length === 4) {
          price = part.value.readFloatLE(0)
        }
      }
      if (type.includes("input") && !type.includes("cached")) pricing.input = price
      else if (type.includes("cached")) pricing.cachedInput = price
      else if (type.includes("output")) pricing.output = price
    }
  }

  if (modelUid.length === 0) return undefined
  // Extract the effort level from the UID suffix
  const effortMatch = modelUid.match(/-(none|low|medium|high|xhigh|max)$/)
  const effortLevel = effortMatch?.[1]
  const baseModelUid = effortLevel ? modelUid.slice(0, -effortLevel.length - 1) : undefined
  return {
    modelUid,
    label: label || modelUid,
    disabled,
    contextWindow,
    pricing,
    capabilities,
    baseModelUid,
    effortLevel,
  }
}

let cached: Catalog | null = null
let inFlight: Promise<Catalog> | null = null
let inFlightKey: string | null = null

const flightKey = (apiKey: string, host: string) => `${host}${apiKey}`

/** Fetch the per-account catalog, cached for 10 minutes. Returns null on failure. */
export async function getCachedCatalog(
  apiKey: string,
  host = DEFAULT_API_SERVER,
  signal?: AbortSignal,
): Promise<Catalog | null> {
  if (cached && cached.apiKey === apiKey && cached.host === host && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return cached
  }
  const key = flightKey(apiKey, host)
  if (inFlight && inFlightKey === key) {
    try {
      return await inFlight
    } catch {
      return null
    }
  }
  const promise = fetchCatalog(apiKey, host, signal)
  inFlight = promise
  inFlightKey = key
  try {
    const result = await promise
    cached = result
    return result
  } catch {
    return null
  } finally {
    if (inFlight === promise) {
      inFlight = null
      inFlightKey = null
    }
  }
}

export function clearCachedCatalog(): void {
  cached = null
  inFlight = null
  inFlightKey = null
}

export class ModelNotAvailableError extends Error {
  readonly modelUid: string
  readonly label: string
  readonly reason: "disabled" | "not_listed"
  constructor(modelUid: string, label: string, reason: "disabled" | "not_listed") {
    super(
      reason === "disabled"
        ? `Model "${label}" (uid=${modelUid}) is not enabled for your Cognition account tier.`
        : `Model uid "${modelUid}" is not listed in the Cognition catalog for your account.`,
    )
    this.name = "ModelNotAvailableError"
    this.modelUid = modelUid
    this.label = label
    this.reason = reason
  }
}
