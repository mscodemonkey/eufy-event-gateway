import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  decryptWebEnvelope,
  deriveWebKey,
  encryptWebEnvelope,
  randomWebIdentifier,
  WEB_PASSWORD_PUBLIC_KEY,
  WEB_PRESET_KEY,
  webKeyPair,
  webRequestSignature,
} from "./web-crypto.js";
import { WebSessionStore } from "./web-session-store.js";
import type { WebApiIdentity, WebAuthResult, WebSession } from "./web-types.js";

const CAPTCHA_REQUIRED = new Set([100032, 100033]);
const VERIFICATION_REQUIRED = 26052;
const WEB_PIN_TIMESTAMP_REQUIRED = 170003;
const USER_AGENT = "Mozilla/5.0 Home Assistant Eufy Event Gateway";
const EU_API_HOSTS = new Set([
  "security-app-eu.eufylife.com",
  "security-app-eu-qa.eufylife.com",
]);
const IE_API_HOSTS = new Set([
  "security-app-ie.eufylife.com",
  "security-app-ie-qa.eufylife.com",
]);

interface WebResult {
  readonly code: number;
  readonly msg?: string;
  readonly data?: unknown;
  readonly signature?: string;
}

export interface WebClientOptions {
  readonly email: string;
  readonly password: string;
  readonly country: string;
  readonly persistentDirectory: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export class WebClient {
  readonly #email: string;
  readonly #password: string;
  readonly #country: string;
  readonly #store: WebSessionStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #loginHash: string;
  #session: WebSession | null = null;
  #host = "";
  #apiIdentity: WebApiIdentity | null = null;
  #loginKeys: { readonly privateKey: string; readonly publicKey: string } | null = null;
  #captcha: { readonly id: string; readonly image: string } | null = null;
  #temporaryToken = "";
  #verifiedPortalPinHash = "";

  constructor(options: WebClientOptions) {
    this.#email = options.email;
    this.#password = options.password;
    this.#country = options.country.toUpperCase();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#loginHash = createHash("sha256")
      .update(`${this.#country}\0${this.#email}\0${this.#password}`)
      .digest("hex");
    this.#store = new WebSessionStore(join(options.persistentDirectory, "web-session.json"));
  }

  get isAuthenticated(): boolean {
    return this.#session !== null && this.#session.authToken.length > 0 &&
      this.#session.userId.length > 0 && this.#now() / 1_000 < this.#session.tokenExpiresAt - 60;
  }

  get authToken(): string {
    this.#requireAuthentication();
    return this.#session!.authToken;
  }

  get userId(): string {
    this.#requireAuthentication();
    return this.#session!.userId;
  }

  get signalKey(): string {
    this.#requireAuthentication();
    return deriveWebKey(this.#session!.clientPrivateKey, this.#session!.serverPublicKey);
  }

  async connect(captchaAnswer?: string): Promise<WebAuthResult> {
    if (!this.#session) await this.#restore();
    if (this.isAuthenticated && !captchaAnswer) return { state: "authenticated" };
    await this.#prepareApi();
    if (!this.#loginKeys) this.#loginKeys = webKeyPair();
    const result = await this.#login({
      ...(captchaAnswer && this.#captcha ? { answer: captchaAnswer, captcha_id: this.#captcha.id } : {}),
    });
    if (CAPTCHA_REQUIRED.has(result.code)) {
      const decoded = this.#decodedData(result);
      const id = stringValue(decoded?.captcha_id);
      const image = stringValue(decoded?.item);
      if (!id || !image) throw new Error("Eufy web authentication returned an incomplete CAPTCHA");
      this.#captcha = { id, image };
      return { state: "captcha-required", captcha: this.#captcha };
    }
    if (result.code === VERIFICATION_REQUIRED) {
      const decoded = this.#decodedData(result);
      this.#temporaryToken = stringValue(decoded?.auth_token) ?? "";
      if (!this.#temporaryToken) throw new Error("Eufy web authentication omitted its verification token");
      await this.#call("sms/send/verify_code", { message_type: 2 }, this.#temporaryToken);
      return { state: "verification-required" };
    }
    await this.#acceptLogin(result);
    return { state: "authenticated" };
  }

  async submitVerification(code: string): Promise<WebAuthResult> {
    if (!/^\d{6}$/.test(code) || !this.#temporaryToken || !this.#loginKeys) {
      throw new Error("No Eufy verification is waiting for a code");
    }
    const result = await this.#login({ verify_code: code }, this.#temporaryToken);
    if (result.code === VERIFICATION_REQUIRED) return { state: "verification-required" };
    await this.#acceptLogin(result);
    return { state: "authenticated" };
  }

  async signal(): Promise<{ readonly sign: string; readonly host: string }> {
    this.#requireAuthentication();
    const host = webSignalHost(this.#session!.host);
    const response = await this.#fetch(`https://${host}/v1/smart/ws/sign`, {
      headers: { "X-Auth-Token": this.authToken, "Web-Country": this.#country },
      signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as unknown;
    if (!response.ok || !isRecord(value) || (value.code !== 0 && value.code !== 200)) {
      throw new Error(`Eufy web stream sign failed (HTTP ${response.status})`);
    }
    const sign = isRecord(value.data) ? stringValue(value.data.sign) : stringValue(value.data);
    if (!sign) throw new Error("Eufy web stream sign response was empty");
    return { sign, host };
  }

  async verifyPortalPin(pin: string): Promise<void> {
    this.#requireAuthentication();
    const pinHash = createHash("sha256").update(pin).digest("hex");
    if (pinHash === this.#verifiedPortalPinHash) return;
    let result = await this.#call(
      "web/wp/verify_captcha",
      { captcha: pin },
      "",
      { "X-Auto-Ts": "0" },
    );
    if (result.code === WEB_PIN_TIMESTAMP_REQUIRED) {
      result = await this.#call(
        "web/wp/verify_captcha",
        { captcha: pin },
        "",
        { "X-Auto-Ts": `${Math.floor(this.#now() / 1_000)}` },
      );
    }
    if (result.code !== 0) {
      throw new Error(`Eufy did not accept the Web Portal access PIN (${result.code})`);
    }
    this.#verifiedPortalPinHash = pinHash;
  }

  async #restore(): Promise<void> {
    const session = await this.#store.load();
    if (!session || session.country !== this.#country || session.loginHash !== this.#loginHash) return;
    this.#session = session;
    this.#host = session.host;
    this.#apiIdentity = session.apiIdentity;
  }

  async #prepareApi(): Promise<void> {
    if (!this.#host) {
      const response = await this.#fetch(`https://extend.eufylife.com/domain/web/${encodeURIComponent(this.#country)}`, {
        headers: { "Web-Country": this.#country },
        signal: AbortSignal.timeout(30_000),
      });
      const value = await response.json() as unknown;
      const host = isRecord(value) && isRecord(value.data) ? stringValue(value.data.domain) : null;
      if (!response.ok || !host || !/^[a-z0-9.-]+\.eufylife\.com$/i.test(host)) {
        throw new Error("Eufy web domain discovery failed");
      }
      this.#host = host;
    }
    if (!this.#apiIdentity) this.#apiIdentity = await this.#exchangeIdentity();
  }

  async #exchangeIdentity(): Promise<WebApiIdentity> {
    const keys = webKeyPair();
    const encryptedPublicKey = encryptWebEnvelope(keys.publicKey, WEB_PRESET_KEY);
    const keyIdent = randomWebIdentifier();
    const context = this.#headers(keyIdent, WEB_PRESET_KEY, encryptedPublicKey, "application/json");
    const result = await this.#post(
      "openapi/oauth/key/exchange",
      JSON.stringify({ client_public_key: encryptedPublicKey }),
      context.headers,
    );
    if (result.code !== 0 || !isRecord(result.data)) throw new Error(`Eufy web key exchange failed (${result.code})`);
    const encryptedServerKey = stringValue(result.data.server_public_key);
    if (!encryptedServerKey) throw new Error("Eufy web key exchange omitted its server key");
    const serverKey = decryptWebEnvelope(encryptedServerKey, WEB_PRESET_KEY);
    return {
      keyIdent,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      sharedKey: deriveWebKey(keys.privateKey, serverKey, true),
    };
  }

  async #login(extra: Record<string, string>, token = ""): Promise<WebResult> {
    const keys = this.#loginKeys!;
    const passwordKey = deriveWebKey(keys.privateKey, WEB_PASSWORD_PUBLIC_KEY);
    const encryptedPassword = encryptWebEnvelope(this.#password, passwordKey, false);
    return this.#call("passport/login", {
      email: this.#email,
      password: encryptedPassword,
      enc: 0,
      ab: "",
      login_id: "",
      client_secret_info: { public_key: keys.publicKey },
      captcha_id: "",
      answer: "",
      ...extra,
    }, token, {
      Openudid: createHash("sha256").update(`${USER_AGENT}_${this.#email}`).digest("hex"),
    });
  }

  async #acceptLogin(result: WebResult): Promise<void> {
    const decoded = this.#decodedData(result);
    if (result.code !== 0 || !decoded || !this.#loginKeys) {
      throw new Error(`Eufy web login failed (${result.code}: ${result.msg ?? "unknown error"})`);
    }
    const authToken = stringValue(decoded.auth_token);
    const userId = stringValue(decoded.user_id);
    const serverPublicKey = isRecord(decoded.server_secret_info)
      ? stringValue(decoded.server_secret_info.public_key)
      : null;
    if (!authToken || !userId || !serverPublicKey || !this.#apiIdentity) {
      throw new Error("Eufy web login returned an incomplete session");
    }
    this.#session = {
      version: 1,
      country: this.#country,
      loginHash: this.#loginHash,
      host: this.#host,
      authToken,
      userId,
      tokenExpiresAt: numberValue(decoded.token_expires_at) ?? Math.floor(this.#now() / 1_000) + 30 * 24 * 60 * 60,
      clientPrivateKey: this.#loginKeys.privateKey,
      clientPublicKey: this.#loginKeys.publicKey,
      serverPublicKey,
      apiIdentity: this.#apiIdentity,
    };
    this.#captcha = null;
    this.#temporaryToken = "";
    await this.#store.save(this.#session);
  }

