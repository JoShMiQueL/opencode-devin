/** Shared constants for the opencode-devin plugin. */

/** OpenCode provider and integration ID. Models appear as `devin/<uid>`. */
export const PROVIDER_ID = "devin"

/** Environment variable holding a Devin session token (`devin-session-token$...`). */
export const LLM_ENV_VAR = "DEVIN_LLM_API_KEY"

/** Devin webapp — hosts the CLI login page (`/auth/cli/continue`). */
export const WEBAPP_URL = "https://app.devin.ai"

/** Devin auth API — exchanges the PKCE code for a session token. */
export const AUTH_API_URL = "https://api.devin.ai"

/** Default Codeium API server (Cascade gRPC) when no tenant host is known. */
export const DEFAULT_API_SERVER = "https://server.codeium.com"

/** Prefix the Devin CLI puts in front of the session JWT. */
export const TOKEN_PREFIX = "devin-session-token$"

/** Loopback callback path required by the webapp's safe-redirect check. */
export const CALLBACK_PATH = "/callback"

/** Credential lifetime reported to opencode (the token itself is long-lived). */
export const CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000

/** Fallback release date for catalog models that do not expose one (epoch ms). */
export const DEFAULT_RELEASED_MS = Date.parse("2025-01-01T00:00:00Z")
