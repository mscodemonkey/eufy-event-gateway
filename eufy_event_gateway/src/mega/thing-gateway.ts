import { createCipheriv, createDecipheriv, createHash, createHmac, publicEncrypt, createPublicKey, randomBytes } from "node:crypto";

export interface ThingAccountSession { readonly sid: string; readonly ecode: string; readonly uid: string; readonly deviceFingerprint: string; }
export interface ThingDevice { readonly deviceId: string; readonly name: string; readonly category: string; readonly localKey: string; readonly productId: string | null; readonly online: boolean; }
export interface ThingStreamConfig { readonly deviceId: string; readonly localKey: string; readonly password: string; readonly motoId: string; readonly p2pConfig: Record<string, unknown>; readonly session: Record<string, unknown>; readonly tcpRelay: Record<string, unknown>; readonly iceServers: readonly unknown[]; }

const PACKAGE_NAME = "com.tuya.smartlife";
const CERT_SHA256 = "0F:C3:61:99:9C:C0:C3:5B:A8:AC:A5:7D:AA:55:93:A2:0C:F5:57:27:70:2E:A8:5A:D7:B3:22:89:49:F8:88:FE";
const DERIVED_KEY = "jfg5rs5kkmrj5mxahugvucrsvw43t48x";
const APP_SECRET = "r3me7ghmxjevrvnpemwmhw3fxtacphyg";
const COMPOSITE_KEY = `${PACKAGE_NAME}_${CERT_SHA256}_${DERIVED_KEY}_${APP_SECRET}`;
const CLIENT_ID = "ekmnwp9f5pnh3trdtpgy";
const CH_KEY = "ec9709a4";
const APP_VERSION = "7.10.3";
const SDK_VERSION = "5.2.0";
const SIGN_FIELDS = new Set(["a", "v", "lat", "lon", "lang", "deviceId", "appVersion", "ttid", "isH5", "h5Token", "os", "clientId", "postData", "time", "requestId", "et", "n4h5", "sid", "chKey", "sp"]);

export class ThingGatewayClient {
  readonly #region: string;
  readonly #fingerprint: string;
  readonly #fetch: typeof fetch;
  readonly #url: string;

  constructor(options: { readonly region: string; readonly deviceFingerprint?: string; readonly fetch?: typeof fetch }) {
    this.#region = options.region.toLowerCase();
    this.#fingerprint = options.deviceFingerprint ?? "a".repeat(44);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#url = `https://a1-${this.#region}.lifeaiot.com/api.json`;
  }

