import type { Readable } from "node:stream";

import type { CameraIdentity, InventoryDiagnostic, PushDiagnostic } from "../domain/types.js";

export interface ProviderEvents {
  camera(identity: CameraIdentity): void;
  connection(state: "connected" | "disconnected" | "authentication-required" | "error", detail: string | null): void;
  motion(serial: string, detected: boolean): void;
  person(serial: string, detected: boolean, personName: string | null): void;
  snapshot(serial: string, data: Buffer, contentType: string): void;
  pushDiagnostic(diagnostic: PushDiagnostic): void;
  inventory(diagnostics: InventoryDiagnostic[]): void;
  streamStarted(serial: string, video: Readable): void;
  streamStopped(serial: string): void;
}

export interface CameraProvider {
  start(events: ProviderEvents): Promise<void>;
  startStream(serial: string): Promise<void>;
  stopStream(serial: string): Promise<void>;
  close(): Promise<void>;
}

export interface CaptchaChallenge {
  readonly id: string;
  readonly image: string;
}

export interface CaptchaProvider {
  getCaptchaChallenge(): CaptchaChallenge | null;
  isVerificationRequired(): boolean;
  submitCaptcha(answer: string): Promise<void>;
  submitVerification(code: string): Promise<void>;
}
