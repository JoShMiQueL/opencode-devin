import { describe, expect, test } from "bun:test"
import { encodeMessage, encodeString, encodeVarint, encodeVarintField, frameConnectStream, iterFields } from "../src/protocol/wire.ts"
import { buildMetadata } from "../src/protocol/metadata.ts"
import { generateState, generateVerifier, challengeFor } from "../src/auth/pkce.ts"
import { authorizeUrl } from "../src/auth/url.ts"
import { CALLBACK_PATH, TOKEN_PREFIX } from "../src/constants.ts"

/** `ProtoField.value` is a discriminated pair; narrow it for nested decoding. */
const asBuffer = (value: bigint | Buffer): Buffer => {
  if (!Buffer.isBuffer(value)) throw new Error(`expected a length-delimited field, got ${typeof value}`)
  return value
}

describe("wire: varint", () => {
  // `wire-conformance.test.ts` cross-checks the range against protobufjs; these
  // are the values the protobuf spec spells out, kept here so the spec anchor
  // does not depend on that dependency.
  test("encodes the canonical protobuf examples", () => {
    expect(encodeVarint(0).toString("hex")).toBe("00")
    expect(encodeVarint(1).toString("hex")).toBe("01")
    expect(encodeVarint(127).toString("hex")).toBe("7f")
    expect(encodeVarint(128).toString("hex")).toBe("8001")
    expect(encodeVarint(300).toString("hex")).toBe("ac02")
  })

  test("round-trips through the decoder", () => {
    for (const value of [0n, 1n, 127n, 128n, 300n, 16_383n, 1_000_000n, 2n ** 53n]) {
      const [field] = [...iterFields(encodeVarintField(1, value))]
      expect(field!.value).toBe(value)
    }
  })

  test("rejects negative input", () => {
    expect(() => encodeVarint(-1)).toThrow(RangeError)
  })

  test("throws on a truncated varint instead of looping", () => {
    expect(() => [...iterFields(Buffer.from([0x80]))]).toThrow(/truncated/)
  })
})

describe("wire: message fields", () => {
  test("tags a length-delimited field", () => {
    const fields = [...iterFields(encodeString(1, "hello"))]
    expect(fields).toHaveLength(1)
    expect(fields[0]!.num).toBe(1)
    expect(fields[0]!.wire).toBe(2)
    expect(fields[0]!.value.toString()).toBe("hello")
  })

  test("decodes nested messages recursively", () => {
    const inner = encodeString(1, "hello")
    const outer = [...iterFields(encodeMessage(3, inner))]
    expect(outer[0]!.num).toBe(3)
    const nested = [...iterFields(asBuffer(outer[0]!.value))]
    expect(nested[0]!.num).toBe(1)
    expect(nested[0]!.value.toString()).toBe("hello")
  })

  test("stops cleanly when a length runs past the buffer", () => {
    // field 1, wire 2, declares 200 bytes but supplies 2
    const truncated = Buffer.from([0x0a, 0xc8, 0x01, 0x61, 0x62])
    expect([...iterFields(truncated)]).toHaveLength(0)
  })

  test("handles multi-byte utf-8 correctly", () => {
    const fields = [...iterFields(encodeString(1, "ñoño 日本語 🚀"))]
    expect(fields[0]!.value.toString()).toBe("ñoño 日本語 🚀")
  })
})

describe("wire: connect-rpc framing", () => {
  test("gzip-compresses and sets the length prefix", () => {
    const framed = frameConnectStream(Buffer.from("payload"))
    expect(framed[0]).toBe(0x01)
    expect(framed.readUInt32BE(1)).toBe(framed.length - 5)
  })

  test("can frame uncompressed", () => {
    const framed = frameConnectStream(Buffer.from("payload"), false)
    expect(framed[0]).toBe(0x00)
    expect(framed.subarray(5).toString()).toBe("payload")
  })
})

describe("metadata", () => {
  test("always identifies as the windsurf client the protocol expects", () => {
    const fields = [...iterFields(buildMetadata({ apiKey: "k", sessionId: "s", requestId: 42n, triggerId: "t" }))]
    expect(fields.find((f) => f.num === 1)!.value.toString()).toBe("windsurf")
    expect(fields.find((f) => f.num === 3)!.value.toString()).toBe("k")
    expect(fields.find((f) => f.num === 10)!.value.toString()).toBe("s")
    expect(fields.find((f) => f.num === 25)!.value.toString()).toBe("t")
  })

  test("omits the user_jwt field when there is none", () => {
    const fields = [...iterFields(buildMetadata({ apiKey: "k", sessionId: "s", requestId: 1n, triggerId: "t" }))]
    expect(fields.find((f) => f.num === 21)).toBeUndefined()
  })

  test("includes the user_jwt when supplied", () => {
    const fields = [
      ...iterFields(buildMetadata({ apiKey: "k", sessionId: "s", requestId: 1n, triggerId: "t", userJwt: "jwt" })),
    ]
    expect(fields.find((f) => f.num === 21)!.value.toString()).toBe("jwt")
  })
})

describe("pkce", () => {
  test("generates base64url verifiers of 32 bytes", () => {
    expect(generateVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("generates a distinct verifier each time", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateVerifier()))
    expect(seen.size).toBe(50)
  })

  test("derives the S256 challenge per RFC 7636 appendix B", async () => {
    await expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    )
  })
})

describe("authorize url", () => {
  test("targets the CLI login path with S256", () => {
    const url = new URL(authorizeUrl({ state: "st", challenge: "ch" }))
    expect(url.origin).toBe("https://app.devin.ai")
    expect(url.pathname).toBe("/auth/cli/continue")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBe("ch")
    expect(url.searchParams.get("state")).toBe("st")
    expect(url.searchParams.get("prompt")).toBe("select_account")
  })

  test("includes the loopback redirect only when there is one", () => {
    expect(authorizeUrl({ state: "s", challenge: "c", redirectUri: "http://127.0.0.1:1234/callback" })).toContain(
      `redirect_uri=${encodeURIComponent("http://127.0.0.1:1234/callback")}`,
    )
    expect(authorizeUrl({ state: "s", challenge: "c" })).not.toContain("redirect_uri")
  })

  test("uses the callback path the webapp's safe-redirect check requires", () => {
    expect(CALLBACK_PATH).toBe("/callback")
  })
})

describe("token prefix", () => {
  test("is the prefix the Devin CLI issues", () => {
    expect(TOKEN_PREFIX).toBe("devin-session-token$")
  })
})
