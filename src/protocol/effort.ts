/**
 * Reasoning-effort handling, in one place.
 *
 * The catalog encodes effort as a suffix on the model UID, and both the
 * catalog decoder and the request path have to read that suffix. They used to
 * carry their own copy of the same alternation, which is exactly the kind of
 * duplication that drifts when Cognition adds an effort level.
 */

/** Valid reasoning effort levels, weakest first. */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** Narrow an arbitrary value to a known effort level, or `undefined`. */
export function toEffortLevel(value: unknown): EffortLevel | undefined {
  if (typeof value !== "string") return undefined
  const effort = value.toLowerCase()
  return (EFFORT_LEVELS as readonly string[]).includes(effort) ? (effort as EffortLevel) : undefined
}

/** Effort named by a catalog capability value, e.g. "XHigh" or "No Thinking". */
export function effortFromLabel(label: string | undefined): EffortLevel | undefined {
  if (!label) return undefined
  return /^no thinking$/i.test(label.trim()) ? "none" : toEffortLevel(label.trim())
}

/**
 * Index of the effort segment in a UID split on "-".
 *
 * The effort is not always last: speed and context modifiers follow it, as in
 * `claude-opus-5-5-high-fast`, `gpt-5-6-sol-none-priority` and
 * `glm-5-2-max-1m`. The last effort word wins, and the first segment is never
 * one, so a bare effort word is not a suffix.
 */
function effortIndex(segments: string[]): number {
  for (let i = segments.length - 1; i > 0; i--) {
    if (toEffortLevel(segments[i]) === segments[i]) return i
  }
  return -1
}

/**
 * Split a UID into its base UID and effort, e.g. `opus-4-8-high` into
 * `opus-4-8` and `high`, or `opus-4-8-high-fast` into `opus-4-8-fast` and `high`.
 */
export function splitEffortSuffix(modelUid: string): { baseModelUid: string; effortLevel?: EffortLevel } {
  const segments = modelUid.split("-")
  const index = effortIndex(segments)
  if (index === -1) return { baseModelUid: modelUid }
  return {
    baseModelUid: [...segments.slice(0, index), ...segments.slice(index + 1)].join("-"),
    effortLevel: segments[index] as EffortLevel,
  }
}

/** Replace the effort in a UID that has one, or append it to one that does not. */
export function withEffortSuffix(modelUid: string, effort: EffortLevel): string {
  const segments = modelUid.split("-")
  const index = effortIndex(segments)
  if (index === -1) return `${modelUid}-${effort}`
  segments[index] = effort
  return segments.join("-")
}

/** A model as far as effort selection is concerned. */
export interface EffortMember {
  modelUid: string
  baseModelUid?: string
  effortLevel?: string
}

/**
 * The member to use when no effort is asked for: the UID that carries no
 * effort if the family has one, otherwise medium, then high, then the first.
 */
export function defaultMember<T extends EffortMember>(family: readonly T[]): T | undefined {
  return (
    family.find((member) => member.modelUid === (member.baseModelUid ?? member.modelUid)) ??
    family.find((member) => member.effortLevel === "medium") ??
    family.find((member) => member.effortLevel === "high") ??
    family[0]
  )
}
