/**
 * GetCascadeModelConfigs — per-account model catalog from Cognition.
 * Ported from pi-devin-auth (MIT).
 */
import * as crypto from "crypto";
import { encodeMessage, iterFields } from "./wire.js";
import { buildMetadata } from "./metadata.js";
import { getCachedUserJwt } from "./auth.js";
const DEFAULT_HOST = "https://server.codeium.com";
const CATALOG_TTL_MS = 10 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 10_000;
let cached = null;
let inFlight = null;
let inFlightKey = null;
function flightKey(apiKey, host) {
    return `${host}\x1f${apiKey}`;
}
async function fetchCatalog(apiKey, host, signal) {
    const userJwt = await getCachedUserJwt(apiKey, host, signal);
    const metadata = buildMetadata({
        apiKey,
        userJwt,
        sessionId: crypto.randomUUID(),
        requestId: BigInt(Date.now()),
        triggerId: crypto.randomUUID(),
    });
    const reqBody = encodeMessage(1, metadata);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`catalog timeout (${CATALOG_FETCH_TIMEOUT_MS}ms)`)), CATALOG_FETCH_TIMEOUT_MS);
    const cleanup = signal
        ? (() => {
            if (signal.aborted)
                ac.abort(signal.reason);
            const fwd = () => ac.abort(signal.reason);
            signal.addEventListener("abort", fwd, { once: true });
            return () => signal.removeEventListener("abort", fwd);
        })()
        : () => { };
    let resp;
    try {
        resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs`, {
            method: "POST",
            headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
            body: reqBody,
            signal: ac.signal,
        });
    }
    finally {
        clearTimeout(timer);
        cleanup();
    }
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`GetCascadeModelConfigs HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const byUid = new Map();
    for (const f of iterFields(buf)) {
        if (f.num !== 1 || f.wire !== 2 || !Buffer.isBuffer(f.value))
            continue;
        let label = "";
        let modelUid = "";
        let disabled = false;
        let contextWindow = 0;
        let pricing;
        let capabilities;
        for (const sf of iterFields(f.value)) {
            if (sf.num === 1 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
                label = sf.value.toString("utf8");
            }
            else if (sf.num === 4 && sf.wire === 0) {
                disabled = sf.value === 1n;
            }
            else if (sf.num === 18 && sf.wire === 0) {
                contextWindow = Number(sf.value);
            }
            else if (sf.num === 22 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
                modelUid = sf.value.toString("utf8");
            }
            else if (sf.num === 30 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
                // Capabilities message: #1 = display name, #2 (repeated) = feature { #1 name, #2 { #1 enabled, #2 value } }
                capabilities = [];
                for (const cf of iterFields(sf.value)) {
                    if (cf.num === 2 && cf.wire === 2 && Buffer.isBuffer(cf.value)) {
                        let fname = "";
                        let fenabled = false;
                        let fvalue;
                        for (const xf of iterFields(cf.value)) {
                            if (xf.num === 1 && xf.wire === 2 && Buffer.isBuffer(xf.value)) {
                                fname = xf.value.toString("utf8");
                            }
                            else if (xf.num === 1 && xf.wire === 0) {
                                fenabled = xf.value === 1n;
                            }
                            else if (xf.num === 2 && xf.wire === 2 && Buffer.isBuffer(xf.value)) {
                                fvalue = xf.value.toString("utf8");
                            }
                        }
                        if (fname)
                            capabilities.push({ name: fname, enabled: fenabled, value: fvalue });
                    }
                }
            }
            else if (sf.num === 32 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
                // Pricing message (repeated): #1 = type, #3 = unit, #4 = price (float32 or nested), #7 = desc
                if (!pricing)
                    pricing = { input: 0, cachedInput: 0, output: 0 };
                let ptype = "";
                let pprice = 0;
                for (const pf of iterFields(sf.value)) {
                    if (pf.num === 1 && pf.wire === 2 && Buffer.isBuffer(pf.value)) {
                        ptype = pf.value.toString("utf8").toLowerCase();
                    }
                    else if (pf.num === 4 && Buffer.isBuffer(pf.value) && pf.value.length === 4) {
                        pprice = pf.value.readFloatLE(0);
                    }
                }
                if (ptype.includes("input") && !ptype.includes("cached"))
                    pricing.input = pprice;
                else if (ptype.includes("cached"))
                    pricing.cachedInput = pprice;
                else if (ptype.includes("output"))
                    pricing.output = pprice;
            }
        }
        if (modelUid.length > 0) {
            // Extract effort level from UID suffix
            const effortMatch = modelUid.match(/-(none|low|medium|high|xhigh|max)$/);
            const effortLevel = effortMatch?.[1];
            const baseModelUid = effortLevel ? modelUid.slice(0, -effortLevel.length - 1) : undefined;
            byUid.set(modelUid, {
                modelUid, label: label || modelUid, disabled, contextWindow,
                pricing, capabilities, baseModelUid, effortLevel,
            });
        }
    }
    return { byUid, fetchedAt: Date.now(), apiKey, host };
}
export async function getCachedCatalog(apiKey, host = DEFAULT_HOST, signal) {
    if (cached && cached.apiKey === apiKey && cached.host === host) {
        if (Date.now() - cached.fetchedAt < CATALOG_TTL_MS)
            return cached;
    }
    const key = flightKey(apiKey, host);
    if (inFlight && inFlightKey === key) {
        try {
            return await inFlight;
        }
        catch {
            return null;
        }
    }
    const promise = fetchCatalog(apiKey, host, signal);
    inFlight = promise;
    inFlightKey = key;
    try {
        const result = await promise;
        cached = result;
        return result;
    }
    catch {
        return null;
    }
    finally {
        if (inFlight === promise) {
            inFlight = null;
            inFlightKey = null;
        }
    }
}
export function clearCachedCatalog() {
    cached = null;
    inFlight = null;
    inFlightKey = null;
}
export class ModelNotAvailableError extends Error {
    modelUid;
    label;
    reason;
    constructor(modelUid, label, reason) {
        super(reason === "disabled"
            ? `Model "${label}" (uid=${modelUid}) is not enabled for your Cognition account tier.`
            : `Model uid "${modelUid}" is not listed in the Cognition catalog for your account.`);
        this.modelUid = modelUid;
        this.label = label;
        this.reason = reason;
        this.name = "ModelNotAvailableError";
    }
}
