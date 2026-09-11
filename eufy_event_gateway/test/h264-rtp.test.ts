import assert from "node:assert/strict";
import test from "node:test";

import { H264RtpDepacketizer } from "../src/stream/h264-rtp.js";
import { webSocketCloseMessage, webSocketErrorMessage } from "../src/stream/web-rtc-stream.js";

const start = Buffer.from([0, 0, 0, 1]);

test("converts a single RTP NAL unit to Annex B", () => {
  const parser = new H264RtpDepacketizer();
  assert.deepEqual(parser.push(Buffer.from([0x65, 1, 2]), 10), [Buffer.concat([start, Buffer.from([0x65, 1, 2])])]);
});

test("splits STAP-A packets into Annex B NAL units", () => {
  const parser = new H264RtpDepacketizer();
  const payload = Buffer.from([0x78, 0, 2, 0x67, 1, 0, 3, 0x68, 2, 3]);
  assert.deepEqual(parser.push(payload, 10), [
    Buffer.concat([start, Buffer.from([0x67, 1])]),
    Buffer.concat([start, Buffer.from([0x68, 2, 3])]),
  ]);
});

test("reassembles FU-A fragments and drops an interrupted fragment", () => {
  const parser = new H264RtpDepacketizer();
  assert.deepEqual(parser.push(Buffer.from([0x7c, 0x85, 1, 2]), 10), []);
  assert.deepEqual(parser.push(Buffer.from([0x7c, 0x05, 3]), 11), []);
  assert.deepEqual(parser.push(Buffer.from([0x7c, 0x45, 4]), 12), [
    Buffer.concat([start, Buffer.from([0x65, 1, 2, 3, 4])]),
  ]);
  assert.deepEqual(parser.push(Buffer.from([0x7c, 0x85, 9]), 20), []);
  assert.deepEqual(parser.push(Buffer.from([0x7c, 0x45, 10]), 22), []);
});

test("extracts SPS and PPS parameter sets from SDP", () => {
  const parser = new H264RtpDepacketizer();
  const sets = parser.parameterSets("a=fmtp:96 packetization-mode=1;sprop-parameter-sets=ZwE=,aAI=;profile-level-id=42e01f");
  assert.deepEqual(sets, [
    Buffer.concat([start, Buffer.from("ZwE=", "base64")]),
    Buffer.concat([start, Buffer.from("aAI=", "base64")]),
  ]);
});

test("reports signalling close codes without multiline log content", () => {
  assert.equal(webSocketCloseMessage(1006, ""), "Eufy live signalling closed (code 1006)");
  assert.equal(
    webSocketCloseMessage(4403, "expired\ncredential"),
    "Eufy live signalling closed (code 4403: expired credential)",
  );
});

test("reports only safe WebSocket upgrade diagnostics", () => {
  assert.equal(
    webSocketErrorMessage(new Error("Unexpected server response: 403")),
    "Eufy live signalling failed (HTTP upgrade 403)",
  );
  const networkError = Object.assign(new Error("request included a signed URL"), { code: "ENOTFOUND" });
  assert.equal(webSocketErrorMessage(networkError), "Eufy live signalling failed (ENOTFOUND)");
});
