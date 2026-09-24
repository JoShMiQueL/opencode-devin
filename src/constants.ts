/** Shared constants for the opencode-devin plugin. */

/** OpenCode provider and integration ID. Models appear as `devin/<uid>`. */
export const PROVIDER_ID = "devin"

/** Environment variable holding a Windsurf OAuth token (`devin-session-token$...`). */
export const LLM_ENV_VAR = "DEVIN_LLM_API_KEY"

/** Credential file written by `opencode-windsurf-auth login` (fallback source). */
export const WINDSURF_AUTH_FILE = ".config/opencode-windsurf-auth/credentials.json"

/** Windsurf sign-in page (implicit-grant OAuth entry point). */
export const SIGNIN_URL = "https://windsurf.com/windsurf/signin"

/** Windsurf's Auth0 client id, extracted from the desktop extension. */
export const AUTH0_CLIENT_ID = "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u"

/** Connect-RPC endpoint exchanging a firebase_id_token for a long-lived api_key. */
export const REGISTER_SERVER = "https://register.windsurf.com"

/** Default Codeium API server when RegisterUser returns no tenant-scoped host. */
export const DEFAULT_API_SERVER = "https://server.codeium.com"

/** Credential lifetime reported to opencode (the token itself is long-lived). */
export const CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000

/** Fallback release date for catalog models that do not expose one (epoch ms). */
export const DEFAULT_RELEASED_MS = Date.parse("2025-01-01T00:00:00Z")
