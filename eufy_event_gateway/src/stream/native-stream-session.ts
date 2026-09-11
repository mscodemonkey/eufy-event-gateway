import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";

import { ThingGatewayClient, type ThingAccountSession, type ThingStreamConfig } from "../mega/thing-gateway.js";
import { NativeMqttTransport } from "../mega/native-mqtt.js";
import { NativeP2PSignaller, nativeSdpOffer } from "../mega/native-p2p.js";
import { NativeRelaySession } from "./native-relay-session.js";
import { parseNativeRelayToken, type NativeRelayToken } from "./native-media.js";

export interface NativeStreamSessionOptions {
  readonly gateway: ThingGatewayClient;
  readonly account: ThingAccountSession;
  readonly deviceId: string;
  readonly localKey: string;
  readonly maxSeconds: number;
}

export class NativeStreamSession {
  readonly output = new PassThrough();
  #mqtt: NativeMqttTransport | null = null;
  #relay: NativeRelaySession | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #encoder: ChildProcessWithoutNullStreams | null = null;
  #videoFormat: "unknown" | "jpeg" | "h264" = "unknown";
  #closed = false;

  constructor(private readonly options: NativeStreamSessionOptions) {}

  async start(): Promise<void> {
    const config = await this.options.gateway.streamConfig(this.options.account, this.options.deviceId, this.options.localKey);
    const session = parseSession(config);
    const relay = parseNativeRelayToken(config.tcpRelay);
    const rendezvous = `${this.options.deviceId}${Math.floor(Date.now() / 1_000)}${randomBytes(4).toString("hex")}`;
    const offeredRelay: NativeRelayToken = { ...relay, sessionId: rendezvous, raw: { ...relay.raw, sessionId: rendezvous } };
    const identity = this.options.gateway.mqttIdentity(this.options.account);
    const mqtt = new NativeMqttTransport({ endpointAddress: `${identity.host}:${identity.port}` }, identity.clientId, {
      username: identity.username,
      password: identity.password,
      rejectUnauthorized: false,
    });
    this.#mqtt = mqtt;
    const signaller = new NativeP2PSignaller(mqtt, this.options.deviceId, this.options.localKey);
    const answer = new Promise<{ readonly aesKey: Buffer; readonly sdp: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Native camera sent no P2P answer")), 20_000);
      const onMessage = (message: { readonly topic: string; readonly payload: Buffer }) => {
        const decoded = signaller.decode(message);
        if (!decoded || !isRecord(decoded.data)) return;
        const header = isRecord(decoded.data.header) ? decoded.data.header : null;
        const body = isRecord(decoded.data.msg) ? decoded.data.msg : null;
        if (header?.type !== "answer" || typeof body?.sdp !== "string") return;
        const aes = /(?:^|\r?\n)a=aes-key:([0-9a-f]{32})(?:\r?\n|$)/i.exec(body.sdp)?.[1];
        if (!aes) return;
        clearTimeout(timeout);
        mqtt.off("message", onMessage);
        resolve({ aesKey: Buffer.from(aes, "hex"), sdp: body.sdp });
      };
      mqtt.on("message", onMessage);
    });
    await mqtt.connect();
    signaller.start(() => undefined);
    signaller.sendQuery(0);
    signaller.sendOffer({
      uid: this.options.account.uid,
      deviceId: this.options.deviceId,
      sessionId: session.sessionId,
      traceId: session.traceId,
      sdp: nativeSdpOffer(this.options.account.uid, session.sessionId, Math.floor(Date.now() / 1_000), session.iceUfrag, session.icePassword, session.aesKey),
      iceServers: config.iceServers,
      tcpToken: offeredRelay.raw,
      logConfig: config.p2pConfig.log,
    }, 1);
    const received = await answer;
    const relaySession = new NativeRelaySession({
      token: offeredRelay,
      deviceId: this.options.deviceId,
      uid: this.options.account.uid,
      offerKey: session.aesKey,
      answerKey: received.aesKey,
      onVideo: (chunk) => this.#writeVideo(chunk),
    });
    this.#relay = relaySession;
    await relaySession.connect();
    relaySession.sendTunnelJson(Buffer.from(JSON.stringify({ header: { type: "offer", from: this.options.account.uid, to: this.options.deviceId, sessionid: session.sessionId, moto_id: "", trace_id: session.traceId, path: "relay", is_pre: 0, p2p_skill: 1635, security_level: 3 }, msg: { sdp: nativeSdpOffer(this.options.account.uid, session.sessionId, Math.floor(Date.now() / 1_000), session.iceUfrag, session.icePassword, session.aesKey), preconnect: true, token: config.iceServers, tcp_token: offeredRelay.raw, log: config.p2pConfig.log ?? {} } })), session.aesKey);
    relaySession.authenticate(config.password, this.options.localKey);
    this.#timer = setTimeout(() => this.close(), this.options.maxSeconds * 1_000);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#relay?.close();
    this.#mqtt?.close();
    const encoder = this.#encoder;
    this.#encoder = null;
    if (encoder) {
      encoder.stdin.end();
      encoder.once("close", () => this.output.end());
    }
    this.#relay = null;
    this.#mqtt = null;
    if (!encoder) this.output.end();
  }

  #writeVideo(chunk: Buffer): void {
    if (this.#closed || chunk.length === 0) return;
    if (this.#videoFormat === "unknown") {
      this.#videoFormat = chunk.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) ? "jpeg" : "h264";
    }
    if (this.#videoFormat === "h264") {
      this.output.write(chunk);
      return;
    }
    if (!this.#encoder) this.#startJpegEncoder();
    if (this.#encoder?.stdin.writable) this.#encoder.stdin.write(chunk);
  }

  #startJpegEncoder(): void {
    const encoder = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", "10", "-vcodec", "mjpeg", "-i", "pipe:0",
      "-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-pix_fmt", "yuv420p", "-f", "h264", "pipe:1",
    ]);
    encoder.stdout.on("data", (chunk: Buffer) => { if (!this.#closed) this.output.write(chunk); });
    encoder.on("error", (error) => { if (!this.#closed) this.output.destroy(error); });
    encoder.stderr.resume();
    this.#encoder = encoder;
  }
}

function parseSession(config: ThingStreamConfig): { readonly sessionId: string; readonly aesKey: Buffer; readonly iceUfrag: string; readonly icePassword: string; readonly traceId: string } {
  const value = config.session;
  const sessionId = string(value.sessionId), aesKey = string(value.aesKey), iceUfrag = string(value.iceUfrag), icePassword = string(value.icePassword);
  if (!sessionId || !aesKey || !iceUfrag || !icePassword || !/^[0-9a-f]{32}$/i.test(aesKey)) throw new Error("Native camera RTC session is incomplete");
  return { sessionId, aesKey: Buffer.from(aesKey, "hex"), iceUfrag, icePassword, traceId: string(value.traceId) ?? "" };
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function string(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
