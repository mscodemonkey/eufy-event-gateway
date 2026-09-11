import { createHmac } from "node:crypto";

export const KCP_HEADER_LENGTH = 24;
export const KCP_PUSH = 0x51;
export const KCP_ACK = 0x52;
export const KCP_WINDOW_ASK = 0x53;
export const KCP_WINDOW_TELL = 0x54;

export interface KcpSegment { readonly conversation: number; readonly command: number; readonly fragment: number; readonly window: number; readonly timestamp: number; readonly sequence: number; readonly unacknowledged: number; readonly data: Buffer; }
export function parseKcpSegment(raw: Uint8Array): KcpSegment | null { const b = Buffer.from(raw); if (b.length < 24) return null; const len = b.readUInt32LE(20); if (24 + len > b.length) return null; return { conversation: b.readUInt32LE(0), command: b[4]!, fragment: b[5]!, window: b.readUInt16LE(6), timestamp: b.readUInt32LE(8), sequence: b.readUInt32LE(12), unacknowledged: b.readUInt32LE(16), data: b.subarray(24, 24 + len) }; }
export function buildKcpSegment(segment: Omit<KcpSegment, "data"> & { readonly data?: Uint8Array }): Buffer { const data = Buffer.from(segment.data ?? Buffer.alloc(0)); const b = Buffer.alloc(24 + data.length); b.writeUInt32LE(segment.conversation >>> 0, 0); b[4] = segment.command; b[5] = segment.fragment; b.writeUInt16LE(segment.window & 0xffff, 6); b.writeUInt32LE(segment.timestamp >>> 0, 8); b.writeUInt32LE(segment.sequence >>> 0, 12); b.writeUInt32LE(segment.unacknowledged >>> 0, 16); b.writeUInt32LE(data.length, 20); data.copy(b, 24); return b; }

export function mediaTag(mediaKey: Uint8Array, segment: Uint8Array): Buffer { return createHmac("sha1", Buffer.from(mediaKey)).update(segment).digest(); }

export class NativeKcpConversation {
  #sendSequence = 0; #receiveSequence = 0; #received = new Map<number, KcpSegment>(); #fragments: Buffer[] = []; #pending = new Map<number, { raw: Buffer; sentAt: number; tries: number }>(); #timer: ReturnType<typeof setInterval> | null = null; #closed = false;
  constructor(readonly conversation: number, private readonly transmit: (raw: Buffer) => void, private readonly onMessage?: (data: Buffer) => void) {}
  input(segment: KcpSegment): void { if (this.#closed) return; this.#retire(segment.unacknowledged); if (segment.command === KCP_ACK) this.#retire(segment.sequence + 1); else if (segment.command === KCP_PUSH) { this.#accept(segment); this.transmitAck(segment); } else if (segment.command === KCP_WINDOW_ASK) this.transmit(buildKcpSegment({ conversation: this.conversation, command: KCP_WINDOW_TELL, fragment: 0, window: 512, timestamp: clock(), sequence: 0, unacknowledged: this.#receiveSequence })); }
  send(data: Uint8Array): void { if (this.#closed) throw new Error("Native KCP conversation is closed"); const value = Buffer.from(data); const count = Math.max(1, Math.ceil(value.length / 1376)); for (let i = 0; i < count; i++) { const raw = buildKcpSegment({ conversation: this.conversation, command: KCP_PUSH, fragment: count - 1 - i, window: 512, timestamp: clock(), sequence: this.#sendSequence, unacknowledged: this.#receiveSequence, data: value.subarray(i * 1376, (i + 1) * 1376) }); this.#pending.set(this.#sendSequence, { raw, sentAt: Date.now(), tries: 1 }); this.#sendSequence++; this.transmit(raw); } this.#arm(); }
  close(): void { this.#closed = true; if (this.#timer) clearInterval(this.#timer); this.#timer = null; this.#pending.clear(); this.#received.clear(); this.#fragments = []; }
  private transmitAck(segment: KcpSegment): void { this.transmit(buildKcpSegment({ conversation: this.conversation, command: KCP_ACK, fragment: 0, window: 512, timestamp: segment.timestamp, sequence: segment.sequence, unacknowledged: this.#receiveSequence })); }
  #accept(segment: KcpSegment): void { if (segment.sequence < this.#receiveSequence || segment.sequence >= this.#receiveSequence + 512 || this.#received.has(segment.sequence)) return; this.#received.set(segment.sequence, segment); while (this.#received.has(this.#receiveSequence)) { const next = this.#received.get(this.#receiveSequence)!; this.#received.delete(this.#receiveSequence++); this.#fragments.push(next.data); if (next.fragment === 0) { const message = Buffer.concat(this.#fragments); this.#fragments = []; if (message.length) this.onMessage?.(message); } } }
  #retire(unacknowledged: number): void { for (const sequence of this.#pending.keys()) if (sequence < unacknowledged) this.#pending.delete(sequence); if (!this.#pending.size && this.#timer) { clearInterval(this.#timer); this.#timer = null; } }
  #arm(): void { if (this.#timer || this.#closed) return; this.#timer = setInterval(() => { const now = Date.now(); for (const pending of this.#pending.values()) { if (now - pending.sentAt < 300) continue; if (pending.tries >= 8) { this.close(); return; } pending.sentAt = now; pending.tries++; this.transmit(pending.raw); } }, 300); }
}
function clock(): number { return Math.floor(performance.now()) >>> 0; }
