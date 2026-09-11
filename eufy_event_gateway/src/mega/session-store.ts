import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { MegaIdentity, MegaSession } from "./types.js";

export class MegaSessionStore {
  constructor(private readonly path: string, private readonly legacyPath?: string) {}

  async load(): Promise<MegaSession | null> {
    const current = await readJson(this.path);
    const parsed = parseSession(current);
    if (parsed) return parsed;
    if (!this.legacyPath) return null;
    return parseLegacySession(await readJson(this.legacyPath));
  }

  async save(session: MegaSession): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function parseSession(value: unknown): MegaSession | null {
  if (!isRecord(value) || value.version !== 1) return null;
  return validatedSession(value);
}

function parseLegacySession(value: unknown): MegaSession | null {
  if (!isRecord(value) || !isRecord(value.megaApi)) return null;
  const legacy = value.megaApi;
  return validatedSession({
    version: 1,
    country: legacy.ab,
    openUdid: legacy.openudid,
    loginHash: legacy.login_hash,
    authToken: legacy.cloud_token,
    tokenExpiresAt: legacy.cloud_token_expiration,
    userId: legacy.user_id,
    megaDomain: legacy.megaDomain,
    domains: legacy.domains,
    identities: legacy.identities,
  });
}

function validatedSession(value: Record<string, unknown>): MegaSession | null {
  const identities = parseIdentities(value.identities);
  if (
    typeof value.country !== "string" || typeof value.openUdid !== "string" ||
    typeof value.loginHash !== "string" || typeof value.authToken !== "string" ||
    typeof value.tokenExpiresAt !== "number" || typeof value.userId !== "string" ||
    typeof value.megaDomain !== "string" || !isStringRecord(value.domains) || !identities
  ) return null;
  return {
    version: 1,
    country: value.country,
    openUdid: value.openUdid,
    loginHash: value.loginHash,
    authToken: value.authToken,
    tokenExpiresAt: value.tokenExpiresAt,
    userId: value.userId,
    megaDomain: value.megaDomain,
    domains: value.domains,
    identities,
  };
}

function parseIdentities(value: unknown): Record<string, MegaIdentity> | null {
  if (!isRecord(value)) return null;
  const parsed: Record<string, MegaIdentity> = {};
  for (const [host, identity] of Object.entries(value)) {
    if (!isRecord(identity) || typeof identity.keyIdent !== "string" ||
      typeof identity.sharedKey !== "string" || typeof identity.clientPublicKey !== "string") return null;
    parsed[host] = {
      keyIdent: identity.keyIdent,
      sharedKey: identity.sharedKey,
      clientPublicKey: identity.clientPublicKey,
    };
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}
