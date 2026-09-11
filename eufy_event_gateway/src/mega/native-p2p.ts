import { createCipheriv, createDecipheriv, randomBytes, type CipherGCM, type DecipherGCM } from "node:crypto";

import { cameraTopics, type NativeMqttMessage, NativeMqttTransport } from "./native-mqtt.js";

/** Native Thing MQTT protocol 2.2 framing used by the camera 302 channel. */
export function encodeNative302V22(options: {
  readonly localKey: string;
  readonly data: unknown;
  readonly timestamp?: number;
  readonly sequence?: number;
  readonly operation?: number;
}): Buffer {
  const key = keyBytes(options.localKey);
  const sequence = u32(options.sequence ?? 0);
  const source = randomBytes(4);
  const json = Buffer.from(JSON.stringify({
    data: options.data,
    protocol: 302,
    t: options.timestamp ?? Date.now(),
  }), "utf8");
  const encrypted = aesEcb(json, key, true);
  const tail = Buffer.concat([sequence, source, encrypted]);
  return Buffer.concat([Buffer.from("2.2", "ascii"), u32(crc32(tail)), tail]);
}

export function decodeNative302V22(frame: Uint8Array, localKey: string): {
  readonly data: unknown;
  readonly timestamp: number;
  readonly sequence: number;
} {
  const key = keyBytes(localKey);
  const bytes = Buffer.from(frame);
  if (bytes.length < 15 || bytes.subarray(0, 3).toString("ascii") !== "2.2") throw new Error("Invalid native MQTT 302 frame");
  const checksum = bytes.readUInt32BE(3);
  const tail = bytes.subarray(7);
  if (checksum !== crc32(tail)) {
    throw new Error("Invalid native MQTT 302 checksum");
  }
  const sequence = tail.readUInt32BE(0);
  const encrypted = tail.subarray(8);
  const value: unknown = JSON.parse(aesEcb(encrypted, key, false).toString("utf8"));
  if (!isRecord(value) || value.protocol !== 302 || typeof value.t !== "number" || !("data" in value)) {
    throw new Error("Invalid native MQTT 302 payload");
  }
  return { data: value.data, timestamp: value.t, sequence };
}

