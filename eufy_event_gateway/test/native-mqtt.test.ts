import assert from "node:assert/strict";
import test from "node:test";

import { cameraTopics, nativeMqttClientId, NativeMqttTransport, thingMqttCredentials } from "../src/mega/native-mqtt.js";

test("matches the native app MQTT client-id convention", () => {
  assert.equal(nativeMqttClientId({ appName: "eufy_security", userId: "user", endpointAddress: "thing-a.iot.test" }, "uuid"),
    "android-eufy_security-user-uuidthinga.iot.test");
});

test("uses the native Thing MQTT camera topic pair", () => {
  assert.deepEqual(cameraTopics("camera-1"), {
    outgoing: "smart/mb/out/camera-1",
    incoming: "smart/mb/in/camera-1",
  });
  assert.throws(() => cameraTopics("camera/1"), /Invalid Eufy device identifier/);
});

test("native MQTT transport starts disconnected and parses endpoint defaults without credentials", () => {
  const transport = new NativeMqttTransport({
    endpointAddress: "iot.example.test",
    thingName: "thing",
    userId: "user",
    appName: "app",
    certificatePem: "cert",
    privateKey: "key",
    rootCaPem: "ca",
  }, "client");
  assert.equal(transport.connected, false);
  transport.close();
});

test("derives the Thing SDK MQTT identity without exposing account secrets", () => {
  const identity = thingMqttCredentials({
    appId: "client", partnerIdentity: "p1000018", chKey: "ec9709a4", uid: "uid",
    token: "session", ecode: "ecode", broker: "m1.example", deviceFingerprint: "device",
  });
  assert.match(identity.clientId, /^com\.tuya\.smartlife_mb_device_[0-9a-f]{32}_DEFAULT$/);
  assert.match(identity.username, /^p1000018_v1_clientec9709a4_mb_session/);
  assert.equal(identity.password.length, 16);
});
