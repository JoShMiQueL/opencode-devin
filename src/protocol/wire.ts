/**
 * Protobuf wire-format encoding and Connect-RPC streaming envelope.
 *
 * Connect-RPC streaming frame layout (HTTPS POST body):
 *
 *   flags 1 byte | length 4 bytes BE | payload
 *
 *   - flags bit 0x01: payload is gzip-compressed
 *   - flags bit 0x02: end-of-stream trailer frame (JSON `{error}` or empty)
 *
 * Protocol reverse-engineered from the Windsurf language_server and the Devin
 * CLI; originally ported from pi-devin-auth (MIT, Copyright (c) 2026 nmzpy).
 */

import * as zlib from "node:zlib"

export type WireType = 0 | 1 | 2 | 5

export interface ProtoField {
  readonly num: number
  readonly wire: WireType
  readonly value: bigint | Buffer
}

export function encodeVarint(value: bigint | number): Buffer {
  let v = BigInt(value)
  if (v < 0n) throw new RangeError(`encodeVarint: negative input not supported (got ${value})`)
  const bytes: number[] = []
  while (v > 0x7fn) {
    bytes.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  bytes.push(Number(v))
  return Buffer.from(bytes)
}

export function encodeTag(fieldNum: number, wire: WireType): Buffer {
  return encodeVarint((fieldNum << 3) | wire)
}

export function encodeString(fieldNum: number, value: string): Buffer {
  const buf = Buffer.from(value, "utf8")
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(buf.length), buf])
}

export function encodeMessage(fieldNum: number, body: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(body.length), body])
}

export function encodeVarintField(fieldNum: number, value: bigint | number): Buffer {
  return Buffer.concat([encodeTag(fieldNum, 0), encodeVarint(value)])
}

export function encodeTimestampBody(): Buffer {
  const now = Date.now()
  const seconds = Math.floor(now / 1000)
  const nanos = (now % 1000) * 1_000_000
  return Buffer.concat([
    encodeVarintField(1, seconds),
    nanos > 0 ? encodeVarintField(2, nanos) : Buffer.alloc(0),
  ])
}

export function decodeVarint(buf: Buffer, offset: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  let i = offset
  while (i < buf.length) {
    const byte = buf[i++]!
    result |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return [result, i]
    shift += 7n
  }
  throw new Error("truncated varint")
}

/** Iterate the protobuf fields of a message in wire order. */
export function* iterFields(buf: Buffer): Generator<ProtoField> {
  let i = 0
  while (i < buf.length) {
    const [tagBig, afterTag] = decodeVarint(buf, i)
    i = afterTag
    const tag = Number(tagBig)
    const num = tag >> 3
    const wire = (tag & 0x7) as WireType
    if (wire === 0) {
      const [value, afterValue] = decodeVarint(buf, i)
      i = afterValue
      yield { num, wire, value }
    } else if (wire === 1) {
      if (i + 8 > buf.length) return
      yield { num, wire, value: buf.slice(i, i + 8) }
      i += 8
    } else if (wire === 2) {
      const [lengthBig, afterLength] = decodeVarint(buf, i)
      i = afterLength
      const length = Number(lengthBig)
      if (length < 0 || i + length > buf.length) return
      yield { num, wire, value: buf.slice(i, i + length) }
      i += length
    } else if (wire === 5) {
      if (i + 4 > buf.length) return
      yield { num, wire, value: buf.slice(i, i + 4) }
      i += 4
    } else {
      return
    }
  }
}

/** Wrap a protobuf message into a Connect-RPC streaming request frame. */
export function frameConnectStream(body: Buffer, compress = true): Buffer {
  let payload = body
  let flags = 0
  if (compress) {
    payload = zlib.gzipSync(body)
    flags |= 0x01
  }
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}
