import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { GatewayConfig } from "./config.js";
import { GatewayState } from "./domain/gateway-state.js";
import type { GatewayEvent } from "./domain/types.js";
import { SimulatedProvider } from "./provider/simulated-provider.js";
import type { CaptchaProvider } from "./provider/provider.js";
import { SnapshotStore } from "./storage/snapshot-store.js";
import { LiveStreamManager } from "./stream/live-stream-manager.js";

export class GatewayServer {
  #server: Server | null = null;

  constructor(
    private readonly config: GatewayConfig,
    private readonly state: GatewayState,
    private readonly snapshots: SnapshotStore,
    private readonly streams: LiveStreamManager,
    private readonly simulatedProvider: SimulatedProvider | null,
    private readonly captchaProvider: CaptchaProvider | null = null,
  ) {}

  async listen(): Promise<void> {
    const server = createServer((request, response) => void this.#route(request, response));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.port, this.config.host, resolve);
    });
  }

  async close(): Promise<void> {
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) => this.#server?.close((error) => error ? reject(error) : resolve()));
    this.#server = null;
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      if (segments[0] === "api" && this.config.apiToken) {
        const streamAuthorized =
          request.method === "GET" &&
          segments[1] === "cameras" &&
          segments[3] === "live.h264" &&
          segments.length === 4 &&
          validateStreamToken(segments[2]!, url.searchParams.get("access_token"), this.config.apiToken);
        if (!streamAuthorized && !isBearerAuthorized(request.headers.authorization, this.config.apiToken)) {
          return json(response, 401, { error: "Unauthorized" });
        }
      }

      if (request.method === "GET" && url.pathname === "/live") {
        return json(response, 200, { status: "ok" });
      }
      if (request.method === "GET" && url.pathname === "/") return this.#authenticationPage(response);
      if (request.method === "POST" && url.pathname === "/") {
        const body = await readBody(request);
        const values = new URLSearchParams(body);
        if (values.has("answer")) return await this.#submitCaptchaValues(values, response);
        if (values.has("code")) return await this.#submitVerificationValues(values, response);
        return this.#authenticationPage(response, "The submitted authentication response was incomplete.");
      }
      if (request.method === "POST" && url.pathname === "/auth/captcha") {
        return await this.#submitCaptcha(request, response);
      }
      if (request.method === "POST" && url.pathname === "/auth/verification") {
        return await this.#submitVerification(request, response);
      }
      if (request.method === "GET" && url.pathname === "/health") {
        const connection = this.state.getConnection();
        return json(response, connection.state === "connected" ? 200 : 503, {
          status: connection.state === "connected" ? "ok" : "degraded",
          connection,
          cameraCount: this.state.listCameras().length,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/cameras") {
        return json(response, 200, { cameras: this.state.listCameras() });
      }
      if (request.method === "GET" && url.pathname === "/api/diagnostics/push") {
        return json(response, 200, { events: this.state.listPushDiagnostics() });
      }
      if (request.method === "GET" && url.pathname === "/api/diagnostics/inventory") {
        return json(response, 200, { devices: this.state.listInventoryDiagnostics() });
      }
      if (request.method === "GET" && segments[0] === "api" && segments[1] === "cameras" && segments.length === 3) {
        return this.#cameraJson(segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "stream-token" && segments.length === 4
      ) {
        return this.#streamToken(segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "capture-snapshot" && segments.length === 4
      ) {
        return await this.#captureSnapshot(segments[2]!, response);
      }
      if (
        request.method === "POST" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "record.mp4" && segments.length === 4
      ) {
        return await this.#recordClip(request, segments[2]!, response);
      }
      if (
        request.method === "GET" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "snapshot" && segments.length === 4
      ) {
        return await this.#snapshot(segments[2]!, response);
      }
      if (
        request.method === "GET" &&
        segments[0] === "api" && segments[1] === "cameras" && segments[3] === "live.h264" && segments.length === 4
      ) {
        return await this.#live(segments[2]!, response);
      }
      if (request.method === "GET" && url.pathname === "/api/events") return this.#events(request, response);
      if (request.method === "POST" && url.pathname === "/api/simulate/detection" && this.simulatedProvider) {
        const body = await readJson(request);
        this.simulatedProvider.detectMotion(typeof body.personName === "string" ? body.personName : null);
        return json(response, 202, { accepted: true });
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 500;
      return json(response, status, { error: safeError(error) });
    }
  }

  #authenticationPage(response: ServerResponse, message = ""): void {
    const challenge = this.captchaProvider?.getCaptchaChallenge() ?? null;
    const connection = this.state.getConnection();
    const content = challenge
      ? `<p>Eufy needs you to solve this one-time challenge.</p><img src="${captchaDataUri(challenge.image)}" alt="Eufy CAPTCHA"><form method="post" action=""><label for="answer">Characters shown</label><input id="answer" name="answer" required maxlength="32" autocomplete="off" autocapitalize="none"><button type="submit">Connect to Eufy</button></form>`
      : this.captchaProvider?.isVerificationRequired()
        ? `<p>Eufy sent a six-digit verification code to your account email.</p><form method="post" action=""><label for="code">Verification code</label><input id="code" name="code" required minlength="6" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code"><button type="submit">Verify and connect</button></form>`
      : connection.state === "connected"
        ? `<p><strong>Connected to Eufy.</strong></p><p>The gateway is ready. Return to Home Assistant to review your cameras and entities.</p><a class="button" href="/config/integrations/integration/eufy_event_gateway" target="_top">View Eufy integration</a>`
        : `<p>No authentication challenge is waiting.</p><p>Current connection: <strong>${escapeHtml(connection.state)}</strong>${connection.detail ? ` — ${escapeHtml(connection.detail)}` : ""}.</p>`;
    return html(response, 200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Eufy Event Gateway</title><style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#202124}main{border:1px solid #ddd;border-radius:12px;padding:1.5rem}img{display:block;max-width:100%;margin:1rem 0;border:1px solid #ddd}label,input,button{display:block;width:100%;box-sizing:border-box}input,button,.button{font:inherit;padding:.75rem;margin:.4rem 0 1rem}.button{display:inline-block;width:auto;border-radius:999px;background:#03a9f4;color:#fff;text-decoration:none}button{cursor:pointer}</style><main><h1>Eufy Event Gateway</h1>${message ? `<p role="status">${escapeHtml(message)}</p>` : ""}${content}</main></html>`);
  }

  async #submitCaptcha(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    return this.#submitCaptchaValues(new URLSearchParams(body), response);
  }

  async #submitCaptchaValues(values: URLSearchParams, response: ServerResponse): Promise<void> {
    if (!this.captchaProvider) return this.#authenticationPage(response, "CAPTCHA authentication is unavailable.");
    const answer = values.get("answer")?.trim() ?? "";
    if (!answer || answer.length > 32) return this.#authenticationPage(response, "Enter the characters shown in the image.");
    try {
      await this.captchaProvider.submitCaptcha(answer);
      const nextChallenge = this.captchaProvider.getCaptchaChallenge();
      return this.#authenticationPage(
        response,
        captchaResultMessage(nextChallenge !== null),
      );
    } catch (error) {
      return this.#authenticationPage(response, `Eufy did not accept the answer: ${safeError(error)}`);
    }
  }

  async #submitVerification(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    return this.#submitVerificationValues(new URLSearchParams(body), response);
  }

  async #submitVerificationValues(values: URLSearchParams, response: ServerResponse): Promise<void> {
    if (!this.captchaProvider) return this.#authenticationPage(response, "Verification is unavailable.");
    const code = values.get("code")?.trim() ?? "";
    if (!/^\d{6}$/.test(code)) return this.#authenticationPage(response, "Enter the six-digit code Eufy sent you.");
    try {
      await this.captchaProvider.submitVerification(code);
      return this.#authenticationPage(response, "Verification accepted.");
    } catch (error) {
      return this.#authenticationPage(response, `Eufy did not accept the verification code: ${safeError(error)}`);
    }
  }

  #cameraJson(serial: string, response: ServerResponse): void {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    return json(response, 200, this.state.getCamera(serial));
  }

  async #snapshot(serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    const snapshot = await this.snapshots.read(serial);
    if (!snapshot) return json(response, 404, { error: "No snapshot captured yet" });
    response.writeHead(200, {
      "Content-Type": snapshot.info.contentType,
      "Content-Length": snapshot.data.length,
      "Cache-Control": "no-cache",
      ETag: `\"${snapshot.info.revision}\"`,
      "Last-Modified": new Date(snapshot.info.capturedAt).toUTCString(),
    });
    response.end(snapshot.data);
  }

  async #live(serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    if (!this.state.getCamera(serial).streamSupported) {
      return json(response, 409, { error: "This camera was discovered through push events only; livestream control is unavailable" });
    }
    await this.streams.addClient(serial, response);
  }

  #streamToken(serial: string, response: ServerResponse): void {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    if (!this.state.getCamera(serial).streamSupported) {
      return json(response, 409, { error: "Livestream control is unavailable for this camera" });
    }
    const expiresAt = Math.floor(Date.now() / 1_000) + 120;
    const token = this.config.apiToken
      ? createStreamToken(serial, expiresAt, this.config.apiToken)
      : null;
    const path = `/api/cameras/${encodeURIComponent(serial)}/live.h264${token ? `?access_token=${encodeURIComponent(token)}` : ""}`;
    return json(response, 200, { path, expiresAt });
  }

  async #captureSnapshot(serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    if (!this.state.getCamera(serial).streamSupported) {
      return json(response, 409, { error: "Fresh snapshot capture is unavailable for this camera" });
    }
    const snapshot = await this.streams.captureSnapshot(serial);
    return json(response, 200, { snapshot });
  }

  async #recordClip(request: IncomingMessage, serial: string, response: ServerResponse): Promise<void> {
    if (!this.state.hasCamera(serial)) return json(response, 404, { error: "Camera not found" });
    if (!this.state.getCamera(serial).streamSupported) {
      return json(response, 409, { error: "Clip recording is unavailable for this camera" });
    }
    const body = await readJson(request);
    const duration = body.duration;
    if (!Number.isInteger(duration) || (duration as number) < 1 || (duration as number) > 120) {
      return json(response, 400, { error: "Recording duration must be between 1 and 120 seconds" });
    }
    const clip = await this.streams.recordClip(serial, duration as number);
    response.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": clip.length,
      "Cache-Control": "no-store",
    });
    response.end(clip);
  }

  #events(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ cameras: this.state.listCameras() })}\n\n`);
    const listener = (event: GatewayEvent) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    this.state.on("event", listener);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.once("close", () => {
      clearInterval(heartbeat);
      this.state.off("event", listener);
    });
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
  response.end(data);
}

function html(response: ServerResponse, status: number, body: string): void {
  const data = Buffer.from(body);
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store" });
  response.end(data);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function captchaDataUri(image: string): string {
  if (image.startsWith("data:image/")) return escapeHtml(image);
  return `data:image/jpeg;base64,${escapeHtml(image)}`;
}

export function captchaResultMessage(hasNextChallenge: boolean): string {
  return hasNextChallenge
    ? "Eufy did not accept that answer. Try the new challenge below."
    : "CAPTCHA accepted.";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SyntaxError("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected gateway error";
}

export function isBearerAuthorized(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return equalSecret(header.slice(7), expectedToken);
}

export function createStreamToken(serial: string, expiresAt: number, apiToken: string): string {
  const signature = createHmac("sha256", apiToken).update(`${serial}.${expiresAt}`).digest("base64url");
  return `${expiresAt}.${signature}`;
}

export function validateStreamToken(
  serial: string,
  token: string | null,
  apiToken: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator < 1) return false;
  const expiresAt = Number.parseInt(token.slice(0, separator), 10);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < nowSeconds || expiresAt > nowSeconds + 180) return false;
  return equalSecret(token, createStreamToken(serial, expiresAt, apiToken));
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
