import { describe, expect, test } from "bun:test"
import * as zlib from "node:zlib"
import protobuf from "protobufjs"
import {
  encodeMessage,
  encodeString,
  encodeVarint,
  encodeVarintField,
  frameConnectStream,
  iterFields,
} from "../src/protocol/wire.ts"
import { buildMetadata } from "../src/protocol/metadata.ts"

/**
 * Cross-validation against an independent protobuf implementation.
 *
 * Every other suite encodes with `wire.ts` and decodes with `wire.ts`, so those
 * tests only prove the two halves agree with each other. If a field number or
 * the framing were wrong, they would agree and still be wrong.
 * `protobufjs` shares no code with this repository, so agreement with it is
 * real evidence that the wire format is genuine protobuf.
 *
 * What this does NOT prove: that Cognition still uses these field numbers.
 * That needs a real capture — see `test/fixtures/README.md`.
 *
 * Dev-only dependency; it never reaches the published package.
 */

const Root = new protobuf.Root()
const Price = new protobuf.Type("Price")
  .add(new protobuf.Field("type", 1, "string"))
  .add(new protobuf.Field("price", 4, "float"))
const ModelConfig = new protobuf.Type("ModelConfig")
  .add(new protobuf.Field("label", 1, "string"))
  .add(new protobuf.Field("disabled", 4, "bool"))
  .add(new protobuf.Field("context_window", 18, "uint64"))
  .add(new protobuf.Field("model_uid", 22, "string"))
const ChatPrompt = new protobuf.Type("ChatPrompt")
  .add(new protobuf.Field("source", 2, "uint32"))
  .add(new protobuf.Field("text", 3, "string"))
  .add(new protobuf.Field("tool_call_id", 7, "string"))
const GetChatMessage = new protobuf.Type("GetChatMessage")
  .add(new protobuf.Field("prompts", 3, "ChatPrompt", "repeated"))
  .add(new protobuf.Field("request_type", 7, "uint32"))
  .add(new protobuf.Field("cascade_id", 16, "string"))
  .add(new protobuf.Field("model_uid", 21, "string"))

Root.add(Price).add(ModelConfig).add(ChatPrompt).add(GetChatMessage)
Root.resolveAll()

const encodeWith = (type: string, value: object): Buffer => {
  const message = Root.lookupType(type)
  const invalid = message.verify(value)
  if (invalid) throw new Error(`${type}: ${invalid}`)
  return Buffer.from(message.encode(message.create(value)).finish())
}

/** tag byte(s) for a field number and wire type, as protobuf specifies. */
const tag = (field: number, wire: number): number[] => {
  const bytes: number[] = []
  let v = (field << 3) | wire
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return bytes
}

