import { join } from "node:path";

import {
  beginKeyExchange,
  decryptEnvelope,
  encryptEnvelope,
  encryptPassword,
  finishKeyExchange,
  loginHash,
  megaUserToken,
  MEGA_PRESET_KEY,
  randomIdentifier,
  requestSignature,
  sharedAesKey,
  sharedSigningKey,
} from "./crypto.js";
import { MegaSessionStore } from "./session-store.js";
import type { MegaAuthResult, MegaCaptcha, MegaIdentity, MegaInventory, MegaMqttInfo, MegaResult, MegaSession } from "./types.js";

const CAPTCHA_REQUIRED = new Set([100032, 100033]);
const VERIFICATION_REQUIRED = 26052;
const TRANSIENT_IDENTITY_ERRORS = new Set([100028, 100030]);

export interface MegaClientOptions {
  readonly email: string;
  readonly password: string;
  readonly country: string;
  readonly persistentDirectory: string;
  readonly minimumRequestIntervalMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export class MegaClient {
  readonly #email: string;
  readonly #password: string;
  readonly #country: string;
  readonly #store: MegaSessionStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #minimumRequestIntervalMs: number;
  #lastRequestAt = 0;
  #session: MegaSession | null = null;
  #pendingCaptcha: MegaCaptcha | null = null;

  constructor(options: MegaClientOptions) {
    this.#email = options.email;
    this.#password = options.password;
    this.#country = options.country.toLowerCase();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#minimumRequestIntervalMs = options.minimumRequestIntervalMs ?? 3_000;
    this.#store = new MegaSessionStore(
      join(options.persistentDirectory, "mega-session.json"),
      join(options.persistentDirectory, "persistent.json"),
    );
  }

  get captcha(): MegaCaptcha | null {
    return this.#pendingCaptcha;
  }

  get isAuthenticated(): boolean {
    return this.#session !== null && this.#session.authToken.length > 0 &&
      this.#session.userId.length > 0 && this.#now() / 1_000 < this.#session.tokenExpiresAt - 60;
  }

