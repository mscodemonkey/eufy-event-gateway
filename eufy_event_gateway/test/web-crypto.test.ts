import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptWebEnvelope,
  deriveWebKey,
  encryptWebEnvelope,
  webKeyPair,
  webRequestSignature,
} from "../src/mega/web-crypto.js";

test("derives the same P-256 secret on both sides", () => {
  const first = webKeyPair();
  const second = webKeyPair();
  assert.equal(deriveWebKey(first.privateKey, second.publicKey), deriveWebKey(second.privateKey, first.publicKey));
});

test("round-trips encrypted API and signalling envelopes", () => {
  const key = "00112233445566778899aabbccddeeff";
  const value = JSON.stringify({ camera: "Path", active: true });
  assert.equal(decryptWebEnvelope(encryptWebEnvelope(value, key), key), value);
  assert.equal(decryptWebEnvelope(encryptWebEnvelope(value, key, false), key, false), value);
});

test("signs requests with the textual hexadecimal key used by Eufy's web API", () => {
  assert.equal(
    webRequestSignature("00112233445566778899aabbccddeeff", "1700000000", "abcdef", "payload"),
    "928286a61334a6a8740a88e2cc0609aa12bac35a3665e4f695d1f840e6822faa",
  );
});
