export interface MegaIdentity {
  readonly keyIdent: string;
  readonly sharedKey: string;
  readonly clientPublicKey: string;
}

export interface MegaSession {
  readonly version: 1;
  readonly country: string;
  readonly openUdid: string;
  readonly loginHash: string;
  readonly authToken: string;
  readonly tokenExpiresAt: number;
  readonly userId: string;
  readonly megaDomain: string;
  readonly domains: Readonly<Record<string, string>>;
  readonly identities: Readonly<Record<string, MegaIdentity>>;
}

export interface MegaResult {
  readonly code: number;
  readonly msg?: string;
  readonly data?: unknown;
}

export interface MegaDevice {
  readonly device_sn: string;
  readonly device_name?: string;
  readonly device_model?: string;
  readonly device_type?: number;
  readonly parent_sn?: string;
  readonly station_sn?: string;
  readonly category?: string;
  readonly channel?: number;
  readonly device_channel?: number;
  readonly ip_addr?: string;
  readonly app_conn?: string;
  readonly p2p_did?: string;
  readonly p2p_license?: string;
  readonly push_did?: string;
  readonly member?: { readonly admin_user_id?: string };
  readonly params?: ReadonlyArray<{ readonly param_type?: number; readonly param_value?: string }>;
  readonly [key: string]: unknown;
}

export interface MegaInventory {
  readonly devices: readonly MegaDevice[];
  readonly groups: readonly unknown[];
}

export interface MegaCaptcha {
  readonly id: string;
  readonly image: string;
}

export interface MegaAuthResult {
  readonly state: "authenticated" | "verification-required" | "captcha-required";
  readonly captcha?: MegaCaptcha;
}
