import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WebSessionStore } from "../src/mega/web-session-store.js";
import type { WebSession } from "../src/mega/web-types.js";

function session(): WebSession {
  return {
    version: 1,
    country: "AU",
    loginHash: "login-hash",
    host: "security-app.eufylife.com",
    authToken: "auth-token",
    userId: "user-id",
    tokenExpiresAt: 2_000_000_000,
    clientPrivateKey: "client-private-key",
    clientPublicKey: "client-public-key",
    serverPublicKey: "server-public-key",
    apiIdentity: {
      keyIdent: "key-ident",
      sharedKey: "shared-key",
      privateKey: "api-private-key",
      publicKey: "api-public-key",
    },
  };
}

test("stores and restores a private web session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-web-session-"));
  const path = join(directory, "session.json");
  const store = new WebSessionStore(path);
  const value = session();
  await store.save(value);
  assert.deepEqual(await store.load(), value);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("ignores malformed web session data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-web-session-invalid-"));
  const path = join(directory, "session.json");
  await writeFile(path, JSON.stringify({ version: 1, authToken: "partial" }));
  assert.equal(await new WebSessionStore(path).load(), null);
  assert.equal((await readFile(path, "utf8")).includes("partial"), true);
});
