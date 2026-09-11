import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MegaClient } from "../src/mega/client.js";
import { decryptEnvelope, encryptEnvelope, loginHash, sharedAesKey } from "../src/mega/crypto.js";

test("uses the supported Mega inventory request and decrypts its response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-client-"));
  const sharedKey = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
  const host = "app-openapi-eu-pr.eufy.com";
  try {
    await writeFile(join(directory, "mega-session.json"), JSON.stringify({
      version: 1, country: "au", openUdid: "device", loginHash: loginHash("device", "user@example.invalid", "password"),
      authToken: "token", tokenExpiresAt: 2_000_000_000, userId: "user", megaDomain: "mega-eu-pr.eufy.com",
      domains: {}, identities: { [host]: { keyIdent: "identity", sharedKey, clientPublicKey: "public" } },
    }));
    const requests: Array<{ url: string; body: string; headers: Headers }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const body = String(init?.body ?? "");
      requests.push({ url: String(input), body, headers: new Headers(init?.headers) });
      const data = encryptEnvelope(JSON.stringify({ devices: [{ device_sn: "camera" }], groups: [] }), sharedAesKey(sharedKey), Buffer.alloc(16, 1));
      return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    };
    const client = new MegaClient({
      email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
      minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, fetch: fakeFetch,
    });
    assert.deepEqual(await client.connect(), { state: "authenticated" });
    assert.deepEqual(await client.inventory(), { devices: [{ device_sn: "camera" }], groups: [] });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://app-house-eu-pr.eufy.com/app/house/get_devs_list");
    assert.deepEqual(JSON.parse(decryptEnvelope(requests[0]!.body, sharedAesKey(sharedKey))), { house_id: "", device_sns: {} });
    assert.equal(requests[0]?.headers.get("x-key-ident"), "identity");
    assert.equal(requests[0]?.headers.has("x-signature"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
