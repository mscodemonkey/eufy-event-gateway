import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  randomBytes,
  type ECDH,
} from "node:crypto";

import type { MegaIdentity } from "./types.js";

export const MEGA_PRESET_KEY = "2500a7d5617812f9d52515b2c8f20a3d";
export const LOGIN_SERVER_PUBLIC_KEY =
  "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

export function randomIdentifier(): string {
  return randomBytes(16).toString("hex");
}

export function requestSignature(key: string, timestamp: string, nonce: string, body?: string): string {
  const signed = body === undefined ? `${timestamp}+${nonce}` : `${timestamp}+${nonce}+${body}`;
  return createHmac("sha256", Buffer.from(key, "utf8")).update(signed).digest("hex");
}

export function encryptEnvelope(plaintext: string, key: Buffer, iv = randomBytes(16)): string {
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

export function decryptEnvelope(envelope: string, key: Buffer): string {
  const bytes = Buffer.from(envelope, "base64");
  if (bytes.length < 32 || bytes.length % 16 !== 0) throw new Error("Invalid Mega encrypted envelope");
  const decipher = createDecipheriv("aes-128-cbc", key, bytes.subarray(0, 16));
  return Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString("utf8");
}

export function presetKey(): Buffer {
  return Buffer.from(MEGA_PRESET_KEY, "hex");
}

export function sharedAesKey(sharedKey: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(sharedKey)) throw new Error("Invalid Mega shared key");
  return Buffer.from(sharedKey.slice(0, 32), "hex");
}

export function sharedSigningKey(sharedKey: string): string {
  if (!/^[0-9a-f]{64}$/i.test(sharedKey)) throw new Error("Invalid Mega shared key");
  return sharedKey.slice(0, 32);
}

export interface PendingKeyExchange {
  readonly ecdh: ECDH;
  readonly keyIdent: string;
  readonly clientPublicKey: string;
  readonly encryptedPublicKey: string;
}

export function beginKeyExchange(): PendingKeyExchange {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const clientPublicKey = ecdh.getPublicKey("hex");
  return {
    ecdh,
    keyIdent: randomIdentifier(),
    clientPublicKey,
    encryptedPublicKey: encryptEnvelope(clientPublicKey, presetKey()),
  };
}

export function finishKeyExchange(pending: PendingKeyExchange, encryptedServerPublicKey: string): MegaIdentity {
  const serverPublicKey = decryptEnvelope(encryptedServerPublicKey, presetKey());
  if (!/^04[0-9a-f]{128}$/i.test(serverPublicKey)) throw new Error("Mega returned an invalid server public key");
  const sharedKey = pending.ecdh.computeSecret(Buffer.from(serverPublicKey, "hex")).toString("hex");
  return { keyIdent: pending.keyIdent, sharedKey, clientPublicKey: pending.clientPublicKey };
}

export function encryptPassword(password: string): { encrypted: string; clientPublicKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const secret = ecdh.computeSecret(Buffer.from(LOGIN_SERVER_PUBLIC_KEY, "hex"));
  const cipher = createCipheriv("aes-256-cbc", secret, secret.subarray(0, 16));
  const encrypted = cipher.update(password, "utf8", "base64") + cipher.final("base64");
  return { encrypted, clientPublicKey: ecdh.getPublicKey("hex") };
}

export function loginHash(openUdid: string, email: string, password: string): string {
  return createHash("sha256").update(`${openUdid}:${email}:${password}`).digest("hex");
}

export function megaUserToken(userId: string): string {
  return createHash("md5").update(userId).digest("hex");
}
