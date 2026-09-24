/**
 * GetUserJwt — mint short-lived user_jwt for chat RPCs.
 * Ported from pi-devin-auth (MIT).
 */
import * as crypto from "crypto";
import { encodeMessage, iterFields } from "./wire.js";
import { buildMetadata } from "./metadata.js";
const DEFAULT_HOST = "https://server.codeium.com";
const MINT_TIMEOUT_MS = 30_000;
export class CloudAuthError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "CloudAuthError";
    }
}
function anySignal(signals) {
    const builtin = AbortSignal.any;
    if (typeof builtin === "function")
        return builtin(signals);
    const controller = new AbortController();
    const onAbort = (reason) => {
        if (!controller.signal.aborted)
            controller.abort(reason);
    };
    for (const s of signals) {
        if (s.aborted) {
            onAbort(s.reason);
            break;
        }
        s.addEventListener("abort", () => onAbort(s.reason), { once: true });
    }
    return controller.signal;
}
export async function mintUserJwt(apiKey, host = DEFAULT_HOST, signal) {
    const metadata = buildMetadata({
        apiKey,
        sessionId: crypto.randomUUID(),
        requestId: BigInt(Date.now()),
        triggerId: crypto.randomUUID(),
    });
    const req = encodeMessage(1, metadata);
    const timeoutSignal = AbortSignal.timeout(MINT_TIMEOUT_MS);
    const combinedSignal = signal ? anySignal([signal, timeoutSignal]) : timeoutSignal;
    const resp = await fetch(`${host.replace(/\/$/, "")}/exa.auth_pb.AuthService/GetUserJwt`, {
        method: "POST",
        headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
        body: req,
        signal: combinedSignal,
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!resp.ok) {
        throw new CloudAuthError(`GetUserJwt HTTP ${resp.status}: ${buf.toString("utf8").slice(0, 400)}`, resp.status);
    }
    let jwt = null;
    for (const f of iterFields(buf)) {
        if (f.num === 1 && f.wire === 2 && Buffer.isBuffer(f.value)) {
            const s = f.value.toString("utf8");
            if (/^eyJ[A-Za-z0-9_-]{10,}={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}$/.test(s)) {
                jwt = s;
                break;
            }
        }
    }
    if (!jwt) {
        throw new CloudAuthError(`GetUserJwt 200 but no field-1 JWT found (${buf.length} bytes)`);
    }
    let expiresAt = Math.floor(Date.now() / 1000) + 600;
    try {
        const parts = jwt.split(".");
        const pad = (s) => s + "=".repeat((4 - (s.length % 4)) % 4);
        const payload = JSON.parse(Buffer.from(pad(parts[1]).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        if (typeof payload.exp === "number")
            expiresAt = payload.exp;
    }
    catch { /* fallback */ }
    return { jwt, expiresAt };
}
let jwtCache = null;
const jwtInFlight = new Map();
let jwtCacheEpoch = 0;
export async function getCachedUserJwt(apiKey, host = DEFAULT_HOST, signal) {
    const now = Math.floor(Date.now() / 1000);
    if (jwtCache && jwtCache.apiKey === apiKey && jwtCache.host === host && jwtCache.expiresAt > now + 60) {
        return jwtCache.jwt;
    }
    const key = `${host}\x1f${apiKey}`;
    const existing = jwtInFlight.get(key);
    if (existing)
        return (await existing).jwt;
    const promise = mintUserJwt(apiKey, host, signal);
    jwtInFlight.set(key, promise);
    const epochAtStart = jwtCacheEpoch;
    try {
        const minted = await promise;
        if (jwtCacheEpoch === epochAtStart) {
            jwtCache = { jwt: minted.jwt, expiresAt: minted.expiresAt, apiKey, host };
        }
        return minted.jwt;
    }
    finally {
        jwtInFlight.delete(key);
    }
}
export function clearCachedUserJwt() {
    jwtCache = null;
    jwtInFlight.clear();
    jwtCacheEpoch++;
}
