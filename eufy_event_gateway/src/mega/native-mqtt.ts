import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

import type { MegaMqttInfo } from "./types.js";

export interface NativeMqttMessage {
  readonly topic: string;
  readonly payload: Buffer;
}

export interface NativeCameraTopics {
  readonly outgoing: string;
  readonly incoming: string;
}

export interface NativeMqttCredentials {
  readonly username?: string;
  readonly password?: string;
  /** Native Thing brokers have historically presented a certificate whose name
   * does not match the regional host. Keep this opt-in and explicit. */
  readonly rejectUnauthorized?: boolean;
}

export interface NativeMqttEndpoint {
  readonly endpointAddress: string;
  readonly certificatePem?: string;
  readonly privateKey?: string;
  readonly rootCaPem?: string;
}

/** Credentials used by the Thing SDK's standard (non-AIoT) MQTT service.
 * The values come from the mobile base-config response and are intentionally
 * passed in rather than persisted in diagnostics. */
export interface ThingMqttConfig {
  readonly appId: string;
  readonly partnerIdentity: string;
  readonly chKey: string;
  readonly uid: string;
  readonly token: string;
  readonly ecode: string;
  readonly broker: string;
  readonly port?: number;
  readonly deviceFingerprint: string;
}

export function thingMqttCredentials(config: ThingMqttConfig): { readonly clientId: string; readonly username: string; readonly password: string } {
  const uid = `${config.deviceFingerprint}_${md5(config.uid + "sdkfasodifca")}`;
  const clientId = `com.tuya.smartlife_mb_${uid}_DEFAULT`;
  const md5Base64 = (value: string) => createHash("md5").update(value).digest("base64");
  const suffixSource = md5Base64(md5Base64(config.appId) + config.ecode);
  const username = `${config.partnerIdentity}_v1_${config.appId}${config.chKey}_mb_${config.token}${suffixSource.slice(-16)}`;
  const password = md5Base64(config.ecode).slice(8, 24);
  return { clientId, username, password };
}

function md5(value: string): string { return createHash("md5").update(value).digest("hex"); }

export function nativeMqttClientId(info: Pick<MegaMqttInfo, "appName" | "userId" | "endpointAddress">, mqttUuid: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(mqttUuid)) throw new Error("Invalid native MQTT client identifier");
  const endpoint = info.endpointAddress.replaceAll("-", "");
  return `android-${info.appName}-${info.userId}-${mqttUuid}${endpoint}`;
}

/** Topics used by the Thing camera MQTT server for a device's 302 channel. */
export function cameraTopics(deviceId: string): NativeCameraTopics {
  if (!/^[A-Za-z0-9._:-]+$/.test(deviceId)) throw new Error("Invalid Eufy device identifier");
  return { outgoing: `smart/mb/out/${deviceId}`, incoming: `smart/mb/in/${deviceId}` };
}

/**
 * Small MQTT 3.1.1 transport for the credentials returned by Mega.
 *
 * The native app uses mutual TLS and MQTT only as the signalling plane. P2P
 * session JSON and media negotiation remain above this class, so this module
 * has no web-portal or expiring-PIN dependency.
 */
export class NativeMqttTransport extends EventEmitter {
  #socket: TLSSocket | null = null;
  #buffer = Buffer.alloc(0);
  #packetId = 1;

  constructor(private readonly info: NativeMqttEndpoint & Partial<MegaMqttInfo>, private readonly clientId: string, private readonly credentials: NativeMqttCredentials = {}) {
    super();
  }

  get connected(): boolean {
    return this.#socket?.writable === true;
  }

