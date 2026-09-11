import assert from "node:assert/strict";
import test from "node:test";
import { buildKcpSegment, NativeKcpConversation, parseKcpSegment, KCP_ACK } from "../src/stream/native-kcp.js";

test("round-trips a native KCP segment", () => {
  const raw = buildKcpSegment({ conversation: 1, command: 0x51, fragment: 0, window: 512, timestamp: 3, sequence: 4, unacknowledged: 5, data: Buffer.from("video") });
  assert.deepEqual(parseKcpSegment(raw), { conversation: 1, command: 0x51, fragment: 0, window: 512, timestamp: 3, sequence: 4, unacknowledged: 5, data: Buffer.from("video") });
});

test("reassembles KCP fragments and acknowledges them", () => {
  const outbound: Buffer[] = []; const messages: Buffer[] = [];
  const conversation = new NativeKcpConversation(1, (raw) => outbound.push(raw), (data) => messages.push(data));
  conversation.input({ conversation: 1, command: 0x51, fragment: 1, window: 512, timestamp: 1, sequence: 0, unacknowledged: 0, data: Buffer.from("hel") });
  conversation.input({ conversation: 1, command: 0x51, fragment: 0, window: 512, timestamp: 2, sequence: 1, unacknowledged: 0, data: Buffer.from("lo") });
  assert.deepEqual(messages, [Buffer.from("hello")]);
  assert.equal(parseKcpSegment(outbound[0]!)?.command, KCP_ACK);
  conversation.close();
});
