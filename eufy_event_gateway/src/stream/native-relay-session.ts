import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { NativeRelayConnection } from "./native-relay.js";
import { NativeKcpConversation, buildKcpSegment, parseKcpSegment, KCP_PUSH } from "./native-kcp.js";
import { decryptNativeRecord, encryptNativeRecord, extractNativeMediaPackets, mediaPacketPayload, type NativeRelayToken } from "./native-media.js";

export interface NativeRelaySessionOptions { readonly token: NativeRelayToken; readonly deviceId: string; readonly uid: string; readonly offerKey: Uint8Array; readonly answerKey: Uint8Array; readonly onVideo: (annexBOrJpeg: Buffer) => void; }

/** Relay/KCP session core. Signalling is sent over conversation 0x010000f3;
 * video arrives on conversation 1 after channel-zero authentication. */
export class NativeRelaySession {
  readonly #connection: NativeRelayConnection;
  readonly #control: NativeKcpConversation;
  readonly #video: NativeKcpConversation;
  #signalSequence = 0;
  constructor(private readonly options: NativeRelaySessionOptions) {
    this.#connection = new NativeRelayConnection(options.token, options.deviceId, options.uid, options.offerKey);
    const transmit = (raw: Buffer) => this.#connection.send(raw);
    this.#control = new NativeKcpConversation(0, transmit);
    this.#video = new NativeKcpConversation(1, transmit, (record) => this.#consumeVideo(record));
  }
  async connect(): Promise<void> { await this.#connection.connect(); this.#connection.onSegment((raw) => { const segment = parseKcpSegment(raw); if (!segment) return; if (segment.conversation === 0) this.#control.input(segment); else if (segment.conversation === 1) this.#video.input(segment); }); }
  sendTunnelJson(json: Uint8Array, key: Uint8Array): void { const header = Buffer.alloc(4); header.writeUInt16BE(1, 0); header.writeUInt16BE(json.length, 2); const plain = Buffer.concat([header, Buffer.from(json), json.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]); const padded = pkcs7(plain); for (let offset = 0; offset < padded.length; offset += 1312) { const iv = randomBytes(16); const cipher = createCipheriv("aes-128-cbc", Buffer.from(key), iv); cipher.setAutoPadding(false); const encrypted = Buffer.concat([cipher.update(padded.subarray(offset, offset + 1312)), cipher.final()]); this.#connection.send(buildKcpSegment({ conversation: 0x010000f3, command: KCP_PUSH, fragment: 0, window: 64, timestamp: 0, sequence: this.#signalSequence++, unacknowledged: 0, data: Buffer.concat([iv, encrypted]) })); } }
  authenticate(devicePassword: string, localKey: string): void { const credential = createHashMd5(`${devicePassword}||${localKey}`); for (const packet of startSequence(credential)) this.#control.send(encryptNativeRecord(this.options.offerKey, packet)); }
  close(): void { this.#control.close(); this.#video.close(); this.#connection.close(); }
  #consumeVideo(record: Buffer): void { try { const plain = decryptNativeRecord(this.options.answerKey, record); for (const packet of extractNativeMediaPackets(plain)) this.options.onVideo(mediaPacketPayload(packet)); } catch { /* ignore malformed/control records while the stream settles */ } }
}
function pkcs7(value: Buffer): Buffer { const amount = 16 - (value.length % 16) || 16; return Buffer.concat([value, Buffer.alloc(amount, amount)]); }
function createHashMd5(value: string): string { return createHash("md5").update(value).digest("hex"); }
function buildAuth(credential: string): Buffer { const body = Buffer.alloc(96); Buffer.from("admin").copy(body); Buffer.from(credential).copy(body, 32); const out = Buffer.alloc(104); out.writeUInt32LE(0x12345678, 0); out.writeUInt32LE(1, 4); body.copy(out, 8); return out; }
function command(type: number, subCommand: number, payload: Buffer): Buffer { const out = Buffer.alloc(20 + payload.length); out.writeUInt32LE(0x12345678, 0); out.writeUInt32LE(type >>> 0, 4); out.writeUInt32LE(0, 8); out.writeUInt32LE(subCommand >>> 0, 12); out.writeUInt32LE(payload.length, 16); payload.copy(out, 20); return out; }
function u32(value: number): Buffer { const out = Buffer.alloc(4); out.writeUInt32LE(value >>> 0); return out; }
function startSequence(credential: string): Buffer[] { const capability = Buffer.from('{"cmd":"capability_exchange_req","protocol_version":1,"data":{"capabilities":{"opus_encode":1,"opus_decode":1}}}\0'); return [buildAuth(credential), command(0, 0x0a, u32(0x00010001)), command(0, 0x15, capability), command(2, 2, u32(0)), command(0x00010004, 9, Buffer.concat([u32(0), u32(4)])), command(0x00010003, 6, Buffer.concat([u32(0), u32(0)])), command(0x00010005, 0x00040006, Buffer.concat([u32(0), u32(4)]))]; }
