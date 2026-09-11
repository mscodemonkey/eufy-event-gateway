import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { RTCPeerConnection } from "werift";
import WebSocket, { type RawData } from "ws";

import type { WebClient } from "../mega/web-client.js";
import { decryptWebEnvelope, encryptWebEnvelope } from "../mega/web-crypto.js";
import { H264RtpDepacketizer } from "./h264-rtp.js";

export interface WebRtcDevice {
  readonly serial: string;
  readonly stationSerial: string;
  readonly channel: number;
  readonly adminUserId: string;
}

interface TurnServer {
  readonly turn_addr: string;
  readonly turn_port: number;
  readonly turn_user: string;
  readonly turn_password: string;
}

export class WebRtcStream {
  readonly output = new PassThrough({ highWaterMark: 2 * 1024 * 1024 });
  readonly #depacketizer = new H264RtpDepacketizer();
  #socket: WebSocket | null = null;
  #peer: RTCPeerConnection | null = null;
  #sign = "";
  #signalKey = "";
  #closed = false;
  #heartbeat: NodeJS.Timeout | null = null;
  #timeout: NodeJS.Timeout | null = null;
  #authTimeout: NodeJS.Timeout | null = null;
  #parameterSets: Buffer[] = [];
  #sentParameterSets = false;

  constructor(
    private readonly client: WebClient,
    private readonly pin: string,
    private readonly device: WebRtcDevice,
    private readonly maximumSeconds: number,
  ) {
    // Signalling can fail before LiveStreamManager attaches source listeners.
    // Consume the stream error during that startup window so it cannot become
    // an uncaught process-level exception.
    this.output.on("error", () => undefined);
  }

  async start(): Promise<void> {
    await this.client.verifyPortalPin(this.pin);
    const signal = await this.client.signal();
    this.#sign = signal.sign;
    this.#signalKey = this.client.signalKey;
    // Eufy's web client sends the signed ticket byte-for-byte. Its signalling
    // service validates the raw query value rather than an equivalent
    // percent-encoded representation.
    const url = `wss://${signal.host}/v1/smart/ws/join?sign=${this.#sign}&pin=${this.pin}`;
    const socket = new WebSocket(url, this.client.authToken, {
      origin: "https://mysecurity.eufylife.com",
      handshakeTimeout: 20_000,
    });
    this.#socket = socket;
    socket.on("message", (data) => void this.#receive(data).catch((error) => this.#fail(error)));
    socket.on("close", (code, reason) => {
      if (this.#closed) return this.#finish();
      this.#fail(new Error(webSocketCloseMessage(code, reason.toString("utf8"))));
    });
    socket.on("error", (error) => this.#fail(new Error(webSocketErrorMessage(error))));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out opening Eufy live signalling")), 20_000);
      socket.once("open", () => {
        clearTimeout(timer);
        console.info("Eufy live signalling opened");
        this.#sendRaw({ code: 200, action: 1, data: this.#sign });
        this.#authTimeout = setTimeout(() => this.#fail(new Error("Eufy live signalling authentication timed out")), 10_000);
        resolve();
      });
      socket.once("unexpected-response", (_request, response) => {
        clearTimeout(timer);
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          if (length >= 2_048) return;
          const value = Buffer.from(chunk).subarray(0, 2_048 - length);
          chunks.push(value);
          length += value.length;
        });
        response.on("end", () => reject(new Error(
          webSocketHttpRejectionMessage(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")),
        )));
        response.resume();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(webSocketErrorMessage(error)));
      });
    });
    this.#timeout = setTimeout(() => this.close(), this.maximumSeconds * 1_000);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#sendMessage({}, "hangup"); } catch {}
    try { this.#socket?.send(JSON.stringify({ code: 200, msgid: "0", action: 4 })); } catch {}
    this.#socket?.close();
    void this.#peer?.close();
    this.#finish();
  }

