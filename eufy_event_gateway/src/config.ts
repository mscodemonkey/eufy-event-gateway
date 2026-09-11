import { resolve } from "node:path";

export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDirectory: string;
  readonly provider: "eufy" | "simulated";
  readonly streamGraceMilliseconds: number;
  readonly maxStreamSeconds: number;
  readonly apiToken: string | null;
  readonly eufy: {
    readonly username: string | null;
    readonly password: string | null;
    readonly country: string;
    readonly webPortalPin: string | null;
    readonly verifyCode?: string;
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const provider = environment.EUFY_GATEWAY_PROVIDER === "simulated" ? "simulated" : "eufy";
  const verifyCode = nonEmpty(environment.EUFY_VERIFY_CODE);
  const host = environment.EUFY_GATEWAY_HOST ?? "127.0.0.1";
  const apiToken = nonEmpty(environment.EUFY_GATEWAY_API_TOKEN);
  if (!isLoopbackHost(host) && !apiToken) {
    throw new Error("EUFY_GATEWAY_API_TOKEN is required when the gateway is not bound to loopback");
  }
  if (apiToken && apiToken.length < 32) {
    throw new Error("EUFY_GATEWAY_API_TOKEN must be at least 32 characters");
  }
  return {
    host,
    port: positiveInteger(environment.EUFY_GATEWAY_PORT, 3218),
    dataDirectory: resolve(environment.EUFY_GATEWAY_DATA_DIR ?? "./data"),
    provider,
    streamGraceMilliseconds: positiveInteger(environment.EUFY_GATEWAY_STREAM_GRACE_SECONDS, 10) * 1_000,
    maxStreamSeconds: positiveInteger(environment.EUFY_GATEWAY_MAX_STREAM_SECONDS, 120),
    apiToken,
    eufy: {
      username: nonEmpty(environment.EUFY_USERNAME),
      password: nonEmpty(environment.EUFY_PASSWORD),
      country: (environment.EUFY_COUNTRY ?? "AU").toUpperCase(),
      webPortalPin: nonEmpty(environment.EUFY_WEB_PORTAL_PIN),
      ...(verifyCode ? { verifyCode } : {}),
    },
  };
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost";
}

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received: ${value}`);
  return parsed;
}
