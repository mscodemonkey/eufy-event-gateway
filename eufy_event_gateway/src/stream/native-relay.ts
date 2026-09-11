import { connect as tcpConnect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { assembleRelayHandshake, authorizationField, relayAuthAck, relayAuthRequest, relayEndpoint, relayHandshakeSignature, type NativeRelayToken, parseRelayHandshake, mediaFrame, unwrapMediaFrame, keepaliveFrame } from "./native-media.js";

export class NativeRelayConnection {
  #socket: Socket | null = null; #buffer = Buffer.alloc(0); #closed = false; #keepalive: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly token: NativeRelayToken, private readonly deviceId: string, private readonly uid: string, private readonly mediaKey: Uint8Array) {}
  get connected(): boolean { return this.#socket?.writable === true && !this.#closed; }
  async connect(): Promise<void> { const endpoint = relayEndpoint(this.token); const socket = await new Promise<Socket>((resolve, reject) => { const s = tcpConnect(endpoint.port, endpoint.host); s.once("connect", () => resolve(s)); s.once("error", reject); }); this.#socket = socket; const credential = Buffer.from(this.token.credential.slice(0, 16)); const random = randomAlphanumeric(32); const request = assembleRelayHandshake(0, credential, randomBytes(16), this.token.sessionId, this.token.username, relayAuthRequest(this.deviceId, this.uid, random)); const responsePromise = this.#nextHandshake(); this.#write(request); const response = await responsePromise; const auth = typeof response.authorization === "string" ? response.authorization : ""; const signature = authorizationField(auth, "signature"); const deviceRandom = authorizationField(auth, "random"); const expire = this.token.username.split(":", 1)[0]!; const expected = relayHandshakeSignature(this.token.credential, expire, this.deviceId, this.token.sessionId, this.uid, random); if (signature !== expected) throw new Error("Native relay device signature mismatch"); const ack = assembleRelayHandshake(2, credential, randomBytes(16), this.token.sessionId, this.token.username, relayAuthAck(this.deviceId, this.uid, relayHandshakeSignature(this.token.credential, expire, this.deviceId, this.token.sessionId, this.uid, signature, deviceRandom))); const finalPromise = this.#nextHandshake(); this.#write(ack); await finalPromise; this.#keepalive = setInterval(() => this.#write(keepaliveFrame()), 1_000); }
  send(segment: Uint8Array): void { this.#write(mediaFrame(this.mediaKey, segment)); }
  onSegment(handler: (segment: Buffer) => void): void { this.#socket?.on("data", (chunk: Buffer) => { this.#buffer = Buffer.concat([this.#buffer, chunk]); while (this.#buffer.length >= 4) { const len = this.#buffer.readUInt16BE(2); if (this.#buffer.length < 4 + len) break; const magic = this.#buffer[0]!; const payload = this.#buffer.subarray(4, 4 + len); this.#buffer = this.#buffer.subarray(4 + len); if (magic === 0xf6) handler(unwrapMediaFrame(this.mediaKey, payload)); } }); }
  close(): void { this.#closed = true; if (this.#keepalive) clearInterval(this.#keepalive); this.#keepalive = null; this.#socket?.destroy(); this.#socket = null; }
  #write(frame: Buffer): void { if (!this.#closed && this.#socket?.writable) this.#socket.write(frame); }
  #nextHandshake(): Promise<Record<string, unknown>> { return new Promise((resolve, reject) => { const onData = () => { while (this.#buffer.length >= 4) { const length = this.#buffer.readUInt16BE(2); if (this.#buffer.length < 4 + length) return; const magic = this.#buffer[0]!; const payload = this.#buffer.subarray(4, 4 + length); this.#buffer = this.#buffer.subarray(4 + length); if (magic === 0xf4) { this.#socket?.off("data", onData); try { resolve(parseRelayHandshake(Buffer.from(this.token.credential.slice(0, 16)), payload)); } catch (error) { reject(error); } return; } } }; this.#socket?.on("data", onData); this.#socket?.once("error", reject); }); }
}

function randomAlphanumeric(length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}
