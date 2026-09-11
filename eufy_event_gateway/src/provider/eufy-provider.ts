import { join } from "node:path";

import type { InventoryDiagnostic } from "../domain/types.js";
import { MegaClient } from "../mega/client.js";
import { ThingGatewayClient, type ThingAccountSession, type ThingDevice } from "../mega/thing-gateway.js";
import { WebClient } from "../mega/web-client.js";
import { decodeEventImage, isJpeg } from "../mega/image.js";
import { MegaPushReceiver, type MegaPushEvent } from "../mega/push.js";
import { WebRtcStream } from "../stream/web-rtc-stream.js";
import { NativeStreamSession } from "../stream/native-stream-session.js";
import type { CameraProvider, CaptchaChallenge, CaptchaProvider, ProviderEvents } from "./provider.js";

export interface EufyProviderConfig {
  readonly username: string;
  readonly password: string;
  readonly country: string;
  readonly webPortalPin: string | null;
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
  readonly adminUserId: string | null;
}

export class EufyProvider implements CameraProvider, CaptchaProvider {
  readonly #client: MegaClient;
  readonly #thingGateway: ThingGatewayClient;
  readonly #webClient: WebClient;
  readonly #devices = new Map<string, MegaInventoryDevice>();
  readonly #streams = new Map<string, WebRtcStream>();
  readonly #nativeStreams = new Map<string, NativeStreamSession>();
  #thingAccount: ThingAccountSession | null = null;
  #thingDevices = new Map<string, ThingDevice>();
  readonly #pushSnapshotQueues = new Map<string, Promise<void>>();
  #push: MegaPushReceiver | null = null;
  #events: ProviderEvents | null = null;
  #captchaChallenge: CaptchaChallenge | null = null;
  #captchaTarget: "mega" | "web" | null = null;
  #verificationRequired = false;

