import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WebClient, webSignalHost } from "../src/mega/web-client.js";
import {
  decryptWebEnvelope,
  deriveWebKey,
  encryptWebEnvelope,
  WEB_PRESET_KEY,
  webKeyPair,
} from "../src/mega/web-crypto.js";

test("performs Eufy's encrypted web login and requests a live signalling ticket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-web-client-"));
  const apiServer = webKeyPair();
  const signalServer = webKeyPair();
  let apiSharedKey = "";
  let expectedSignalKey = "";
  let loginCalls = 0;
  let pinVerificationCalls = 0;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    if (url === "https://extend.eufylife.com/domain/web/AU") {
      assert.equal(new Headers(init?.headers).get("Web-Country"), "AU");
      return jsonResponse({ code: 0, data: { domain: "security-app.eufylife.com" } });
    }
    if (url.endsWith("/v3/openapi/oauth/key/exchange")) {
      const body = JSON.parse(String(init?.body)) as { client_public_key: string };
      assertSigned(init, WEB_PRESET_KEY, body.client_public_key);
      const clientPublicKey = decryptWebEnvelope(body.client_public_key, WEB_PRESET_KEY);
      apiSharedKey = deriveWebKey(apiServer.privateKey, clientPublicKey, true);
      return jsonResponse({
        code: 0,
        data: { server_public_key: encryptWebEnvelope(apiServer.publicKey, WEB_PRESET_KEY) },
      });
    }
    if (url.endsWith("/v3/passport/login")) {
      loginCalls += 1;
      const body = String(init?.body);
      assertSigned(init, apiSharedKey, body);
      const payload = JSON.parse(decryptWebEnvelope(body, apiSharedKey)) as {
        email: string;
        password: string;
        client_secret_info: { public_key: string };
      };
      assert.equal(payload.email, "guest@example.com");
      assert.notEqual(payload.password, "secret-password");
      assert.match(payload.password, /^[A-Za-z0-9+/]+=*$/);
      expectedSignalKey = deriveWebKey(signalServer.privateKey, payload.client_secret_info.public_key);
      return encryptedResponse(apiSharedKey, {
        auth_token: "web-auth-token",
        user_id: "web-user-id",
        token_expires_at: 2_000_000_000,
        server_secret_info: { public_key: signalServer.publicKey },
      });
    }
    if (url === "https://security-smart.eufylife.com/v1/smart/ws/sign") {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("X-Auth-Token"), "web-auth-token");
      assert.equal(headers.get("Web-Country"), "AU");
      return jsonResponse({ code: 0, data: "signal-ticket" });
    }
    if (url.endsWith("/v3/web/wp/verify_captcha")) {
      pinVerificationCalls += 1;
      const body = String(init?.body);
      assertSigned(init, apiSharedKey, body);
      const payload = JSON.parse(decryptWebEnvelope(body, apiSharedKey)) as { captcha: string };
      assert.equal(payload.captcha, "123456");
      const headers = new Headers(init?.headers);
      if (pinVerificationCalls === 1) {
        assert.equal(headers.get("X-Auto-Ts"), "0");
        return jsonResponse({ code: 170003 });
      }
      assert.equal(headers.get("X-Auto-Ts"), "1700000000");
      return jsonResponse({ code: 0 });
    }
    throw new Error(`Unexpected Eufy test request: ${url}`);
  };

  const client = new WebClient({
    email: "guest@example.com",
    password: "secret-password",
    country: "au",
    persistentDirectory: directory,
    fetch: mockFetch,
    now: () => 1_700_000_000_000,
  });
  assert.deepEqual(await client.connect(), { state: "authenticated" });
  assert.equal(client.isAuthenticated, true);
  assert.equal(client.signalKey, expectedSignalKey);
  await client.verifyPortalPin("123456");
  await client.verifyPortalPin("123456");
  assert.equal(pinVerificationCalls, 2);
  assert.deepEqual(await client.signal(), { sign: "signal-ticket", host: "security-smart.eufylife.com" });
  assert.equal(loginCalls, 1);

  const restored = new WebClient({
    email: "guest@example.com",
    password: "secret-password",
    country: "AU",
    persistentDirectory: directory,
    fetch: mockFetch,
    now: () => 1_700_000_000_000,
  });
  assert.deepEqual(await restored.connect(), { state: "authenticated" });
  assert.equal(restored.signalKey, expectedSignalKey);
  assert.equal(loginCalls, 1);
});

test("selects Eufy's regional signalling service independently of its API host", () => {
  assert.equal(webSignalHost("security-app.eufylife.com"), "security-smart.eufylife.com");
  assert.equal(webSignalHost("security-app-eu.eufylife.com"), "security-smart-eu.eufylife.com");
  assert.equal(webSignalHost("security-app-eu-qa.eufylife.com"), "security-smart-eu.eufylife.com");
  assert.equal(webSignalHost("security-app-ie.eufylife.com"), "security-smart-ie.eufylife.com");
  assert.equal(webSignalHost("security-app-ie-qa.eufylife.com"), "security-smart-ie.eufylife.com");
});

function assertSigned(init: RequestInit | undefined, key: string, data: string): void {
  const headers = new Headers(init?.headers);
  const timestamp = headers.get("X-Request-Ts");
  const nonce = headers.get("X-Request-Once");
  assert.ok(timestamp);
  assert.ok(nonce);
  assert.equal(
    headers.get("X-Signature"),
    createHmac("sha256", key).update(`${timestamp}+${nonce}+${data}`).digest("hex"),
  );
}

function encryptedResponse(key: string, data: Record<string, unknown>): Response {
  return jsonResponse({ code: 0, data: encryptWebEnvelope(JSON.stringify(data), key) });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