  async login(email: string, password: string, countryCode: string): Promise<ThingAccountSession> {
    const token = await this.callObject("smartlife.m.user.username.token.get", "2.0", { countryCode, username: email, isUid: false });
    const publicKey = typeof token.publicKey === "string" ? token.publicKey : "";
    const exponent = typeof token.exponent === "string" ? token.exponent : "";
    const tokenValue = typeof token.token === "string" ? token.token : "";
    if (!publicKey || !exponent || !tokenValue) throw new Error("Thing login token response is incomplete");
    const encrypted = rsaEncryptDecimal(publicKey, exponent, md5(password));
    const account = await this.callObject("smartlife.m.user.email.password.login", "3.0", {
      countryCode, email, ifencrypt: 1, options: JSON.stringify({ group: 1 }), passwd: encrypted, token: tokenValue,
    });
    const sid = string(account.sid), ecode = string(account.ecode), uid = string(account.uid);
    if (!sid || !ecode || !uid) throw new Error("Thing login response is incomplete");
    return { sid, ecode, uid, deviceFingerprint: this.#fingerprint };
  }

  async streamConfig(accountSession: ThingAccountSession, deviceId: string, localKey: string): Promise<ThingStreamConfig> {
    const value = await this.callObject("m.ipc.v4.rtc.config.get", "1.0", { devId: deviceId }, accountSession);
    const p2pConfig = isRecord(value.p2pConfig) ? value.p2pConfig : null;
    if (!p2pConfig) throw new Error("Thing RTC response has no P2P config");
    const p2pSession = isRecord(p2pConfig.session) ? p2pConfig.session : null;
    const tcpRelay = isRecord(p2pConfig.tcpRelay) ? p2pConfig.tcpRelay : null;
    if (!p2pSession || !tcpRelay) throw new Error("Thing RTC response is missing session or relay data");
    return { deviceId, localKey, password: string(value.password) ?? "", motoId: string(value.motoId) ?? "", p2pConfig, session: p2pSession, tcpRelay, iceServers: Array.isArray(p2pConfig.ices) ? p2pConfig.ices : [] };
  }

  async listDevices(session: ThingAccountSession): Promise<ThingDevice[]> {
    const homes = await this.call("tuya.m.location.list", "2.1", {}, session);
    if (!Array.isArray(homes)) throw new Error("Thing home list is invalid");
    const result: ThingDevice[] = [];
    const seen = new Set<string>();
    for (const home of homes) {
      if (!isRecord(home) || typeof home.gid !== "number") continue;
      const devices = await this.call("tuya.m.my.group.device.list", "1.0", {}, session, { gid: String(home.gid) });
      if (!Array.isArray(devices)) continue;
      for (const raw of devices) {
        if (!isRecord(raw)) continue;
        const deviceId = string(raw.devId), localKey = string(raw.localKey);
        if (!deviceId || !localKey || seen.has(deviceId)) continue;
        seen.add(deviceId);
        result.push({ deviceId, localKey, name: string(raw.name) ?? deviceId, category: string(raw.category) ?? "", productId: string(raw.productId), online: raw.isOnline !== false });
      }
    }
    return result;
  }

  mqttIdentity(session: ThingAccountSession): { readonly host: string; readonly port: number; readonly clientId: string; readonly username: string; readonly password: string } {
    const install = `${session.deviceFingerprint}_${md5(session.uid + "sdkfasodifca")}`;
    const clientId = `${PACKAGE_NAME}_mb_${install}_DEFAULT`;
    const username = `p1000018_v1_${CLIENT_ID}_${CH_KEY}_mb_${session.sid}${md5(md5(CLIENT_ID) + session.ecode).slice(16, 32)}`;
    return { host: `m1-${this.#region}.lifeaiot.com`, port: 8883, clientId, username, password: md5(md5(COMPOSITE_KEY) + session.ecode).slice(8, 24) };
  }

  async call(api: string, version: string, post: unknown, session?: ThingAccountSession, extra?: Record<string, string>): Promise<unknown> {
    const requestId = cryptoUuid();
    const key = session ? hmac(requestId, `${COMPOSITE_KEY}_${session.ecode}`).slice(0, 16) : hmac(requestId, COMPOSITE_KEY).slice(0, 16);
    const encrypted = encryptBody(key, Buffer.from(JSON.stringify(post)));
    const params: Record<string, string> = { a: api, v: version, clientId: CLIENT_ID, time: String(Math.floor(Date.now() / 1000)), requestId, lang: "en_US", deviceId: this.#fingerprint, appVersion: APP_VERSION, ttid: `sdk_international@${CLIENT_ID}`, os: "Android", sdkVersion: SDK_VERSION, chKey: CH_KEY, et: "3", postData: encrypted, ...(session ? { sid: session.sid } : {}), ...(extra ?? {}) };
    const signParams: Record<string, string> = { ...params, postData: swap(md5(encrypted)) };
    params.sign = hmac(COMPOSITE_KEY, Object.keys(signParams).sort().filter((k) => SIGN_FIELDS.has(k) && signParams[k]).map((k) => `${k}=${signParams[k]}`).join("||"));
    const response = await this.#fetch(this.#url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": `TY/${APP_VERSION}` }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) });
    const envelope: unknown = await response.json();
    if (!isRecord(envelope)) throw new Error(`Thing ${api} returned invalid JSON`);
    const result = typeof envelope.result === "string" && envelope.result ? JSON.parse(decryptBody(key, envelope.result)) : envelope;
    if (!isRecord(result)) throw new Error(`Thing ${api} returned an invalid result`);
    if (result.success === false || result.errorCode) throw new Error(`Thing ${api} failed: ${String(result.errorMsg ?? result.errorCode ?? "unknown error")}`);
    return result.result;
  }

  private async callObject(api: string, version: string, post: unknown, session?: ThingAccountSession): Promise<Record<string, unknown>> { const value = await this.call(api, version, post, session); if (!isRecord(value)) throw new Error(`Thing ${api} result is not an object`); return value; }
}

function encryptBody(key: string, plaintext: Buffer): string { const nonce = randomBytes(12); const cipher = createCipheriv("aes-128-gcm", Buffer.from(key), nonce); return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString("base64"); }
function decryptBody(key: string, value: string): string { const data = Buffer.from(value, "base64"); const decipher = createDecipheriv("aes-128-gcm", Buffer.from(key), data.subarray(0, 12)); decipher.setAuthTag(data.subarray(-16)); return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString("utf8"); }
function rsaEncryptDecimal(modulus: string, exponent: string, value: string): string { const key = createPublicKey({ key: { kty: "RSA", n: Buffer.from(BigInt(modulus).toString(16).padStart(512, "0"), "hex").toString("base64url"), e: Buffer.from(BigInt(exponent).toString(16).padStart(6, "0"), "hex").toString("base64url"), alg: "RSA1_5", ext: true }, format: "jwk" }); return publicEncrypt({ key, padding: 1 }, Buffer.from(value)).toString("hex"); }
function md5(value: string): string { return createHash("md5").update(value).digest("hex"); }
function hmac(key: string, value: string): string { return createHmac("sha256", key).update(value).digest("hex"); }
function swap(value: string): string { return value.length === 32 ? value.slice(8, 16) + value.slice(0, 8) + value.slice(24) + value.slice(16, 24) : value; }
function cryptoUuid(): string { const b = randomBytes(16); b[6] = (b[6]! & 15) | 64; b[8] = (b[8]! & 63) | 128; return `${b.toString("hex", 0, 4)}-${b.toString("hex", 4, 6)}-${b.toString("hex", 6, 8)}-${b.toString("hex", 8, 10)}-${b.toString("hex", 10)}`; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function string(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
