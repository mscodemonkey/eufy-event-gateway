import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { PushReceiver } from "@eneris/push-receiver";
import type { Types } from "@eneris/push-receiver/dist/client.js";

import type { MegaClient } from "./client.js";

const FIREBASE = {
  projectId: "batterycam-3250a",
  appId: "1:348804314802:android:440a6773b3620da7",
  apiKey: "AIzaSyCSz1uxGrHXsEktm7O3_wv-uLGpC9BvXR8",
  messagingSenderId: "348804314802",
};

export interface MegaPushEvent {
  readonly cameraSerial: string;
  readonly stationSerial: string;
  readonly cameraName: string | null;
  readonly eventType: number | null;
  readonly messageType: number | null;
  readonly notificationStyle: number | null;
  readonly personName: string | null;
  readonly content: string | null;
  readonly pictureUrl: string | null;
  readonly filePath: string | null;
  readonly fetchId: number | null;
  readonly senseId: string | null;
}

interface StoredPushState {
  readonly credentials?: Types.Credentials;
  persistentIds: string[];
}

export class MegaPushReceiver {
  #receiver: PushReceiver | null = null;
  #state: StoredPushState = { persistentIds: [] };

  constructor(
    private readonly client: MegaClient,
    private readonly path: string,
    private readonly onEvent: (event: MegaPushEvent) => void,
  ) {}

  async start(): Promise<void> {
    this.#state = await loadState(this.path);
    const receiver = new PushReceiver({
      firebase: FIREBASE,
      bundleId: "com.oceanwing.battery.cam",
      chromeId: "org.chromium.linux",
      chromePlatform: 3,
      timeZone: "Australia/Brisbane",
      ...(this.#state.credentials ? { credentials: this.#state.credentials } : {}),
      persistentIds: this.#state.persistentIds,
    });
    guardReceiverDestroy(receiver);
    this.#receiver = receiver;
    receiver.onCredentialsChanged(({ newCredentials }) => {
      this.#state = { ...this.#state, credentials: newCredentials };
      void saveState(this.path, this.#state);
    });
    receiver.onNotification(({ message, persistentId }) => {
      if (persistentId && !this.#state.persistentIds.includes(persistentId)) {
        this.#state.persistentIds = [...this.#state.persistentIds.slice(-99), persistentId];
        void saveState(this.path, this.#state);
      }
      const event = parsePushEvent(message.data);
      if (event) this.onEvent(event);
    });
    await receiver.connect();
    if (!receiver.fcmToken) throw new Error("FCM did not issue a push token");
    await this.client.registerPushToken(receiver.fcmToken);
  }

  close(): void {
    this.#receiver?.destroy();
    this.#receiver = null;
  }
}

function guardReceiverDestroy(receiver: PushReceiver): void {
  const destroy = receiver.destroy.bind(receiver);
  receiver.destroy = () => {
    // The dependency rejects its private readiness promise during every socket
    // retry but does not consume that rejection. Guard both promises it owns
    // across destroy() so a transient Google MCS outage cannot kill the app.
    void receiver.whenReady.catch(() => undefined);
    destroy();
    void receiver.whenReady.catch(() => undefined);
  };
}

export function parsePushEvent(data: unknown): MegaPushEvent | null {
  if (!isRecord(data)) return null;
  const outer = nestedRecord(data.payload) ?? data;
  const payload = nestedRecord(outer.payload) ?? outer;
  const cameraSerial = text(outer.device_sn) ?? text(payload.device_sn) ?? text(outer.station_sn);
  if (!cameraSerial) return null;
  return {
    cameraSerial,
    stationSerial: text(outer.station_sn) ?? text(payload.station_sn) ?? cameraSerial,
    cameraName: text(payload.name) ?? text(payload.device_name) ?? text(payload.n),
    eventType: integer(payload.a) ?? integer(payload.event_type),
    messageType: integer(payload.msg_type),
    notificationStyle: integer(payload.notification_style),
    personName: text(payload.f) ?? text(payload.nick_name),
    content: text(outer.content) ?? text(payload.content),
    pictureUrl: text(payload.pic_url),
    filePath: text(payload.file_path) ?? text(payload.p),
    fetchId: integer(payload.fetch_id) ?? integer(payload.i),
    senseId: text(payload.sense_id) ?? text(payload.j),
  };
}

async function loadState(path: string): Promise<StoredPushState> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) return { persistentIds: [] };
    return {
      ...(isRecord(value.credentials) ? { credentials: value.credentials as unknown as Types.Credentials } : {}),
      persistentIds: Array.isArray(value.persistentIds)
        ? value.persistentIds.filter((entry): entry is string => typeof entry === "string").slice(-100)
        : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return { persistentIds: [] };
    throw error;
  }
}

async function saveState(path: string, state: StoredPushState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return result.length > 0 && result.length <= 2_048 ? result : null;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}
