import { join } from "node:path";

import type { InventoryDiagnostic } from "../domain/types.js";
import { MegaClient } from "../mega/client.js";
import { decodeEventImage, isJpeg } from "../mega/image.js";
import { MegaPushReceiver, type MegaPushEvent } from "../mega/push.js";
import type { CameraProvider, CaptchaChallenge, CaptchaProvider, ProviderEvents } from "./provider.js";

export interface EufyProviderConfig {
  readonly username: string;
  readonly password: string;
  readonly country: string;
  readonly persistentDirectory: string;
  readonly verifyCode?: string;
  readonly maxStreamSeconds: number;
}

export interface MegaInventoryDevice {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly parentSerial: string;
  readonly deviceType: number | null;
  readonly category: string | null;
  readonly channel: number | null;
  readonly p2pDid: string | null;
}

export class EufyProvider implements CameraProvider, CaptchaProvider {
  readonly #client: MegaClient;
  readonly #devices = new Map<string, MegaInventoryDevice>();
  readonly #pushSnapshotQueues = new Map<string, Promise<void>>();
  #push: MegaPushReceiver | null = null;
  #events: ProviderEvents | null = null;
  #captchaChallenge: CaptchaChallenge | null = null;

  constructor(private readonly config: EufyProviderConfig) {
    this.#client = new MegaClient({
      email: config.username,
      password: config.password,
      country: config.country,
      persistentDirectory: config.persistentDirectory,
    });
  }

  async start(events: ProviderEvents): Promise<void> {
    this.#events = events;
    const auth = await this.#client.connect(this.config.verifyCode);
    if (auth.state !== "authenticated") {
      this.#captchaChallenge = auth.captcha ?? null;
      const detail = auth.state === "captcha-required"
        ? "Open the add-on web interface to complete Eufy's CAPTCHA"
        : "Eufy requested an email verification code; add it to the add-on configuration and restart";
      events.connection("authentication-required", detail);
      return;
    }
    await this.#completeStartup(events);
  }

  async startStream(serial: string): Promise<void> {
    const device = this.#devices.get(serial);
    if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
    throw new Error("Live viewing is not yet available through the first-party Mega transport");
  }

  async stopStream(_serial: string): Promise<void> {}

  async close(): Promise<void> {
    this.#push?.close();
    this.#push = null;
    this.#events = null;
  }

  getCaptchaChallenge(): CaptchaChallenge | null {
    return this.#captchaChallenge;
  }

  async submitCaptcha(answer: string): Promise<void> {
    if (!this.#captchaChallenge || !this.#events) throw new Error("No Eufy CAPTCHA is waiting for an answer");
    const result = await this.#client.connect(undefined, answer);
    if (result.state === "captcha-required") {
      this.#captchaChallenge = result.captcha ?? null;
      throw new Error("Eufy did not accept the CAPTCHA answer");
    }
    if (result.state === "verification-required") {
      this.#captchaChallenge = null;
      this.#events.connection("authentication-required", "Eufy requested an email verification code; add it to the add-on configuration and restart");
      return;
    }
    this.#captchaChallenge = null;
    await this.#completeStartup(this.#events);
  }

  async #completeStartup(events: ProviderEvents): Promise<void> {
    const inventory = await this.#client.inventory();
    const devices = parseMegaInventory(inventory);
    this.#devices.clear();
    for (const device of devices) {
      this.#devices.set(device.serial, device);
      if (!isSupportedMegaCamera(device)) continue;
      events.camera({
        serial: device.serial,
        name: device.name,
        model: device.model,
        stationSerial: device.parentSerial,
        streamSupported: false,
      });
    }
    events.inventory(inventoryDiagnostics(devices));

    this.#push?.close();
    this.#push = new MegaPushReceiver(
      this.#client,
      join(this.config.persistentDirectory, "mega-push.json"),
      (event) => this.#handlePush(events, event),
    );
    await this.#push.start();
    events.connection("connected", null);
  }

  #handlePush(events: ProviderEvents, event: MegaPushEvent): void {
    const personName = personNameFromPush(event);
    events.pushDiagnostic({
      receivedAt: new Date().toISOString(),
      cameraSerial: event.cameraSerial,
      cameraName: event.cameraName,
      type: null,
      eventType: event.eventType,
      messageType: event.messageType,
      notificationStyle: event.notificationStyle,
      personName,
      hasPersonName: personName !== null,
      hasPictureUrl: event.pictureUrl !== null,
      hasFilePath: event.filePath !== null,
      hasFetchId: event.fetchId !== null,
      hasSenseId: event.senseId !== null,
    });
    if (!this.#devices.has(event.cameraSerial) || !isCameraDetection(event.eventType)) return;
    if (event.eventType === 3101) events.motion(event.cameraSerial, true);
    else events.person(event.cameraSerial, true, personName);
    if (event.pictureUrl) this.#queuePushSnapshot(events, event);
  }

  #queuePushSnapshot(events: ProviderEvents, event: MegaPushEvent): void {
    const previous = this.#pushSnapshotQueues.get(event.cameraSerial) ?? Promise.resolve();
    const current = previous.then(async () => {
      const picture = await downloadPushSnapshot(this.#client, event, this.#devices);
      if (picture) events.snapshot(event.cameraSerial, picture.data, "image/jpeg");
    }).catch((error: unknown) => {
      console.warn(`Eufy push snapshot unavailable for ${event.cameraSerial}: ${safeError(error)}`);
    });
    this.#pushSnapshotQueues.set(event.cameraSerial, current);
    void current.finally(() => {
      if (this.#pushSnapshotQueues.get(event.cameraSerial) === current) this.#pushSnapshotQueues.delete(event.cameraSerial);
    });
  }
}

