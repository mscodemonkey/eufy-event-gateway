/**
 * Adapts Eufy's Mega cloud and PPCS camera protocols to the gateway contract.
 *
 * Startup authenticates one account, parses and filters inventory, retrieves
 * station DSK material, registers Firebase push delivery, and reports camera
 * identities to `GatewayState`. Push callbacks become motion/person events
 * and verified JPEG snapshots. A live request creates a first-party PPCS
 * session and exposes only its byte stream to `LiveStreamManager`. This is the
 * sole production translation point from Eufy-specific data to normalized
 * provider callbacks; Home Assistant-specific naming stays downstream.
 */
import { join } from "node:path";

import type { InventoryDiagnostic } from "../domain/types.js";
import { createLogger } from "../logging.js";
import { MegaClient } from "../mega/client.js";
import { decodeEventImage, isJpeg } from "../mega/image.js";
import { MegaPushReceiver, type MegaPushEvent } from "../mega/push.js";
import { FirstPartyPpcsSession } from "../stream/first-party-ppcs.js";
import type { CameraProvider, CaptchaChallenge, CaptchaProvider, ProviderEvents } from "./provider.js";

const logger = createLogger("provider");

/** Credentials, storage, and transport limits for one Mega account. */
export interface EufyProviderConfig {
  readonly username: string;
  readonly password: string;
  readonly country: string;
  readonly persistentDirectory: string;
  readonly verifyCode?: string;
  readonly maxStreamSeconds: number;
}

/** Normalized Mega inventory row used to decide camera support and routing. */
export interface MegaInventoryDevice {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly parentSerial: string;
  readonly deviceType: number | null;
  readonly category: string | null;
  readonly channel: number | null;
  readonly p2pDid: string | null;
  readonly p2pConnection: string | null;
  readonly cipherId: number | null;
  readonly adminUserId: string | null;
}

/** Safe, grouped inventory evidence suitable for copied support logs. */
export interface InventoryLogSummary {
  readonly count: number;
  readonly model: string;
  readonly deviceType: number | null;
  readonly category: string | null;
  readonly hasParent: boolean;
  readonly hasChannel: boolean;
  readonly acceptedAsCamera: boolean;
  readonly stationPresent: boolean;
  readonly stationPpcsReady: boolean;
  readonly stationDskReady: boolean;
  readonly streamSupported: boolean;
}

/**
 * Bridges Mega cloud observations and first-party PPCS streams into callbacks.
 *
 * Startup is deliberately ordered. The provider authenticates, discovers all
 * devices, obtains the station keys needed for camera sessions, then starts
 * push delivery. A stream request creates one PPCS session per camera and
 * closes it when the last consumer releases the source.
 */
