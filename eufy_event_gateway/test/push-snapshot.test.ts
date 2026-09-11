import assert from "node:assert/strict";
import test from "node:test";

import { downloadPushSnapshot } from "../src/provider/eufy-provider.js";

const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);

test("downloads a plain JPEG from a Mega event", async () => {
  const picture = await downloadPushSnapshot(
    { download: async () => jpeg },
    { pictureUrl: "https://example.invalid/signed-event-image", stationSerial: "station-1" },
    new Map(),
  );
  assert.deepEqual(picture, { data: jpeg });
});

test("does not download when the event has no picture URL", async () => {
  let downloaded = false;
  const picture = await downloadPushSnapshot(
    { download: async () => { downloaded = true; return jpeg; } },
    { pictureUrl: null, stationSerial: "station-1" },
    new Map(),
  );
  assert.equal(picture, null);
  assert.equal(downloaded, false);
});

test("requires the parent HomeBase identity for an encoded event image", async () => {
  await assert.rejects(downloadPushSnapshot(
    { download: async () => Buffer.from("encoded") },
    { pictureUrl: "https://example.invalid/image", stationSerial: "station-1" },
    new Map(),
  ), /HomeBase identity/);
});
