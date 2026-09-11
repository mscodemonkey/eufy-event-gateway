import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  randomBytes,
  randomUUID,
  type ECDH,
} from "node:crypto";

export const WEB_PRESET_KEY = "218c12c81e211149304bd70a0c071d03";
export const WEB_PASSWORD_PUBLIC_KEY =
  "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

export interface WebKeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

export interface WebRequestIdentity extends WebKeyPair {
  readonly keyIdent: string;
  readonly sharedKey: string;
}

export function webKeyPair(): WebKeyPair {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey("hex"), publicKey: ecdh.getPublicKey("hex") };
}

export function deriveWebKey(privateKey: string, publicKey: string, first16 = false): string {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey, "hex");
  const shared = padSecret(ecdh, publicKey);
  return (first16 ? shared.subarray(0, 16) : shared).toString("hex");
}

export function encryptWebEnvelope(value: string, key: string, includeRandomIv = true): string {
  const keyBytes = Buffer.from(key, "hex");
  const iv = includeRandomIv ? randomBytes(16) : keyBytes.subarray(0, 16);
  const cipher = createCipheriv(`aes-${keyBytes.length * 8}-cbc`, keyBytes, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return (includeRandomIv ? Buffer.concat([iv, encrypted]) : encrypted).toString("base64");
}

export function decryptWebEnvelope(value: string, key: string, includesIv = true): string {
  const keyBytes = Buffer.from(key, "hex");
  const encrypted = Buffer.from(value, "base64");
  const iv = includesIv ? encrypted.subarray(0, 16) : keyBytes.subarray(0, 16);
  const body = includesIv ? encrypted.subarray(16) : encrypted;
  const decipher = createDecipheriv(`aes-${keyBytes.length * 8}-cbc`, keyBytes, iv);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function webRequestSignature(key: string, timestamp: string, nonce: string, data: string): string {
  return createHmac("sha256", key).update(`${timestamp}+${nonce}+${data}`).digest("hex");
}

export function randomWebIdentifier(): string {
  return randomUUID().replaceAll("-", "");
}

function padSecret(ecdh: ECDH, publicKey: string): Buffer {
  const shared = ecdh.computeSecret(Buffer.from(publicKey, "hex"));
  return shared.length < 32 ? Buffer.concat([Buffer.alloc(32 - shared.length), shared]) : shared;
}
