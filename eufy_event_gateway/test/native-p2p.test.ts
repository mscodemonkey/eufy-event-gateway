import assert from "node:assert/strict";
import test from "node:test";

import { decodeNative302V22, decodeNative302V23, encodeNative302V22, encodeNative302V23, nativeCameraTransactionId, nativeConnectV3, nativeSdpOffer, parseNativeCameraRtcConfig } from "../src/mega/native-p2p.js";

test("builds the native Thing P2P connect_v3 command", () => {
  assert.deepEqual(nativeConnectV3({ remoteId: "p2p-camera", deviceId: "camera", token: "token", traceId: "trace" }), {
    cmd: "connect_v3",
    args: {
      remote_id: "p2p-camera", dev_id: "camera", token: "token", skills: "", trace_id: "trace",
      timeout_ms: 30_000, lan_mode: 0, preconnect_enable: 0, connect_session: "",
    },
  });
});

test("builds the native camera transaction id", () => {
  assert.equal(nativeCameraTransactionId("camera", 1_700_000_000_000), "ipc_p2p_android_camera_1700000000000");
});

test("parses the stable fields from a native camera RTC response", () => {
  assert.deepEqual(parseNativeCameraRtcConfig({ p2pId: "remote", p2pConfig: {
    p2pKey: "0123456789abcdef", initStr: "init", ices: [{ urls: "stun:test" }], session: { id: "s" },
  } }), {
    p2pId: "remote", p2pKey: "0123456789abcdef", initStr: "init", iceServers: [{ urls: "stun:test" }], session: { id: "s" }, tcpRelay: null, udpRelay: null,
  });
});

test("builds the AES/KCP SDP offer expected by Thing P2P", () => {
  const sdp = nativeSdpOffer("uid", "session", 1_700_000_000, "ufrag", "password", Buffer.alloc(16, 1));
  assert.match(sdp, /m=application 9 imm 6001/);
  assert.match(sdp, /a=rtpmap:6001 AES\/KCP 330/);
  assert.match(sdp, /a=aes-key:01010101010101010101010101010101/);
});

test("round-trips the native Thing MQTT 302 v2.2 frame", () => {
  const frame = encodeNative302V22({
    localKey: "0123456789abcdef", sequence: 42, timestamp: 1_700_000_000_000,
    data: { cmd: "connect_v3", args: { remote_id: "camera" } },
  });
  assert.deepEqual(decodeNative302V22(frame, "0123456789abcdef"), {
    data: { cmd: "connect_v3", args: { remote_id: "camera" } },
    timestamp: 1_700_000_000_000, sequence: 42,
  });
});

test("rejects a tampered native 302 frame", () => {
  const frame = encodeNative302V22({ localKey: "0123456789abcdef", data: { ok: true } });
  frame[frame.length - 1]! ^= 1;
  assert.throws(() => decodeNative302V22(frame, "0123456789abcdef"), /checksum/);
});

test("round-trips the native Thing MQTT 302 v2.3 GCM frame", () => {
  const frame = encodeNative302V23({
    localKey: "0123456789abcdef", sequence: 7, operation: 2, timestamp: 1_700_000_000_001,
    nonce: Buffer.alloc(12, 3), data: { type: "offer", trace_id: "trace" },
  });
  assert.deepEqual(decodeNative302V23(frame, "0123456789abcdef"), {
    data: { type: "offer", trace_id: "trace" }, timestamp: 1_700_000_000_001, sequence: 7, operation: 2,
  });
});
