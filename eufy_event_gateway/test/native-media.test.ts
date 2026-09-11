import assert from "node:assert/strict";
import test from "node:test";
import { assembleRelayHandshake, authorizationField, decryptNativeRecord, encryptNativeRecord, keepaliveFrame, mediaFrame, nativeAuthCredential, parseNativeRelayToken, parseRelayHandshake, relayAuthAck, relayAuthRequest, relayEndpoint, relayFrame, relayHandshakeSignature, unwrapMediaFrame } from "../src/stream/native-media.js";

test("round-trips native encrypted media records", () => {
  const key = Buffer.from("0123456789abcdef");
  const value = Buffer.from("native media");
  assert.deepEqual(decryptNativeRecord(key, encryptNativeRecord(key, value)), value);
});

test("frames and authenticates native relay media", () => {
  const key = Buffer.from("0123456789abcdef");
  const segment = Buffer.from([1, 2, 3]);
  const frame = mediaFrame(key, segment);
  assert.equal(frame[0], 0xf6);
  assert.deepEqual(unwrapMediaFrame(key, frame.subarray(4)), segment);
  assert.deepEqual(keepaliveFrame(), relayFrame(0xf5, Buffer.alloc(0)));
});

test("derives the channel-zero credential", () => {
  assert.equal(nativeAuthCredential("password", "local-key"), "96c22ce88b339687a430aee3b9550b60");
});

test("builds the native relay handshake materials", () => {
  const token = parseNativeRelayToken({ urls: ["tcp4:relay.example:1443"], username: "123:ignored", credential: "credential", sessionId: "session" });
  assert.deepEqual(relayEndpoint(token), { host: "relay.example", port: 1443 });
  const request = JSON.parse(relayAuthRequest("camera", "user", "random").toString());
  assert.equal(request.authorization, "random=random");
  const ack = JSON.parse(relayAuthAck("camera", "user", "sig").toString());
  assert.equal(authorizationField(ack.authorization, "signature"), "sig");
  assert.equal(relayHandshakeSignature("credential", "123", "camera", "session", "user", "random").length, 64);
});

test("round-trips a native relay handshake frame", () => {
  const key = Buffer.from("0123456789abcdef");
  const frame = assembleRelayHandshake(0, key, Buffer.alloc(16, 4), "session", "user", Buffer.from(JSON.stringify({ authorization: "random=x" })));
  assert.deepEqual(parseRelayHandshake(key, frame.subarray(4, -32)), { authorization: "random=x" });
});
