import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptEnvelope,
  encryptEnvelope,
  loginHash,
  megaUserToken,
  requestSignature,
  sharedAesKey,
  sharedSigningKey,
} from "../src/mega/crypto.js";

test("signs a Mega request using the protocol's exact input order", () => {
  assert.equal(
    requestSignature("00112233445566778899aabbccddeeff", "1700000000", "nonce", "payload"),
    "992d810613a0b5b888bcbed6f3527780b4dfad6574cf56a8066eaca783677217",
  );
});

test("round-trips a Mega AES envelope with a fixed IV", () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const envelope = encryptEnvelope('{"house_id":""}', key, Buffer.alloc(16, 0x11));
  assert.equal(decryptEnvelope(envelope, key), '{"house_id":""}');
});

test("derives the Mega AES and signature halves independently", () => {
  const shared = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
  assert.equal(sharedAesKey(shared).toString("hex"), "00112233445566778899aabbccddeeff");
  assert.equal(sharedSigningKey(shared), "00112233445566778899aabbccddeeff");
  assert.equal(loginHash("device", "user@example.invalid", "password").length, 64);
  assert.equal(megaUserToken("user-id").length, 32);
});
