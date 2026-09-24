/**
 * PKCE (S256) helpers, matching the Devin CLI (chisel): 32 random bytes,
 * base64url-encoded, and a base64url SHA-256 challenge derived from the
 * verifier.
 */

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

/** PKCE code verifier: 32 random bytes, base64url without padding. */
export function generateVerifier(): string {
  return randomToken()
}

/** S256 challenge: base64url(sha256(verifier)). */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier))
  return base64url(new Uint8Array(digest))
}

/** CSRF state token. */
export function generateState(): string {
  return randomToken()
}
