import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export const RELAY_HANDSHAKE = 0xf4;
export const RELAY_KEEPALIVE = 0xf5;
export const RELAY_MEDIA = 0xf6;

export function relayFrame(magic: number, body: Uint8Array): Buffer { const data = Buffer.from(body); if (data.length > 65_535) throw new Error("Native relay frame is too large"); const out = Buffer.alloc(4 + data.length); out[0] = magic; out[1] = 0; out.writeUInt16BE(data.length, 2); data.copy(out, 4); return out; }
export function keepaliveFrame(): Buffer { return relayFrame(RELAY_KEEPALIVE, Buffer.alloc(0)); }
export function mediaFrame(mediaKey: Uint8Array, segment: Uint8Array): Buffer { const tag = createHmac("sha1", Buffer.from(mediaKey)).update(segment).digest(); const inner = Buffer.alloc(4 + segment.length + tag.length); inner.writeUInt16BE(7, 0); inner.writeUInt16BE(segment.length + tag.length, 2); Buffer.from(segment).copy(inner, 4); tag.copy(inner, 4 + segment.length); return relayFrame(RELAY_MEDIA, inner); }
export function unwrapMediaFrame(mediaKey: Uint8Array, payload: Uint8Array): Buffer { const data = Buffer.from(payload); if (data.length < 24 || data.readUInt16BE(0) !== 7) throw new Error("Invalid native media frame"); const length = data.readUInt16BE(2); if (length < 20 || length + 4 > data.length) throw new Error("Invalid native media frame length"); const segment = data.subarray(4, 4 + length - 20); const expected = createHmac("sha1", Buffer.from(mediaKey)).update(segment).digest(); if (!expected.equals(data.subarray(4 + length - 20, 4 + length))) throw new Error("Invalid native media frame tag"); return segment; }

export function encryptNativeRecord(key: Uint8Array, plaintext: Uint8Array): Buffer { const iv = randomBytes(16); const cipher = createCipheriv("aes-128-cbc", Buffer.from(key), iv); return Buffer.concat([iv, cipher.update(Buffer.from(plaintext)), cipher.final()]); }
export function decryptNativeRecord(key: Uint8Array, record: Uint8Array): Buffer { const data = Buffer.from(record); if (data.length < 32 || data.length % 16) throw new Error("Invalid native media record"); const decipher = createDecipheriv("aes-128-cbc", Buffer.from(key), data.subarray(0, 16)); return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]); }

export function extractNativeMediaPackets(record: Uint8Array): Buffer[] { const data = Buffer.from(record); const packets: Buffer[] = []; let cursor = 0; while (true) { const marker = data.indexOf(Buffer.from([0, 0xff, 0x50, 0x3c]), cursor); if (marker < 0) return packets; const header = marker - 16; if (header >= 4) { const length = data.readUInt32LE(header - 4); if (length >= 20 && length <= 4 * 1024 * 1024 && header + length <= data.length) { packets.push(data.subarray(header, header + length)); cursor = header + length; continue; } } cursor = marker + 4; } }

export function mediaPacketPayload(packet: Uint8Array): Buffer { const data = Buffer.from(packet); if (data.length < 20) throw new Error("Invalid native media packet"); return data.subarray(20); }

export function nativeAuthCredential(devicePassword: string, localKey: string): string { return createHash("md5").update(`${devicePassword}||${localKey}`).digest("hex"); }