export class EufyProvider implements CameraProvider, CaptchaProvider {
  readonly #client: MegaClient;
  readonly #devices = new Map<string, MegaInventoryDevice>();
  readonly #ppcsStreams = new Map<string, FirstPartyPpcsSession>();
  readonly #dskKeys = new Map<string, { readonly key: string; readonly expiresAt: number | null }>();
  readonly #cipherKeys = new Map<number, string>();
  readonly #pushSnapshotQueues = new Map<string, Promise<void>>();
  #push: MegaPushReceiver | null = null;
  #events: ProviderEvents | null = null;
  #captchaChallenge: CaptchaChallenge | null = null;
  #verificationRequired = false;

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
      this.#verificationRequired = auth.state === "verification-required";
      const detail = auth.state === "captcha-required"
        ? "Open the add-on web interface to complete Eufy's CAPTCHA"
        : "Open the add-on web interface to enter Eufy's email verification code";
      events.connection("authentication-required", detail);
      return;
    }
    await this.#completeStartup(events);
  }

  async startStream(serial: string): Promise<void> {
    const device = this.#devices.get(serial);
    if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
    const station = device.parentSerial ? this.#devices.get(device.parentSerial) : null;
    const dsk = station ? this.#dskKeys.get(station.serial) : null;

    // The production path is deliberately first-party Mega/PPCS.
    if (station?.p2pDid && station.p2pConnection && dsk && device.channel !== null) {
      this.#ppcsStreams.get(serial)?.close();
      const stream = new FirstPartyPpcsSession({
        stationSerial: station.serial, p2pDid: station.p2pDid, appConnection: station.p2pConnection,
        dskKey: dsk.key, channel: device.channel, cameraModel: device.model, accountId: device.adminUserId,
        homeBaseAttached: Boolean(device.parentSerial),
        resolveCipherKey: async (cipherId) => {
          const cached = this.#cipherKeys.get(cipherId);
          if (cached) return cached;
          if (!station.adminUserId) return undefined;
          try {
            const ciphers = await this.#client.getCiphers([cipherId], station.adminUserId, station.serial);
            for (const cipher of ciphers) {
              const id = typeof cipher.cipher_id === "number" ? cipher.cipher_id : Number(cipher.cipher_id);
              const key = typeof cipher.ecc_private_key === "string" ? cipher.ecc_private_key : "";
              if (Number.isInteger(id) && key) this.#cipherKeys.set(id, key);
            }
          } catch (error) {
            logger.warn("cipher_lookup_unavailable", `Mega cipher lookup unavailable: ${safeError(error)}`);
          }
          return this.#cipherKeys.get(cipherId);
        },
        maxSeconds: this.config.maxStreamSeconds,
      });
      this.#ppcsStreams.set(serial, stream);
      await stream.start();
      this.#events?.streamStarted(serial, stream.output);
      stream.output.once("close", () => { if (this.#ppcsStreams.get(serial) !== stream) return; this.#ppcsStreams.delete(serial); this.#events?.streamStopped(serial); });
      return;
    }
    throw new Error("First-party PPCS camera transport is unavailable for this camera");
  }

  async stopStream(serial: string): Promise<void> {
    this.#ppcsStreams.get(serial)?.close();
    this.#ppcsStreams.delete(serial);
    this.#events?.streamStopped(serial);
  }

  async close(): Promise<void> {
    this.#push?.close();
    this.#push = null;
    for (const stream of this.#ppcsStreams.values()) stream.close();
    this.#ppcsStreams.clear();
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
    const result = await this.#client.connect(undefined, answer);
    if (result.state === "captcha-required") {
      this.#captchaChallenge = result.captcha ?? null;
      throw new Error("Eufy did not accept the CAPTCHA answer");
    }
    if (result.state === "verification-required") {
      this.#captchaChallenge = null;
      this.#verificationRequired = true;
      this.#events.connection("authentication-required", "Eufy sent a six-digit verification code; enter it in the add-on web interface");
      return;
    }
    this.#captchaChallenge = null;
    this.#verificationRequired = false;
    await this.#completeStartup(this.#events);
  }

  async submitVerification(code: string): Promise<void> {
    if (!this.#verificationRequired || !this.#events) throw new Error("No Eufy verification is waiting for a code");
    const result = await this.#client.connect(code);
    if (result.state !== "authenticated") throw new Error("Eufy did not accept the verification code");
    this.#verificationRequired = false;
    await this.#completeStartup(this.#events);
  }

  async #completeStartup(events: ProviderEvents): Promise<void> {
    let inventory;
    try {
      inventory = await this.#client.inventory();
    } catch (error) {
      if (!this.#client.isSessionInvalidError(error)) throw error;
      logger.warn("session_invalidated", "Mega session was invalidated; signing in again");
      const auth = await this.#client.connect(undefined, undefined, true);
      if (auth.state !== "authenticated") {
        this.#captchaChallenge = auth.captcha ?? null;
        this.#verificationRequired = auth.state === "verification-required";
        const detail = auth.state === "captcha-required"
          ? "Open the add-on web interface to complete Eufy's CAPTCHA"
          : "Open the add-on web interface to enter Eufy's email verification code";
        events.connection("authentication-required", detail);
        return;
      }
      inventory = await this.#client.inventory();
    }
    const devices = parseMegaInventory(inventory);
    this.#devices.clear();
    for (const device of devices) {
      this.#devices.set(device.serial, device);
    }
    this.#dskKeys.clear();
    this.#cipherKeys.clear();
    const stationSerials = [...new Set(devices.filter((device) => !device.parentSerial && device.p2pDid).map((device) => device.serial))];
    if (stationSerials.length > 0) {
      try {
        for (const [serial, key] of Object.entries(await this.#client.dskKeys(stationSerials))) this.#dskKeys.set(serial, key);
      } catch (error) {
        logger.warn("dsk_lookup_unavailable", `Mega DSK lookup unavailable: ${safeError(error)}`);
      }
    }
    for (const device of devices) {
      if (!isSupportedMegaCamera(device)) continue;
      const station = device.parentSerial ? this.#devices.get(device.parentSerial) : null;
      events.camera({
        serial: device.serial,
        name: device.name,
        model: device.model,
        stationSerial: device.parentSerial,
        streamSupported: Boolean(station?.p2pDid && station.p2pConnection && device.channel !== null && station && this.#dskKeys.has(station.serial)),
      });
    }
    const diagnostics = inventoryDiagnostics(devices);
    const summaries = inventoryLogSummaries(devices, new Set(this.#dskKeys.keys()));
    logger.info(
      "inventory_loaded",
      `Mega inventory loaded: devices=${devices.length} accepted=${diagnostics.filter(({ acceptedAsCamera }) => acceptedAsCamera).length} groups=${summaries.length}`,
    );
    for (const summary of summaries) {
      logger.info(
        "inventory_group",
        [
          `count=${summary.count}`,
          `model=${JSON.stringify(summary.model)}`,
          `device_type=${summary.deviceType ?? "missing"}`,
          `category=${summary.category ?? "missing"}`,
          `accepted=${summary.acceptedAsCamera}`,
          `has_parent=${summary.hasParent}`,
          `has_channel=${summary.hasChannel}`,
          `station_present=${summary.stationPresent}`,
          `station_ppcs_ready=${summary.stationPpcsReady}`,
          `station_dsk_ready=${summary.stationDskReady}`,
          `stream_supported=${summary.streamSupported}`,
        ].join(" "),
      );
    }
    events.inventory(diagnostics);

    this.#push?.close();
    this.#push = new MegaPushReceiver(
      this.#client,
      join(this.config.persistentDirectory, "mega-push.json"),
      (event) => this.#handlePush(events, event),
    );
    await this.#push.start();
    events.connection("connected", "Gateway events and snapshots are ready; live viewing requires a validated PPCS camera path");
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
      logger.warn("push_snapshot_unavailable", `Eufy push snapshot unavailable: ${safeError(error)}`);
    });
    this.#pushSnapshotQueues.set(event.cameraSerial, current);
    void current.finally(() => {
      if (this.#pushSnapshotQueues.get(event.cameraSerial) === current) this.#pushSnapshotQueues.delete(event.cameraSerial);
    });
  }
}

/** Download and decode the image referenced by one normalized push event. */
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

/** Parse and normalize the untrusted device list returned by Mega. */
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
      p2pConnection: safeValue(value.p2p_conn, 512) ?? safeValue(value.app_conn, 512),
      cipherId: integer(value.cipher_id),
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

/** Explain camera filtering decisions without exposing raw cloud payloads. */
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

/**
 * Group inventory classifications without exposing names or device serials.
 *
 * @param devices Normalized Mega inventory rows.
 * @param dskStationSerials Stations whose short-lived PPCS key was retrieved.
 * @returns Groups that explain camera acceptance and live-stream readiness.
 */
export function inventoryLogSummaries(
  devices: readonly MegaInventoryDevice[],
  dskStationSerials: ReadonlySet<string>,
): InventoryLogSummary[] {
  const bySerial = new Map(devices.map((device) => [device.serial, device]));
  const groups = new Map<string, InventoryLogSummary>();
  for (const device of devices) {
    const station = device.parentSerial ? bySerial.get(device.parentSerial) : undefined;
    const values = {
      model: device.model,
      deviceType: device.deviceType,
      category: device.category,
      hasParent: device.parentSerial.length > 0,
      hasChannel: device.channel !== null,
      acceptedAsCamera: isSupportedMegaCamera(device),
      stationPresent: station !== undefined,
      stationPpcsReady: Boolean(station?.p2pDid && station.p2pConnection),
      stationDskReady: Boolean(station && dskStationSerials.has(station.serial)),
      streamSupported: Boolean(
        station?.p2pDid
        && station.p2pConnection
        && device.channel !== null
        && dskStationSerials.has(station.serial)
      ),
    };
    const key = JSON.stringify(values);
    const existing = groups.get(key);
    groups.set(key, { count: (existing?.count ?? 0) + 1, ...values });
  }
  return [...groups.values()];
}

/** Return whether Mega metadata identifies a device as a supported camera. */
export function isSupportedMegaCamera(device: Pick<MegaInventoryDevice, "category" | "deviceType">): boolean {
  return device.category === "eufy_security"
    && (device.deviceType === 7
      || device.deviceType === 8
      || device.deviceType === 19
      || device.deviceType === 23
      || device.deviceType === 31
      || device.deviceType === 91
      || device.deviceType === 10031);
}

/** Extract a recognized name only from push events that represent a person. */
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