describe("wire format against an independent protobuf implementation", () => {
  test("a length-delimited string field is tagged per the spec", () => {
    const mine = encodeString(22, "swe-2-max")
    expect([...mine.subarray(0, 2)]).toEqual(tag(22, 2))
    // The length is a varint, so read it back through the decoder rather than
    // assuming a fixed width.
    const [field] = [...iterFields(mine)]
    expect(field!.num).toBe(22)
    expect(field!.wire).toBe(2)
    expect((field!.value as Buffer).toString("utf8")).toBe("swe-2-max")
  })

  test("varint bodies agree with protobufjs' writer across the range", () => {
    for (const value of [0, 1, 127, 128, 300, 16383, 16384, 1_000_000, 2 ** 31 - 1]) {
      // `uint32(v).finish()` returns the bare varint, with no field tag.
      const reference = [...protobuf.Writer.create().uint32(value).finish()]
      expect([...encodeVarint(value)]).toEqual(reference)
    }
  })

  test("a zero-valued varint field is present in the buffer", () => {
    // Absent and zero must be distinguishable to a decoder that reads the flag.
    const [field] = [...iterFields(encodeVarintField(9, 0))]
    expect(field!.num).toBe(9)
    expect(field!.wire).toBe(0)
    expect(field!.value).toBe(0n)
  })

  test("a ModelConfig written by protobufjs decodes with our field numbers", () => {
    const reference = encodeWith("ModelConfig", {
      label: "Opus",
      disabled: true,
      context_window: 200000,
      model_uid: "claude-opus-4-8",
    })

    const strings = new Map<number, string>()
    const varints = new Map<number, bigint>()
    for (const field of iterFields(reference)) {
      if (field.wire === 2 && Buffer.isBuffer(field.value)) strings.set(field.num, field.value.toString("utf8"))
      else if (field.wire === 0) varints.set(field.num, field.value as bigint)
    }

    // These are the exact numbers `decodeModelConfig` reads.
    expect(strings.get(1)).toBe("Opus")
    expect(strings.get(22)).toBe("claude-opus-4-8")
    expect(varints.get(4)).toBe(1n)
    expect(varints.get(18)).toBe(200000n)
  })

  test("our nested message encoding is byte-identical to protobufjs", () => {
    const reference = encodeWith("GetChatMessage", {
      model_uid: "swe-2-max",
      request_type: 5,
      cascade_id: "casc-123",
    })
    const mine = Buffer.concat([
      encodeVarintField(7, 5),
      encodeString(16, "casc-123"),
      encodeString(21, "swe-2-max"),
    ])
    expect(mine.equals(reference)).toBe(true)
  })

  test("repeated nested prompts decode with our field numbers", () => {
    const reference = encodeWith("GetChatMessage", {
      model_uid: "swe-2-max",
      prompts: [
        { source: 1, text: "first" },
        { source: 2, text: "second", tool_call_id: "call-1" },
      ],
    })

    const prompts = [...iterFields(reference)]
      .filter((f) => f.num === 3 && f.wire === 2 && Buffer.isBuffer(f.value))
      .map((f) =>
        [...iterFields(f.value as Buffer)].map((p) => [
          p.num,
          p.wire === 2 && Buffer.isBuffer(p.value) ? p.value.toString("utf8") : p.value,
        ]),
      )

    expect(prompts).toEqual([
      [
        [2, 1n],
        [3, "first"],
      ],
      [
        [2, 2n],
        [3, "second"],
        [7, "call-1"],
      ],
    ])
  })

  test("a float32 price field reads back exactly as the catalog decoder expects", () => {
    const reference = encodeWith("Price", { type: "input", price: 3.5 })
    const price = [...iterFields(reference)].find((f) => f.num === 4 && Buffer.isBuffer(f.value))
    expect(price).toBeDefined()
    expect((price!.value as Buffer).readFloatLE(0)).toBeCloseTo(3.5, 5)
  })
  test("our message envelope is a plain length-delimited field", () => {
    const body = encodeString(1, "hello")
    const wrapped = encodeMessage(3, body)
    expect([...wrapped.subarray(0, 1)]).toEqual(tag(3, 2))
    const [field] = [...iterFields(wrapped)]
    expect(field!.num).toBe(3)
    expect(field!.wire).toBe(2)
    expect((field!.value as Buffer).equals(body)).toBe(true)
  })

  test("the metadata builder emits the fields a reference decoder reads", () => {
    const bytes = buildMetadata({ apiKey: "k", sessionId: "s", requestId: 42n, triggerId: "t", userJwt: "j" })
    const strings = new Map<number, string>()
    const varints = new Map<number, bigint>()
    for (const f of iterFields(bytes)) {
      if (f.wire === 2 && Buffer.isBuffer(f.value)) strings.set(f.num, f.value.toString("utf8"))
      else if (f.wire === 0) varints.set(f.num, f.value as bigint)
    }
    // Field numbers buildMetadata writes.
    expect(strings.get(1)).toBe("windsurf")
    expect(strings.get(3)).toBe("k")
    expect(strings.get(10)).toBe("s")
    expect(strings.get(21)).toBe("j")
    expect(varints.get(9)).toBe(42n)
  })
})

describe("connect-rpc framing", () => {
  const header = (flags: number, length: number) => {
    const buffer = Buffer.alloc(5)
    buffer[0] = flags
    buffer.writeUInt32BE(length, 1)
    return buffer
  }

  test("the header is one flags byte plus a big-endian length", () => {
    const payload = Buffer.from("hello world")
    const framed = frameConnectStream(payload, false)
    expect(framed.subarray(0, 5).equals(header(0x00, payload.length))).toBe(true)
    expect(framed.subarray(5).equals(payload)).toBe(true)
  })

  test("gzip frames set the flag and decompress back to the payload", () => {
    const payload = Buffer.from(JSON.stringify({ error: "nope" }))
    const framed = frameConnectStream(payload, true)
    expect(framed[0]).toBe(0x01)
    expect(framed.readUInt32BE(1)).toBe(framed.length - 5)
    expect(zlib.gunzipSync(framed.subarray(5)).equals(payload)).toBe(true)
  })

  test("an end-of-stream trailer is a zero-length frame with the flag set", () => {
    const trailer = header(0x02, 0)
    expect(trailer[0]! & 0x02).toBeTruthy()
    expect(trailer.readUInt32BE(1)).toBe(0)
  })
})
