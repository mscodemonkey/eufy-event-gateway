import assert from "node:assert/strict";
import test from "node:test";

import { parsePushEvent } from "../src/mega/push.js";

test("normalizes a nested HomeBase 3 Mega notification", () => {
  const result = parsePushEvent({ payload: JSON.stringify({
    station_sn: "station", device_sn: "camera", content: "Alex has been detected.",
    payload: { name: "Path", a: "3111", nick_name: "Alex", pic_url: "https://example.invalid/image", msg_type: 1 },
  }) });
  assert.deepEqual(result, {
    cameraSerial: "camera", stationSerial: "station", cameraName: "Path", eventType: 3111,
    messageType: 1, notificationStyle: null, personName: "Alex", content: "Alex has been detected.",
    pictureUrl: "https://example.invalid/image", filePath: null, fetchId: null, senseId: null,
  });
});

test("rejects notifications without a device identity", () => {
  assert.equal(parsePushEvent({ payload: "{}" }), null);
});
