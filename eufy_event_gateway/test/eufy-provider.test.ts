import assert from "node:assert/strict";
import test from "node:test";

import { inventoryDiagnostics, parseMegaInventory, personNameFromPush } from "../src/provider/eufy-provider.js";

const event = (overrides: Partial<Parameters<typeof personNameFromPush>[0]>): Parameters<typeof personNameFromPush>[0] => ({
  eventType: null,
  personName: null,
  content: null,
  ...overrides,
});

test("uses a structured person name when Eufy supplies one", () => {
  assert.equal(personNameFromPush(event({ eventType: 3111, personName: "Alex" })), "Alex");
});

test("extracts a name from explicit HB3 identity notification text", () => {
  assert.equal(personNameFromPush(event({ eventType: 3111, content: "Alex has been detected." })), "Alex");
  assert.equal(personNameFromPush(event({ eventType: 3111, content: "Front of House: Alex was spotted in the garden" })), "Alex");
});

test("never infers an identity from generic or non-identity notifications", () => {
  assert.equal(personNameFromPush(event({ eventType: 3111, content: "Someone has been spotted" })), null);
  assert.equal(personNameFromPush(event({ eventType: 3111, content: "Stranger was spotted" })), null);
  assert.equal(personNameFromPush(event({ eventType: 3101, content: "Alex has been detected" })), null);
});

test("parses only whitelisted Mega inventory fields and de-duplicates serials", () => {
  const result = parseMegaInventory({ devices: [{
    device_sn: "T8113ABC", device_name: "Path", device_model: "T8113-Z", parent_sn: "T8030ABC",
    device_type: 8, device_channel: 3, category: "eufy_security", p2p_did: "ABC-123456-XYZ",
    device_key: "must-not-escape",
  }, { device_sn: "T8113ABC", device_name: "duplicate" }, { device_name: "missing serial" }] });

  assert.deepEqual(result, [{
    serial: "T8113ABC", name: "Path", model: "T8113-Z", parentSerial: "T8030ABC",
    deviceType: 8, category: "eufy_security", channel: 3, p2pDid: "ABC-123456-XYZ",
    adminUserId: null,
  }]);
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
});

test("inherits the HomeBase live-view account identity for child cameras", () => {
  const devices = parseMegaInventory({ devices: [
    { device_sn: "camera", parent_sn: "homebase", device_type: 8, category: "eufy_security" },
    { device_sn: "homebase", device_type: 18, category: "eufy_security", member: { admin_user_id: "owner" } },
  ] });
  assert.equal(devices.find(({ serial }) => serial === "camera")?.adminUserId, "owner");
});

test("reports all first-party Mega camera types and excludes the HomeBase", () => {
  const devices = parseMegaInventory({ devices: [
    { device_sn: "doorbell", device_name: "Door", device_model: "T8210", parent_sn: "homebase", device_type: 7, category: "eufy_security" },
    { device_sn: "battery", device_name: "Path", device_model: "T8113-Z", parent_sn: "homebase", device_type: 8, category: "eufy_security" },
    { device_sn: "wired", device_name: "Front", device_model: "T817L", parent_sn: "homebase", device_type: 10031, category: "eufy_security" },
    { device_sn: "homebase", device_name: "HomeBase", device_model: "T8030", device_type: 18, category: "eufy_security" },
  ] });
  assert.deepEqual(inventoryDiagnostics(devices).map(({ serial, acceptedAsCamera }) => [serial, acceptedAsCamera]), [
    ["doorbell", true], ["battery", true], ["wired", true], ["homebase", false],
  ]);
});
