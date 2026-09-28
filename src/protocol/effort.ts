/**
 * Reasoning-effort handling, in one place.
 *
 * The catalog encodes effort as a suffix on the model UID, and both the
 * catalog decoder and the request path have to read that suffix. They used to
 * carry their own copy of the same alternation, which is exactly the kind of
 * duplication that drifts when Cognition adds an effort level.
 */

/** Valid reasoning effort levels. */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** Derived from EFFORT_LEVELS so the two can never disagree. */
const EFFORT_SUFFIX = new RegExp(`-(${EFFORT_LEVELS.join("|")})$`)

/** Narrow an arbitrary value to a known effort level, or `undefined`. */
export function toEffortLevel(value: unknown): EffortLevel | undefined {
  if (typeof value !== "string") return undefined
  const effort = value.toLowerCase()
  return (EFFORT_LEVELS as readonly string[]).includes(effort) ? (effort as EffortLevel) : undefined
}

/** Split a UID into its base UID and effort suffix, e.g. `opus-4-8-high`. */
export function splitEffortSuffix(modelUid: string): { baseModelUid: string; effortLevel?: EffortLevel } {
  const match = modelUid.match(EFFORT_SUFFIX)
  const effortLevel = match?.[1]
  if (!effortLevel) return { baseModelUid: modelUid }
  return { baseModelUid: modelUid.slice(0, -(effortLevel.length + 1)), effortLevel: effortLevel as EffortLevel }
}

/** Append an effort suffix to a base UID. */
export function withEffortSuffix(modelUid: string, effort: EffortLevel): string {
  return `${modelUid}-${effort}`
}