export async function downloadPushSnapshot(
  client: Pick<MegaClient, "download">,
  event: Pick<MegaPushEvent, "pictureUrl" | "stationSerial">,
  devices: ReadonlyMap<string, Pick<MegaInventoryDevice, "p2pDid">>,
): Promise<{ data: Buffer } | null> {
  if (!event.pictureUrl) return null;
  const encoded = await client.download(event.pictureUrl);
  if (isJpeg(encoded)) return { data: encoded };
  const p2pDid = devices.get(event.stationSerial)?.p2pDid;
  if (!p2pDid) throw new Error("event image cannot be decoded without its HomeBase identity");
  const decoded = decodeEventImage(encoded, p2pDid);
  if (!isJpeg(decoded)) throw new Error("event image is not a valid JPEG");
  return { data: decoded };
}

export function parseMegaInventory(response: unknown): MegaInventoryDevice[] {
  if (!isRecord(response) || !Array.isArray(response.devices)) return [];
  const devices: MegaInventoryDevice[] = [];
  const seen = new Set<string>();
  for (const value of response.devices) {
    if (!isRecord(value)) continue;
    const serial = safeValue(value.device_sn, 128);
    if (!serial || seen.has(serial)) continue;
    seen.add(serial);
    const model = safeValue(value.device_model, 100) ?? "Unknown Eufy device";
    devices.push({
      serial,
      name: safeValue(value.device_name, 100) ?? model,
      model,
      parentSerial: safeValue(value.parent_sn, 128) ?? safeValue(value.station_sn, 128) ?? "",
      deviceType: integer(value.device_type),
      category: safeValue(value.category, 100),
      channel: integer(value.device_channel) ?? integer(value.channel),
      p2pDid: safeValue(value.p2p_did, 128),
    });
  }
  return devices;
}

export function inventoryDiagnostics(devices: readonly MegaInventoryDevice[]): InventoryDiagnostic[] {
  return devices.map((device) => ({
    serial: device.serial,
    name: device.name,
    model: device.model,
    sources: ["mega"],
    upstreamIsCamera: false,
    acceptedAsCamera: isSupportedMegaCamera(device),
    megaDeviceType: device.deviceType,
    category: device.category,
  }));
}

export function isSupportedMegaCamera(device: Pick<MegaInventoryDevice, "category" | "deviceType">): boolean {
  return device.category === "eufy_security" && (device.deviceType === 7 || device.deviceType === 8 || device.deviceType === 10031);
}

export function personNameFromPush(message: Pick<MegaPushEvent, "eventType" | "personName" | "content">): string | null {
  const structured = safeLabel(message.personName);
  if (structured) return isGenericPersonLabel(structured) ? null : structured;
  if (message.eventType !== 3102 && message.eventType !== 3111) return null;
  const content = message.content?.trim();
  if (!content || content.length > 300) return null;
  const match = /^(?:[^:]{1,100}:\s*)?(.{1,100}?)\s+(?:has been|was)\s+(?:spotted|detected)(?:\b|[.!])/i.exec(content);
  const candidate = safeLabel(match?.[1] ?? null);
  return candidate && !isGenericPersonLabel(candidate) ? candidate : null;
}

function isCameraDetection(eventType: number | null): boolean {
  return eventType === 3101 || eventType === 3102 || eventType === 3111 || eventType === 3112;
}

function isGenericPersonLabel(value: string): boolean {
  return /^(someone|stranger|unknown|unknown person|person)$/i.test(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message || error.name : "Unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeValue(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return candidate.length > 0 && candidate.length <= maxLength ? candidate : null;
}

function safeLabel(value: string | null | undefined): string | null {
  return safeValue(value, 100);
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}