  constructor(private readonly config: EufyProviderConfig) {
    this.#client = new MegaClient({
      email: config.username,
      password: config.password,
      country: config.country,
      persistentDirectory: config.persistentDirectory,
    });
    this.#thingGateway = new ThingGatewayClient({ region: config.country.toLowerCase() === "au" ? "we" : config.country.toLowerCase() });
    this.#webClient = new WebClient({
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
      this.#captchaTarget = auth.state === "captcha-required" ? "mega" : null;
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
    const nativeDevice = this.#thingDevices.get(serial);
    if (nativeDevice && this.#thingAccount) {
      this.#nativeStreams.get(serial)?.close();
      const stream = new NativeStreamSession({ gateway: this.#thingGateway, account: this.#thingAccount, deviceId: nativeDevice.deviceId, localKey: nativeDevice.localKey, maxSeconds: this.config.maxStreamSeconds });
      this.#nativeStreams.set(serial, stream);
      await stream.start();
      this.#events?.streamStarted(serial, stream.output);
      stream.output.once("close", () => { if (this.#nativeStreams.get(serial) !== stream) return; this.#nativeStreams.delete(serial); this.#events?.streamStopped(serial); });
      return;
    }
    if (!this.config.webPortalPin || !this.#webClient.isAuthenticated) {
      throw new Error("Eufy Web Portal authentication and its access PIN are required for live viewing");
    }
    if (device.channel === null || !device.parentSerial || !device.adminUserId) {
      throw new Error("Eufy did not provide the live-view identity for this camera");
    }
    this.#streams.get(serial)?.close();
    const stream = new WebRtcStream(this.#webClient, this.config.webPortalPin, {
      serial: device.serial,
      stationSerial: device.parentSerial,
      channel: device.channel,
      adminUserId: device.adminUserId,
    }, this.config.maxStreamSeconds);
    this.#streams.set(serial, stream);
    await stream.start();
    this.#events?.streamStarted(serial, stream.output);
    stream.output.once("close", () => {
      if (this.#streams.get(serial) !== stream) return;
      this.#streams.delete(serial);
      this.#events?.streamStopped(serial);
    });
  }

  async stopStream(serial: string): Promise<void> {
    this.#nativeStreams.get(serial)?.close();
    this.#nativeStreams.delete(serial);
    this.#streams.get(serial)?.close();
    this.#streams.delete(serial);
    this.#events?.streamStopped(serial);
  }

  async close(): Promise<void> {
    this.#push?.close();
    this.#push = null;
    for (const stream of this.#streams.values()) stream.close();
    this.#streams.clear();
    for (const stream of this.#nativeStreams.values()) stream.close();
    this.#nativeStreams.clear();
    this.#events = null;
  }

  getCaptchaChallenge(): CaptchaChallenge | null {
    return this.#captchaChallenge;
  }

  isVerificationRequired(): boolean {
    return this.#verificationRequired;
  }

  async submitCaptcha(answer: string): Promise<void> {
    if (!this.#captchaChallenge || !this.#events) throw new Error("No Eufy CAPTCHA is waiting for an answer");
    const result = this.#captchaTarget === "web"
      ? await this.#webClient.connect(answer)
      : await this.#client.connect(undefined, answer);
    if (result.state === "captcha-required") {
      this.#captchaChallenge = result.captcha ?? null;
      throw new Error("Eufy did not accept the CAPTCHA answer");
    }
    if (result.state === "verification-required") {
      this.#captchaChallenge = null;
      this.#captchaTarget = null;
      this.#verificationRequired = true;
      this.#events.connection("authentication-required", "Eufy sent a six-digit verification code; enter it in the add-on web interface");
      return;
    }
    this.#captchaChallenge = null;
    this.#captchaTarget = null;
    this.#verificationRequired = false;
    await this.#completeStartup(this.#events);
  }

  async submitVerification(code: string): Promise<void> {
    if (!this.#verificationRequired || !this.#events) throw new Error("No Eufy verification is waiting for a code");
    const result = await this.#webClient.submitVerification(code);
    if (result.state !== "authenticated") throw new Error("Eufy did not accept the verification code");
    this.#verificationRequired = false;
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
        streamSupported: Boolean(
          this.config.webPortalPin && this.#webClient.isAuthenticated &&
          device.channel !== null && device.parentSerial && device.adminUserId,
        ),
      });
    }
    events.inventory(inventoryDiagnostics(devices));

    this.#thingAccount = null;
    this.#thingDevices.clear();
    try {
      this.#thingAccount = await this.#thingGateway.login(this.config.username, this.config.password, this.config.country);
      for (const device of await this.#thingGateway.listDevices(this.#thingAccount)) this.#thingDevices.set(device.deviceId, device);
      const nativeCameraCount = devices.filter((device) => isSupportedMegaCamera(device) && this.#thingDevices.has(device.serial)).length;
      if (nativeCameraCount > 0) events.connection("connected", `Native camera transport ready (${nativeCameraCount} cameras)`);
    } catch (error) {
      console.warn(`Native Thing camera transport unavailable: ${safeError(error)}`);
    }

    this.#push?.close();
    this.#push = new MegaPushReceiver(
      this.#client,
      join(this.config.persistentDirectory, "mega-push.json"),
      (event) => this.#handlePush(events, event),
    );
    await this.#push.start();
    if (devices.some((device) => isSupportedMegaCamera(device) && this.#thingDevices.has(device.serial))) {
      for (const device of devices) {
        if (!isSupportedMegaCamera(device)) continue;
        events.camera({ serial: device.serial, name: device.name, model: device.model, stationSerial: device.parentSerial, streamSupported: this.#thingDevices.has(device.serial) });
      }
      events.connection("connected", null);
      return;
    }
    if (!this.config.webPortalPin) {
      events.connection("connected", "Live viewing is disabled until a Web Portal Access PIN is configured");
      return;
    }
    const webAuth = await this.#webClient.connect();
    if (webAuth.state === "captcha-required") {
      this.#captchaChallenge = webAuth.captcha ?? null;
      this.#captchaTarget = "web";
      events.connection("authentication-required", "Open the add-on web interface to complete Eufy's live-view CAPTCHA");
      return;
    }
    if (webAuth.state === "verification-required") {
      this.#verificationRequired = true;
      events.connection("authentication-required", "Eufy sent a six-digit verification code; enter it in the add-on web interface");
      return;
    }
    for (const device of devices) {
      if (!isSupportedMegaCamera(device)) continue;
      events.camera({
        serial: device.serial,
        name: device.name,
        model: device.model,
        stationSerial: device.parentSerial,
        streamSupported: device.channel !== null && Boolean(device.parentSerial && device.adminUserId),
      });
    }
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
      adminUserId: isRecord(value.member) ? safeValue(value.member.admin_user_id, 128) : null,
    });
  }
  const adminUserIds = new Map(
    devices.filter((device) => device.adminUserId).map((device) => [device.serial, device.adminUserId!]),
  );
  return devices.map((device) => device.adminUserId || !device.parentSerial
    ? device
    : { ...device, adminUserId: adminUserIds.get(device.parentSerial) ?? null });
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