  connect(): Promise<void> {
    if (this.#socket) return Promise.resolve();
    const endpoint = parseEndpoint(this.info.endpointAddress);
    return new Promise((resolve, reject) => {
      const socket = tlsConnect({
        host: endpoint.host,
        port: endpoint.port,
        servername: endpoint.host,
        ...(this.info.certificatePem ? { cert: this.info.certificatePem } : {}),
        ...(this.info.privateKey ? { key: this.info.privateKey } : {}),
        ...(this.info.rootCaPem ? { ca: this.info.rootCaPem } : {}),
        rejectUnauthorized: this.credentials.rejectUnauthorized ?? true,
      });
      this.#socket = socket;
      let settled = false;
      const fail = (error: Error) => {
        if (!settled) { settled = true; reject(error); }
        this.emit("error", error);
      };
      socket.once("secureConnect", () => {
        this.#write(packet(0x10, connectPayload(this.clientId, this.credentials.username ?? this.info.thingName ?? "", this.credentials.password)));
      });
      socket.on("data", (chunk: Buffer) => {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        while (true) {
          const decoded = decodePacket(this.#buffer);
          if (!decoded) break;
          this.#buffer = this.#buffer.subarray(decoded.bytes);
          if (decoded.type === 2) {
            if (decoded.body[1] !== 0) { fail(new Error(`MQTT CONNACK rejected (${decoded.body[1]})`)); return; }
            if (!settled) { settled = true; resolve(); }
            this.emit("connect");
          } else if (decoded.type === 3) {
            const topicLength = decoded.body.readUInt16BE(0);
            const topic = decoded.body.subarray(2, 2 + topicLength).toString("utf8");
            const offset = 2 + topicLength + ((decoded.flags & 0x06) ? 2 : 0);
            this.emit("message", { topic, payload: decoded.body.subarray(offset) } satisfies NativeMqttMessage);
          }
        }
      });
      socket.once("error", fail);
      socket.once("close", () => { this.#socket = null; this.emit("close"); });
    });
  }

  subscribe(topic: string, qos = 0): void {
    const id = this.#nextPacketId();
    this.#write(packet(0x82, Buffer.concat([u16(id), utf8(topic), Buffer.from([qos])])));
  }

  publish(topic: string, payload: Uint8Array, qos = 0): void {
    const id = qos > 0 ? u16(this.#nextPacketId()) : Buffer.alloc(0);
    this.#write(packet(0x30 | (qos << 1), Buffer.concat([utf8(topic), id, Buffer.from(payload)])));
  }

  close(): void {
    if (!this.#socket) return;
    this.#write(packet(0xe0, Buffer.alloc(0)));
    this.#socket.end();
    this.#socket = null;
  }

  #write(data: Buffer): void {
    if (!this.#socket?.writable) throw new Error("Native MQTT is not connected");
    this.#socket.write(data);
  }

  #nextPacketId(): number {
    const id = this.#packetId;
    this.#packetId = this.#packetId === 65_535 ? 1 : this.#packetId + 1;
    return id;
  }
}

function connectPayload(clientId: string, username: string, password?: string): Buffer {
  const flags = 0x02 | 0x80 | (password === undefined ? 0 : 0x40);
  const fields = [utf8("MQTT"), Buffer.from([4, flags]), u16(60), utf8(clientId), utf8(username)];
  if (password !== undefined) fields.push(utf8(password));
  return Buffer.concat(fields);
}

function packet(type: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), remainingLength(body.length), body]);
}

function remainingLength(length: number): Buffer {
  const bytes: number[] = [];
  do { let digit = length % 128; length = Math.floor(length / 128); if (length > 0) digit |= 128; bytes.push(digit); } while (length > 0);
  return Buffer.from(bytes);
}

function decodePacket(buffer: Buffer): { readonly type: number; readonly flags: number; readonly body: Buffer; readonly bytes: number } | null {
  if (buffer.length < 2) return null;
  let multiplier = 1;
  let length = 0;
  let index = 1;
  while (index < buffer.length) {
    const digit = buffer[index++]!;
    length += (digit & 127) * multiplier;
    if ((digit & 128) === 0) break;
    multiplier *= 128;
    if (multiplier > 128 * 128 * 128) throw new Error("Invalid MQTT remaining length");
  }
  if (index + length > buffer.length) return null;
  return { type: buffer[0]! >> 4, flags: buffer[0]! & 15, body: buffer.subarray(index, index + length), bytes: index + length };
}

function utf8(value: string): Buffer { const data = Buffer.from(value, "utf8"); return Buffer.concat([u16(data.length), data]); }
function u16(value: number): Buffer { const data = Buffer.alloc(2); data.writeUInt16BE(value); return data; }

function parseEndpoint(value: string): { readonly host: string; readonly port: number } {
  const url = value.includes("://") ? new URL(value) : new URL(`mqtts://${value}`);
  return { host: url.hostname, port: Number(url.port || 8883) };
}