  async #call(
    path: string,
    payload: unknown,
    token = "",
    additionalHeaders: Record<string, string> = {},
  ): Promise<WebResult> {
    await this.#prepareApi();
    const identity = this.#apiIdentity!;
    const body = encryptWebEnvelope(JSON.stringify(payload), identity.sharedKey);
    const context = this.#headers(identity.keyIdent, identity.sharedKey, body, "text/plain", token);
    const result = await this.#post(path, body, { ...context.headers, ...additionalHeaders });
    if (typeof result.data === "string" && result.signature &&
      webRequestSignature(identity.sharedKey, context.timestamp, context.nonce, result.data) !== result.signature) {
      throw new Error("Eufy web response signature mismatch");
    }
    return result;
  }

  async #post(path: string, body: string, headers: Record<string, string>): Promise<WebResult> {
    const response = await this.#fetch(`https://${this.#host}/v3/${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as unknown;
    if (!response.ok || !isRecord(value) || typeof value.code !== "number") {
      throw new Error(`Eufy web request failed (HTTP ${response.status})`);
    }
    return value as unknown as WebResult;
  }

  #headers(
    keyIdent: string,
    signingKey: string,
    signedData: string,
    contentType: string,
    token = "",
  ): { readonly timestamp: string; readonly nonce: string; readonly headers: Record<string, string> } {
    const timestamp = `${Math.round(this.#now() / 1_000)}`;
    const nonce = randomWebIdentifier();
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "X-Replay-Info": "replay",
      Model_type: "WEB",
      "X-Request-Ts": timestamp,
      "X-Request-Once": nonce,
      "X-Signature": webRequestSignature(signingKey, timestamp, nonce, signedData),
      "X-Key-Ident": keyIdent,
      "App-Name": "eufy_security",
      "Web-Country": this.#country,
      "User-Agent": USER_AGENT,
    };
    if (contentType === "text/plain") headers["X-Encryption-Info"] = "algo_ecdh";
    headers["X-Auth-Token"] = token || this.#session?.authToken || "";
    headers.gtoken = this.#session?.userId
      ? createHash("md5").update(this.#session.userId).digest("hex")
      : "";
    return { timestamp, nonce, headers };
  }

  #decodedData(result: WebResult): Record<string, unknown> | null {
    if (!isRecord(result.data) && typeof result.data !== "string") return null;
    const value = typeof result.data === "string"
      ? JSON.parse(decryptWebEnvelope(result.data, this.#apiIdentity!.sharedKey)) as unknown
      : result.data;
    return isRecord(value) ? value : null;
  }

  #requireAuthentication(): void {
    if (!this.isAuthenticated) throw new Error("Eufy web authentication is required for live viewing");
  }
}

export function webSignalHost(apiHost: string): string {
  if (EU_API_HOSTS.has(apiHost)) return "security-smart-eu.eufylife.com";
  if (IE_API_HOSTS.has(apiHost)) return "security-smart-ie.eufylife.com";
  return "security-smart.eufylife.com";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