  async connect(verificationCode?: string, captchaAnswer?: string): Promise<MegaAuthResult> {
    if (!this.#session) await this.#restore();
    if (this.isAuthenticated && !verificationCode && !captchaAnswer) {
      if (this.#session) await this.#store.save(this.#session);
      return { state: "authenticated" };
    }

    await this.#ensureDomain();
    const openApiHost = this.#clusterHost("openapi");
    await this.#identity(openApiHost);
    const password = encryptPassword(this.#password);
    const result = await this.#call("passport", "/passport/login", {
      email: this.#email,
      password: password.encrypted,
      ab: this.#country,
      client_secret_info: { public_key: password.clientPublicKey },
      answer: captchaAnswer ?? "",
      captcha_id: captchaAnswer ? this.#pendingCaptcha?.id ?? "" : "",
      verify_code: verificationCode ?? "",
      login_id: "",
    }, false);

    if (CAPTCHA_REQUIRED.has(result.code)) {
      const challenge = await this.#requestCaptcha();
      this.#pendingCaptcha = challenge;
      return { state: "captcha-required", captcha: challenge };
    }

    const decoded = this.#decodeResult(result, openApiHost);
    if (!isRecord(decoded)) throw new Error(`Mega login failed (${result.code}: ${result.msg ?? "unknown error"})`);
    const authToken = stringValue(decoded.auth_token) ?? stringValue(decoded.token);
    const userId = stringValue(decoded.user_id) ?? stringValue(decoded.userId);
    if (authToken && userId) this.#setAuth(authToken, userId, numberValue(decoded.token_expires_at));

    if (result.code === VERIFICATION_REQUIRED || isRecord(decoded.fa_info) && decoded.fa_info.step === VERIFICATION_REQUIRED) {
      await this.#call("push", "/app/sendmsg/verify_code", {
        message_type: 2,
        biz_type: 1004,
        transaction: `${this.#now()}`,
      }, false);
      return { state: "verification-required" };
    }
    if (!isSuccess(result.code) || !this.isAuthenticated) {
      throw new Error(`Mega login failed (${result.code}: ${result.msg ?? "unknown error"})`);
    }
    this.#pendingCaptcha = null;
    await this.#save();
    return { state: "authenticated" };
  }

  async inventory(): Promise<MegaInventory> {
    this.#requireAuthentication();
    const result = await this.#call("house", "/app/house/get_devs_list", { house_id: "", device_sns: {} });
    const value = this.#decodeResult(result, this.#clusterHost("openapi"));
    if (!isRecord(value) || !Array.isArray(value.devices)) throw new Error("Mega returned an invalid device inventory");
    return {
      devices: value.devices.filter(isMegaDevice),
      groups: Array.isArray(value.groups) ? value.groups : [],
    };
  }

  /**
   * Fetch the mutual-TLS credentials used by the native app's Thing MQTT
   * transport. This is deliberately separate from the web portal session:
   * native P2P signalling does not use the expiring Web Portal PIN.
   */
  async mqttInfo(): Promise<MegaMqttInfo> {
    this.#requireAuthentication();
    const result = await this.#call("openapi", "/app/devicemanage/get_user_mqtt_info", {});
    const value = this.#decodeResult(result, this.#clusterHost("openapi"));
    if (!isRecord(value)) throw new Error("Mega returned invalid MQTT credentials");
    const endpointAddress = stringValue(value.endpoint_addr);
    const thingName = stringValue(value.thing_name);
    const userId = stringValue(value.user_id);
    const appName = stringValue(value.app_name);
    const certificatePem = stringValue(value.certificate_pem);
    const privateKey = stringValue(value.private_key);
    const rootCaPem = stringValue(value.aws_root_ca1_pem);
    if (!endpointAddress || !thingName || !userId || !appName || !certificatePem || !privateKey || !rootCaPem) {
      throw new Error("Mega returned incomplete MQTT credentials");
    }
    return { endpointAddress, thingName, userId, appName, certificatePem, privateKey, rootCaPem };
  }

  async registerPushToken(token: string): Promise<void> {
    this.#requireAuthentication();
    const result = await this.#call("push", "/app/push/register_push_token", {
      token,
      is_notification_enable: true,
      voip_token: token,
    }, false);
    if (!isSuccess(result.code)) throw new Error(`Mega push registration failed (${result.code})`);
  }

  async download(url: string, maximumBytes = 20 * 1024 * 1024): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("Mega media URL must use HTTPS");
    const response = await this.#fetch(parsed, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Mega media download failed (HTTP ${response.status})`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > maximumBytes) throw new Error("Mega media exceeds the safety limit");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0 || data.length > maximumBytes) throw new Error("Mega media has an invalid size");
    return data;
  }

  async #restore(): Promise<void> {
    const restored = await this.#store.load();
    if (!restored) return;
    const expectedHash = loginHash(restored.openUdid, this.#email, this.#password);
    if (restored.country.toLowerCase() !== this.#country || restored.loginHash !== expectedHash) {
      this.#session = emptySession(this.#country, restored.openUdid, expectedHash);
      return;
    }
    this.#session = restored;
  }

  async #ensureDomain(): Promise<void> {
    if (this.#session?.megaDomain) return;
    const host = `mega-${this.#country === "us" ? "us" : "eu"}-pr.eufy.com`;
    const result = await this.#postClear(host, "/passport/estimate_domain", { ab: this.#country, mode: 1 });
    if (!isSuccess(result.code) || !isRecord(result.data)) {
      throw new Error(`Mega domain discovery failed (${result.code}: ${result.msg ?? "unknown error"})`);
    }
    const domain = stringValue(result.data.domain);
    if (!domain || !isStringRecord(result.data.product_domains)) throw new Error("Mega returned an invalid domain profile");
    const openUdid = this.#session?.openUdid ?? randomIdentifier();
    this.#session = {
      ...(this.#session ?? emptySession(this.#country, openUdid, loginHash(openUdid, this.#email, this.#password))),
      megaDomain: domain,
      domains: result.data.product_domains,
    };
  }

  #clusterHost(service: string): string {
    if (this.#session?.megaDomain.startsWith("mega-")) {
      return this.#session.megaDomain.replace(/^mega-/, `app-${service}-`);
    }
    return `app-${service}-${this.#country === "us" ? "us" : "eu"}-pr.eufy.com`;
  }

  async #identity(host: string): Promise<MegaIdentity> {
    const saved = this.#session?.identities[host];
    if (saved) return saved;
    const pending = beginKeyExchange();
    const result = await this.#signedPost(host, "/openapi/oauth/key/exchange", undefined, undefined, {
      keyIdent: pending.keyIdent,
      encryptedPublicKey: pending.encryptedPublicKey,
    });
    if (!isSuccess(result.code) || !isRecord(result.data)) {
      throw new Error(`Mega key exchange failed (${result.code}: ${result.msg ?? "unknown error"})`);
    }
    const encryptedServerPublicKey = stringValue(result.data.server_public_key);
    if (!encryptedServerPublicKey) throw new Error("Mega key exchange omitted the server public key");
    const identity = finishKeyExchange(pending, encryptedServerPublicKey);
    const base = this.#session ?? emptySession(this.#country, randomIdentifier(), "");
    this.#session = { ...base, identities: { ...base.identities, [host]: identity } };
    return identity;
  }

  async #call(service: string, path: string, payload: unknown, retryIdentity = true): Promise<MegaResult> {
    const openApiHost = this.#clusterHost("openapi");
    const identity = await this.#identity(openApiHost);
    const result = await this.#signedPost(this.#clusterHost(service), path, payload, identity);
    if (retryIdentity && TRANSIENT_IDENTITY_ERRORS.has(result.code)) {
      if (this.#session) this.#session = { ...this.#session, identities: {} };
      return this.#signedPost(this.#clusterHost(service), path, payload, await this.#identity(openApiHost));
    }
    return result;
  }

  async #signedPost(
    host: string,
    path: string,
    payload: unknown,
    identity?: MegaIdentity,
    bootstrap?: { readonly keyIdent: string; readonly encryptedPublicKey: string },
  ): Promise<MegaResult> {
    const timestamp = `${Math.floor(this.#now() / 1_000)}`;
    const nonce = randomIdentifier();
    const encrypted = bootstrap?.encryptedPublicKey ?? encryptEnvelope(JSON.stringify(payload), sharedAesKey(identity!.sharedKey));
    const body = bootstrap ? JSON.stringify({ client_public_key: encrypted }) : encrypted;
    const headers = this.#headers(
      bootstrap?.keyIdent ?? identity!.keyIdent,
      timestamp,
      nonce,
      requestSignature(bootstrap ? MEGA_PRESET_KEY : sharedSigningKey(identity!.sharedKey), timestamp, nonce, encrypted),
    );
    return this.#post(host, path, body, headers);
  }

  async #postClear(host: string, path: string, payload: unknown): Promise<MegaResult> {
    return this.#post(host, path, JSON.stringify(payload), {
      "app-name": "eufy_mega",
      "app-version": "6.0.51_26722",
      "os-type": "android",
      "content-type": "application/json",
    });
  }

  async #post(host: string, path: string, body: string, headers: Record<string, string>): Promise<MegaResult> {
    const wait = this.#lastRequestAt + this.#minimumRequestIntervalMs - this.#now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.#lastRequestAt = this.#now();
    const response = await this.#fetch(`https://${host}${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Mega request failed (HTTP ${response.status}, invalid JSON)`);
    }
    if (!isRecord(value) || typeof value.code !== "number") throw new Error("Mega returned an invalid response");
    return value as unknown as MegaResult;
  }

  #headers(keyIdent: string, timestamp: string, nonce: string, signature: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "accept-charset": "UTF-8",
      "accept-language": `${this.#country}-${this.#country.toUpperCase()},${this.#country};q=0.9`,
      "app-name": "eufy_mega",
      "app-version": "6.0.51_26722",
      app_version: "6.0.51_26722",
      "os-type": "android",
      os_type: "android",
      "os-version": "14",
      os_version: "14",
      "model-type": "PHONE",
      "phone-model": "Home Assistant Eufy Gateway",
      phone_model: "Home Assistant Eufy Gateway",
      openudid: this.#session?.openUdid ?? "",
      "test-flag": "false",
      priority: "u=3, i",
      "user-agent": "ktor-client",
      "content-type": "application/json",
      "x-encryption-info": "algo_ecdh",
      "x-key-ident": keyIdent,
      "x-request-ts": timestamp,
      "x-request-once": nonce,
      "x-replay-info": "replay",
      "x-signature": signature,
      country: this.#country.toUpperCase(),
      language: this.#country,
      ab_code: this.#country,
    };
    if (this.#session?.userId) headers.gtoken = megaUserToken(this.#session.userId);
    if (this.#session?.authToken) {
      headers["x-auth-token"] = this.#session.authToken;
      headers.authorization = this.#session.authToken;
    }
    return headers;
  }

  #decodeResult(result: MegaResult, identityHost: string): unknown {
    if (!isSuccess(result.code)) {
      if (result.code === VERIFICATION_REQUIRED || CAPTCHA_REQUIRED.has(result.code)) return result.data;
      throw new Error(`Mega request failed (${result.code}: ${result.msg ?? "unknown error"})`);
    }
    if (typeof result.data !== "string") return result.data;
    const identity = this.#session?.identities[identityHost];
    if (!identity) throw new Error("Mega response cannot be decrypted without a session identity");
    return JSON.parse(decryptEnvelope(result.data, sharedAesKey(identity.sharedKey)));
  }

  async #requestCaptcha(): Promise<MegaCaptcha> {
    const result = await this.#call("passport", "/passport/generate/captcha", { captcha_type: "PIC", biz_type: 0 }, false);
    const value = this.#decodeResult(result, this.#clusterHost("openapi"));
    if (!isRecord(value)) throw new Error("Mega returned an invalid CAPTCHA challenge");
    const id = stringValue(value.captcha_id);
    const image = stringValue(value.item);
    if (!id || !image) throw new Error("Mega returned an incomplete CAPTCHA challenge");
    return { id, image };
  }

  #setAuth(authToken: string, userId: string, tokenExpiresAt: number | null): void {
    const base = this.#session;
    if (!base) throw new Error("Mega session was not initialized");
    this.#session = {
      ...base,
      authToken,
      userId,
      tokenExpiresAt: tokenExpiresAt ?? Math.floor(this.#now() / 1_000) + 30 * 24 * 60 * 60,
    };
  }

  async #save(): Promise<void> {
    if (!this.#session) throw new Error("Mega session was not initialized");
    await this.#store.save(this.#session);
  }

  #requireAuthentication(): void {
    if (!this.isAuthenticated) throw new Error("Mega authentication is required");
  }
}

function emptySession(country: string, openUdid: string, hash: string): MegaSession {
  return {
    version: 1,
    country,
    openUdid,
    loginHash: hash,
    authToken: "",
    tokenExpiresAt: 0,
    userId: "",
    megaDomain: "",
    domains: {},
    identities: {},
  };
}

function isSuccess(code: number): boolean {
  return code === 0 || code === 200;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMegaDevice(value: unknown): value is MegaInventory["devices"][number] {
  return isRecord(value) && typeof value.device_sn === "string" && value.device_sn.length > 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
