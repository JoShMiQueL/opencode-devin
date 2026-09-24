/**
 * Manual protobuf + Connect-RPC streaming envelope helpers.
 *
 * Ported from pi-devin-auth (MIT, Copyright (c) 2026 nmzpy).
 * Connect-RPC streaming wire format (HTTPS POST body):
 *   flags 1byte | length 4B BE | payload
 *   flags bit 0x01 = gzip-compressed
 *   flags bit 0x02 = end-of-stream (trailer frame)
 */
export declare function encodeVarint(value: number | bigint): Buffer;
export declare function encodeTag(fieldNum: number, wire: number): Buffer;
export declare function encodeString(fieldNum: number, s: string): Buffer;
export declare function encodeMessage(fieldNum: number, body: Buffer): Buffer;
export declare function encodeVarintField(fieldNum: number, v: number | bigint): Buffer;
export declare function encodeTimestampBody(): Buffer;
export declare function decodeVarint(buf: Buffer, offset: number): [bigint, number];
export interface ProtoField {
    num: number;
    wire: number;
    value: bigint | Buffer;
}
export declare function iterFields(buf: Buffer): Generator<ProtoField>;
export declare function frameConnectStream(body: Buffer, compress?: boolean): Buffer;
