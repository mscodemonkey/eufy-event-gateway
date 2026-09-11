import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { WebApiIdentity, WebSession } from "./web-types.js";

export class WebSessionStore {
  constructor(private readonly path: string) {}

  async load(): Promise<WebSession | null> {
    try {
      return parseSession(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async save(session: WebSession): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

function parseSession(value: unknown): WebSession | null {
  if (!isRecord(value) || value.version !== 1 || !isIdentity(value.apiIdentity)) return null;
  const keys = [
    "country", "loginHash", "host", "authToken", "userId", "clientPrivateKey", "clientPublicKey", "serverPublicKey",
  ] as const;
  if (!keys.every((key) => typeof value[key] === "string") || typeof value.tokenExpiresAt !== "number") return null;
  return value as unknown as WebSession;
}

function isIdentity(value: unknown): value is WebApiIdentity {
  return isRecord(value) && ["keyIdent", "sharedKey", "privateKey", "publicKey"].every(
    (key) => typeof value[key] === "string",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