export interface NativeRelayToken { readonly urls: readonly string[]; readonly username: string; readonly credential: string; readonly sessionId: string; readonly raw: Record<string, unknown>; }
export function parseNativeRelayToken(value: unknown): NativeRelayToken { if (!isRecord(value)) throw new Error("Native relay token is invalid"); const urls = (Array.isArray(value.urls) ? value.urls : Array.isArray(value.urlsEx) ? value.urlsEx : []).filter((v): v is string => typeof v === "string" && v.length > 0); const username = typeof value.username === "string" ? value.username : ""; const credential = typeof value.credential === "string" ? value.credential : ""; const sessionId = typeof value.sessionId === "string" ? value.sessionId : ""; if (!urls.length || !username || !credential || !sessionId) throw new Error("Native relay token is incomplete"); return { urls, username, credential, sessionId, raw: { ...value } }; }
export function relayEndpoint(token: NativeRelayToken): { readonly host: string; readonly port: number } { const url = token.urls.find((v) => v.startsWith("tcp4:")) ?? token.urls[0]!; const value = url.replace(/^tcp[46]:/, ""); const ipv6 = value.match(/^\[([^\]]+)\](?::(\d+))?$/); if (ipv6) return { host: ipv6[1]!, port: ipv6[2] ? Number(ipv6[2]) : 1443 }; const separator = value.lastIndexOf(":"); const hasPort = separator > 0 && /^\d+$/.test(value.slice(separator + 1)); return { host: hasPort ? value.slice(0, separator) : value, port: hasPort ? Number(value.slice(separator + 1)) : 1443 }; }
export function relayHandshakeSignature(credential: string, expireTimestamp: string, deviceId: string, sessionId: string, uid: string, ...tail: string[]): string { const key = Buffer.from(credential).subarray(0, 64); const padded = Buffer.concat([key, Buffer.alloc(Math.max(0, 64 - key.length))]); return createHmac("sha256", padded).update([expireTimestamp, deviceId, sessionId, uid, ...tail].join(":"), "utf8").digest("hex"); }
export function relayAuthRequest(deviceId: string, uid: string, random: string): Buffer { return Buffer.from(JSON.stringify({ clientType: 1, method: "request", devId: deviceId, uId: uid, authorization: `random=${random}` }), "utf8"); }
export function relayAuthAck(deviceId: string, uid: string, signature: string): Buffer { return Buffer.from(JSON.stringify({ clientType: 1, method: "ack", devId: deviceId, uId: uid, statuscode: 200, authorization: `signature=${signature}` }), "utf8"); }
export function authorizationField(authorization: string, key: string): string { return authorization.split(",").find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1) ?? ""; }

export function assembleRelayHandshake(index: number, key: Uint8Array, iv: Uint8Array, sessionId: string, username: string, json: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(iv));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(json)), cipher.final()]);
  const tlv = (type: number, value: Uint8Array) => { const result = Buffer.alloc(4 + value.length); result.writeUInt16BE(type, 0); result.writeUInt16BE(value.length, 2); Buffer.from(value).copy(result, 4); return result; };
  const body = Buffer.concat([Buffer.from([0, 1, 0, 2]), Buffer.from([index >> 8, index & 255, 0, 0]), tlv(2, iv), tlv(3, Buffer.from(sessionId)), tlv(4, Buffer.from(username)), Buffer.from([0, 0, 0, 0, 7, encrypted.length >> 8, encrypted.length & 255]), encrypted]);
  const header = Buffer.from([0xf4, 0, (body.length + 36) >> 8, (body.length + 36) & 255]);
  const signed = Buffer.concat([header, body, Buffer.from([0, 8, 0, 32])]);
  return Buffer.concat([signed, createHmac("sha256", Buffer.from(key)).update(signed).digest()]);
}

export function parseRelayHandshake(key: Uint8Array, payload: Uint8Array): Record<string, unknown> {
  const b = Buffer.from(payload); let cursor = 8; let iv: Buffer | null = null;
  while (cursor + 4 <= b.length) { const type = b.readUInt16BE(cursor); if (type === 0 && b.readUInt16BE(cursor + 2) === 0) { cursor += 4; break; } const len = b.readUInt16BE(cursor + 2); if (cursor + 4 + len > b.length) throw new Error("Invalid native relay handshake"); if (type === 2) iv = b.subarray(cursor + 4, cursor + 4 + len); cursor += 4 + len; }
  if (!iv || cursor + 3 > b.length || b[cursor] !== 7) throw new Error("Invalid native relay encrypted section"); const len = b.readUInt16BE(cursor + 1); const decipher = createDecipheriv("aes-128-cbc", Buffer.from(key), iv); const plain = Buffer.concat([decipher.update(b.subarray(cursor + 3, cursor + 3 + len)), decipher.final()]); const value: unknown = JSON.parse(plain.toString("utf8")); if (!isRecord(value)) throw new Error("Invalid native relay handshake JSON"); return value;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
