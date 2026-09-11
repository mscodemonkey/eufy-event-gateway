import { join } from "node:path";

import { loadConfig } from "./config.js";
import { GatewayState } from "./domain/gateway-state.js";
import { EufyProvider } from "./provider/eufy-provider.js";
import type { CameraProvider, ProviderEvents } from "./provider/provider.js";
import type { CaptchaProvider } from "./provider/provider.js";
import { SimulatedProvider } from "./provider/simulated-provider.js";
import { GatewayServer } from "./server.js";
import { SnapshotStore } from "./storage/snapshot-store.js";
import { LiveStreamManager } from "./stream/live-stream-manager.js";

const config = loadConfig();
const state = new GatewayState();
const snapshots = new SnapshotStore(config.dataDirectory);
await snapshots.initialize();

let simulatedProvider: SimulatedProvider | null = null;
let provider: CameraProvider;
let captchaProvider: CaptchaProvider | null = null;
if (config.provider === "simulated") {
  simulatedProvider = new SimulatedProvider();
  provider = simulatedProvider;
} else {
  if (!config.eufy.username || !config.eufy.password) {
    throw new Error("EUFY_USERNAME and EUFY_PASSWORD are required when EUFY_GATEWAY_PROVIDER=eufy");
  }
  const eufyProvider = new EufyProvider({
    username: config.eufy.username,
    password: config.eufy.password,
    country: config.eufy.country,
    webPortalPin: config.eufy.webPortalPin,
    persistentDirectory: join(config.dataDirectory, "eufy-client"),
    maxStreamSeconds: config.maxStreamSeconds,
    ...(config.eufy.verifyCode ? { verifyCode: config.eufy.verifyCode } : {}),
  });
  provider = eufyProvider;
  captchaProvider = eufyProvider;
}

const streams = new LiveStreamManager(state, snapshots, provider, config.streamGraceMilliseconds);
const providerEvents: ProviderEvents = {
  camera(identity) {
    state.registerCamera(identity);
    const stored = snapshots.getInfo(identity.serial);
    if (stored) state.restoreSnapshot(identity.serial, stored);
  },
  connection(connectionState, detail) {
    state.updateConnection(connectionState, detail);
    const suffix = detail ? `: ${detail}` : "";
    if (connectionState === "error") console.error(`Eufy connection ${connectionState}${suffix}`);
    else console.log(`Eufy connection ${connectionState}${suffix}`);
  },
  motion(serial, detected) {
    if (state.hasCamera(serial)) state.recordMotion(serial, detected);
  },
  person(serial, detected, personName) {
    if (state.hasCamera(serial)) state.recordPerson(serial, detected, personName);
  },
  snapshot(serial, data, contentType) {
    if (!state.hasCamera(serial)) return;
    void snapshots.write(serial, data, contentType, "event").then((info) => state.updateSnapshot(serial, info));
  },
  pushDiagnostic(diagnostic) {
    state.recordPushDiagnostic(diagnostic);
  },
  inventory(diagnostics) {
    state.updateInventoryDiagnostics(diagnostics);
  },
  streamStarted(serial, video) {
    if (state.hasCamera(serial)) streams.attachSource(serial, video);
  },
  streamStopped(serial) {
    if (state.hasCamera(serial)) streams.markStopped(serial);
  },
};

const server = new GatewayServer(config, state, snapshots, streams, simulatedProvider, captchaProvider);
await server.listen();
console.log(`Eufy gateway listening on http://${config.host}:${config.port} (${config.provider} provider)`);

void provider.start(providerEvents).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Provider failed to start";
  state.updateConnection("error", message);
  console.error(`Eufy provider failed: ${message}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  state.close();
  await server.close();
  await streams.close();
  await provider.close();
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