  async #receive(raw: RawData): Promise<void> {
    const text = typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString("utf8")
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
        : "";
    if (!text) return;
    const outer = JSON.parse(text) as unknown;
    if (!isRecord(outer) || typeof outer.data !== "string") return;
    const inner = JSON.parse(decryptWebEnvelope(outer.data, this.#signalKey, false)) as unknown;
    if (!isRecord(inner)) return;
    const action = numberValue(inner.action);
    if (action === 1) {
      if (this.#authTimeout) clearTimeout(this.#authTimeout);
      this.#authTimeout = null;
      console.info("Eufy live signalling authenticated");
      this.#sendPing();
      this.#sendMessage({}, "call");
      return;
    }
    if (action === 2) {
      this.#schedulePing();
      return;
    }
    if (action !== 3) return;
    const data = typeof inner.data === "string" ? JSON.parse(inner.data) as unknown : null;
    if (!isRecord(data)) return;
    const type = stringValue(inner.dataType);
    if (type === "call") {
      const status = numberValue(data.status);
      if (status === 100 && isTurnServer(data.turn)) await this.#createPeer(data.turn);
      if (status === 200) this.#sendMessage({}, "ack");
      if (status === 408 || status === 486) throw new Error(`Eufy camera rejected live viewing (${status})`);
    } else if (type === "info" && data.format === "SDP" && typeof data.value === "string") {
      await this.#answer(data.value);
    } else if (type === "hangup") {
      this.close();
    }
  }

  async #createPeer(turn: TurnServer): Promise<void> {
    if (this.#peer) return;
    const peer = new RTCPeerConnection({
      iceServers: [{
        urls: `turn:${turn.turn_addr}:${turn.turn_port}`,
        username: turn.turn_user,
        credential: turn.turn_password,
      }],
    });
    this.#peer = peer;
    peer.onIceCandidate.subscribe((candidate) => {
      if (candidate?.candidate) this.#sendMessage({ candidate: candidate.candidate }, "info");
    });
    peer.onTrack.subscribe((track) => {
      if (track.kind !== "video") return;
      track.onReceiveRtp.subscribe((packet) => {
        if (!this.#sentParameterSets) {
          for (const value of this.#parameterSets) this.output.write(value);
          this.#sentParameterSets = true;
        }
        for (const nal of this.#depacketizer.push(packet.payload, packet.header.sequenceNumber)) this.output.write(nal);
      });
    });
    peer.connectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "disconnected") this.#fail(new Error(`Eufy WebRTC connection ${state}`));
    });
  }

  async #answer(offer: string): Promise<void> {
    if (!this.#peer) throw new Error("Eufy sent an SDP offer before its TURN configuration");
    this.#parameterSets = this.#depacketizer.parameterSets(offer);
    await this.#peer.setRemoteDescription({ type: "offer", sdp: offer });
    const answer = await this.#peer.createAnswer();
    await this.#peer.setLocalDescription(answer);
    const sdp = this.#peer.localDescription?.sdp ?? answer.sdp;
    this.#sendMessage({ sdp }, "info");
  }

  #sendPing(): void {
    this.#sendRaw({ action: 2, data: JSON.stringify({ source: "SMART" }), code: 200 });
    this.#schedulePing();
  }

  #schedulePing(): void {
    if (this.#heartbeat) clearTimeout(this.#heartbeat);
    this.#heartbeat = setTimeout(() => this.#sendPing(), 10_000);
  }

  #sendMessage(data: Record<string, unknown>, dataType: "call" | "ack" | "info" | "hangup"): void {
    const timestamp = Math.floor(Date.now() / 1_000);
    const channel = this.device.channel;
    this.#sendRaw({
      code: 200,
      action: 3,
      sessionId: this.#sign,
      sn: this.device.stationSerial,
      subSn: this.device.serial,
      channelId: channel,
      is_response: 0,
      dataType,
      source: "WEB",
      ts: timestamp,
      data: JSON.stringify({
        timestamp,
        account: createHash("md5").update(`${channel}${this.device.adminUserId}${timestamp}`).digest("hex"),
        ...data,
      }),
    });
  }

  #sendRaw(value: Record<string, unknown>): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
    const data = encryptWebEnvelope(JSON.stringify(value), this.#signalKey, false);
    const msgid = value.action === 3 ? `${this.client.authToken}_${randomUUID()}` : "0";
    this.#socket.send(JSON.stringify({ msgid, data }));
  }

  #fail(error: unknown): void {
    const failure = error instanceof Error ? error : new Error("Eufy live stream failed");
    console.warn(`Eufy live stream failed: ${failure.message}`);
    if (!this.output.destroyed) this.output.destroy(failure);
    this.close();
  }

  #finish(): void {
    this.#closed = true;
    if (this.#heartbeat) clearTimeout(this.#heartbeat);
    if (this.#timeout) clearTimeout(this.#timeout);
    if (this.#authTimeout) clearTimeout(this.#authTimeout);
    this.#heartbeat = null;
    this.#timeout = null;
    this.#authTimeout = null;
    void this.#peer?.close();
    this.#peer = null;
    if (!this.output.destroyed && !this.output.readableEnded) this.output.end();
  }
}

export function webSocketCloseMessage(code: number, reason: string): string {
  const safeReason = reason.trim().replaceAll(/[\r\n\t]/g, " ").slice(0, 160);
  return `Eufy live signalling closed (code ${code}${safeReason ? `: ${safeReason}` : ""})`;
}

export function webSocketErrorMessage(error: Error & { code?: string }): string {
  const status = /Unexpected server response: (\d{3})/.exec(error.message)?.[1];
  if (status) return `Eufy live signalling failed (HTTP upgrade ${status})`;
  return `Eufy live signalling failed${error.code ? ` (${error.code})` : ""}`;
}

export function webSocketHttpRejectionMessage(status: number, body: string): string {
  const detail = safeHttpDetail(body);
  return `Eufy live signalling rejected the HTTP upgrade (${status}${detail ? `: ${detail}` : ""})`;
}

function safeHttpDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (isRecord(value)) {
      const code = typeof value.code === "number" || typeof value.code === "string" ? `${value.code}` : "";
      const message = typeof value.msg === "string"
        ? value.msg
        : typeof value.message === "string"
          ? value.message
          : "";
      return safeText([code, message].filter(Boolean).join(" "));
    }
  } catch {}
  return safeText(trimmed);
}

function safeText(value: string): string {
  return value
    .replaceAll(/[\r\n\t]+/g, " ")
    .replaceAll(/[A-Za-z0-9_+/=-]{24,}/g, "[redacted]")
    .replaceAll(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, 160);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isTurnServer(value: unknown): value is TurnServer {
  return isRecord(value) && typeof value.turn_addr === "string" && typeof value.turn_port === "number" &&
    typeof value.turn_user === "string" && typeof value.turn_password === "string";
}
