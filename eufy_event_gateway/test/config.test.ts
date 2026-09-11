import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("allows a token-free gateway only on loopback", () => {
  assert.equal(loadConfig({ EUFY_GATEWAY_PROVIDER: "simulated" }).host, "127.0.0.1");
  assert.throws(
    () => loadConfig({ EUFY_GATEWAY_PROVIDER: "simulated", EUFY_GATEWAY_HOST: "0.0.0.0" }),
    /API_TOKEN is required/,
  );
});

test("allows LAN binding when an API token is configured", () => {
  const config = loadConfig({
    EUFY_GATEWAY_PROVIDER: "simulated",
    EUFY_GATEWAY_HOST: "0.0.0.0",
    EUFY_GATEWAY_API_TOKEN: "a-long-random-token-with-32-chars!",
  });
  assert.equal(config.apiToken, "a-long-random-token-with-32-chars!");
});

test("rejects weak API tokens", () => {
  assert.throws(
    () => loadConfig({ EUFY_GATEWAY_PROVIDER: "simulated", EUFY_GATEWAY_API_TOKEN: "too-short" }),
    /at least 32 characters/,
  );
});

test("passes through a temporary Eufy email verification code", () => {
  const config = loadConfig({
    EUFY_GATEWAY_PROVIDER: "simulated",
    EUFY_VERIFY_CODE: " 123456 ",
  });
  assert.equal(config.eufy.verifyCode, "123456");
});

test("normalizes the Eufy Web Portal access PIN", () => {
  const config = loadConfig({
    EUFY_GATEWAY_PROVIDER: "simulated",
    EUFY_WEB_PORTAL_PIN: " 246810 ",
  });
  assert.equal(config.eufy.webPortalPin, "246810");
});
