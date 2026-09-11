import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MegaSessionStore } from "../src/mega/session-store.js";

test("migrates a valid stored Mega session and writes its private replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-session-"));
  const legacyPath = join(directory, "persistent.json");
  const currentPath = join(directory, "mega-session.json");
  try {
    await writeFile(legacyPath, JSON.stringify({ megaApi: {
      ab: "au", openudid: "device", login_hash: "hash", cloud_token: "token",
      cloud_token_expiration: 2_000_000_000, user_id: "user", megaDomain: "mega-eu-pr.eufy.com",
      domains: { house: "house" },
      identities: { host: { keyIdent: "id", sharedKey: "key", clientPublicKey: "public" } },
    } }));
    const store = new MegaSessionStore(currentPath, legacyPath);
    const session = await store.load();
    assert.equal(session?.authToken, "token");
    assert.equal(session?.country, "au");
    assert.ok(session);
    await store.save(session);
    assert.equal((await stat(currentPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(currentPath, "utf8")).version, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores malformed session data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-session-bad-"));
  try {
    const path = join(directory, "mega-session.json");
    await writeFile(path, "not json");
    assert.equal(await new MegaSessionStore(path).load(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