/** Native Thing MQTT protocol 2.3 uses AES-GCM and appends the nonce. */
export function encodeNative302V23(options: {
  readonly localKey: string;
  readonly data: unknown;
  readonly timestamp?: number;
  readonly sequence?: number;
  readonly operation?: number;
  readonly nonce?: Uint8Array;
}): Buffer {
  const key = keyBytes(options.localKey);
  const sequence = u16(options.sequence ?? 0);
  const operation = u16(options.operation ?? 0);
  const aad = Buffer.concat([key, sequence, operation, Buffer.from([0])]);
  const plaintext = Buffer.from(JSON.stringify({ data: options.data, protocol: 302, t: options.timestamp ?? Date.now() }), "utf8");
  const nonce = Buffer.from(options.nonce ?? randomBytes(12));
  if (nonce.length !== 12) throw new Error("Native MQTT GCM nonce must be 12 bytes");
  const cipher = createCipheriv(`aes-${key.length * 8}-gcm`, key, nonce) as CipherGCM;
  cipher.setAAD(aad);
  return Buffer.concat([key, sequence, operation, Buffer.from([0]), nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function decodeNative302V23(frame: Uint8Array, localKey: string): {
  readonly data: unknown;
  readonly timestamp: number;
  readonly sequence: number;
  readonly operation: number;
} {
  const key = keyBytes(localKey);
  const bytes = Buffer.from(frame);
  const prefixLength = key.length;
  if (bytes.length < prefixLength + 8 + 12 + 16 || !bytes.subarray(0, prefixLength).equals(key)) throw new Error("Invalid native MQTT 302 key prefix");
  const sequence = bytes.readUInt16BE(prefixLength);
  const operation = bytes.readUInt16BE(prefixLength + 2);
  if (bytes[prefixLength + 4] !== 0) throw new Error("Invalid native MQTT 302 version marker");
  const nonce = bytes.subarray(prefixLength + 5, prefixLength + 17);
  const ciphertext = bytes.subarray(prefixLength + 17, -16);
  const tag = bytes.subarray(-16);
  const decipher = createDecipheriv(`aes-${key.length * 8}-gcm`, key, nonce) as DecipherGCM;
  decipher.setAAD(Buffer.concat([key, u16(sequence), u16(operation), Buffer.from([0])]));
  decipher.setAuthTag(tag);
  const value: unknown = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  if (!isRecord(value) || value.protocol !== 302 || typeof value.t !== "number" || !("data" in value)) throw new Error("Invalid native MQTT 302 payload");
  return { data: value.data, timestamp: value.t, sequence, operation };
}

export interface NativeP2PConnectOptions {
  readonly remoteId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly skills?: string;
  readonly traceId: string;
  readonly timeoutMilliseconds?: number;
  readonly lanMode?: number;
  readonly preconnectEnabled?: number;
  readonly connectSession?: string;
}

export function nativeConnectV3(options: NativeP2PConnectOptions): Record<string, unknown> {
  return {
    cmd: "connect_v3",
    args: {
      remote_id: options.remoteId,
      dev_id: options.deviceId,
      token: options.token,
      skills: options.skills ?? "",
      trace_id: options.traceId,
      timeout_ms: options.timeoutMilliseconds ?? 30_000,
      lan_mode: options.lanMode ?? 0,
      preconnect_enable: options.preconnectEnabled ?? 0,
      connect_session: options.connectSession ?? "",
    },
  };
}

/** The first packet sent on a Thing 302 channel asks the camera for its
 * signalling capabilities. These are kept as plain builders so the gateway
 * can test the protocol without opening a broker connection. */
export function nativeSignalQuery(): Record<string, unknown> {
  return { reqType: "sigQry" };
}

export function nativeCameraTransactionId(deviceId: string, now = Date.now()): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(deviceId) || !Number.isSafeInteger(now)) throw new Error("Invalid native camera transaction id input");
  return `ipc_p2p_android_${deviceId}_${now}`;
}

export interface NativeCameraRtcConfig {
  readonly p2pId: string;
  readonly p2pKey: string;
  readonly initStr: string;
  readonly iceServers: readonly unknown[];
  readonly session: unknown;
  readonly tcpRelay: unknown;
  readonly udpRelay: unknown;
}

/** Validate only the stable fields shared by the mobile SDK's RTC config
 * response. The relay/session objects are deliberately opaque: Eufy has
 * changed their shape between camera firmware generations. */
export function parseNativeCameraRtcConfig(value: unknown): NativeCameraRtcConfig {
  if (!isRecord(value)) throw new Error("Native camera RTC config is not an object");
  const config = isRecord(value.p2pConfig) ? value.p2pConfig : value;
  const p2pId = stringValue(value.p2pId) ?? stringValue(config.p2pId);
  const p2pKey = stringValue(config.p2pKey);
  const initStr = stringValue(config.initStr);
  if (!p2pId || !p2pKey || !initStr) throw new Error("Native camera RTC config is incomplete");
  return {
    p2pId,
    p2pKey,
    initStr,
    iceServers: Array.isArray(config.ices) ? config.ices : [],
    session: config.session ?? null,
    tcpRelay: config.tcpRelay ?? null,
    udpRelay: config.udpRelay ?? null,
  };
}

export interface NativeOfferMessageOptions {
  readonly uid: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly sdp: string;
  readonly iceServers: unknown;
  readonly tcpToken?: unknown;
  readonly logConfig?: unknown;
}

export function nativeOfferMessage(options: NativeOfferMessageOptions): Record<string, unknown> {
  return {
    header: {
      type: "offer", from: options.uid, to: options.deviceId, sessionid: options.sessionId,
      moto_id: "", path: "mqtt", trace_id: options.traceId, is_pre: 0, p2p_skill: 1635, security_level: 3,
    },
    msg: {
      sdp: options.sdp, preconnect: true, token: options.iceServers,
      tcp_token: options.tcpToken ?? "", log: options.logConfig ?? {},
    },
  };
}

export function nativeCandidateMessage(candidate: string): Record<string, unknown> {
  return { header: { type: "candidate" }, msg: { candidate } };
}

export function nativeDisconnectMessage(reason = "client_close"): Record<string, unknown> {
  return { header: { type: "disconnect" }, msg: { close_reason: reason, close_reason_local: 0 } };
}

export function nativeSdpOffer(uid: string, sessionId: string, epochSeconds: number, iceUfrag: string, icePassword: string, aesKey: Uint8Array): string {
  return ["v=0", `o=- ${epochSeconds} 1 IN IP4 127.0.0.1`, "s=-", "t=0 0", "a=group:BUNDLE imm0", `a=msid-semantic: WMS ${sessionId}`, "m=application 9 imm 6001", "c=IN IP4 0.0.0.0", "a=rtcp:9 IN IP4 0.0.0.0", `a=ice-ufrag:${iceUfrag}`, `a=ice-pwd:${icePassword}`, "a=ice-options:trickle", `a=aes-key:${Buffer.from(aesKey).toString("hex")}`, "a=mid:imm0", "a=rtpmap:6001 AES/KCP 330", `a=ssrc:0 cname:${uid}`, ""].join("\r\n");
}

/** The MQTT-backed signalling part of a native P2P session. */
export class NativeP2PSignaller {
  constructor(
    private readonly mqtt: NativeMqttTransport,
    private readonly deviceId: string,
    private readonly localKey: string,
  ) {}

  start(onMessage: (message: NativeMqttMessage) => void): void {
    const topics = cameraTopics(this.deviceId);
    this.mqtt.on("message", onMessage);
    this.mqtt.subscribe(topics.incoming);
  }

  send(message: Record<string, unknown>, sequence = 0, operation = 0): void {
    const topic = cameraTopics(this.deviceId).outgoing;
    this.mqtt.publish(topic, encodeNative302V22({ localKey: this.localKey, data: message, sequence, operation }));
  }

  sendQuery(sequence = 0): void { this.send(nativeSignalQuery(), sequence); }

  sendOffer(options: NativeOfferMessageOptions, sequence = 1): void { this.send(nativeOfferMessage(options), sequence); }

  decode(message: NativeMqttMessage): { readonly data: unknown; readonly timestamp: number; readonly sequence: number } | null {
    const topics = cameraTopics(this.deviceId);
    if (message.topic !== topics.incoming) return null;
    return decodeNative302V22(message.payload, this.localKey);
  }
}

function aesEcb(value: Uint8Array, key: Buffer, encrypt: boolean): Buffer {
  const cipher = encrypt ? createCipheriv(`aes-${key.length * 8}-ecb`, key, null) : createDecipheriv(`aes-${key.length * 8}-ecb`, key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(value), cipher.final()]);
}

function keyBytes(value: string): Buffer {
  const key = Buffer.from(value, "utf8");
  if (![16, 24, 32].includes(key.length)) throw new Error("Native MQTT local key must be 16, 24, or 32 bytes");
  return key;
}

function u16(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error("Native MQTT frame field is out of range");
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
}

function u32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value >>> 0);
  return result;
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
