export interface WebApiIdentity {
  readonly keyIdent: string;
  readonly sharedKey: string;
  readonly privateKey: string;
  readonly publicKey: string;
}

export interface WebSession {
  readonly version: 1;
  readonly country: string;
  readonly loginHash: string;
  readonly host: string;
  readonly authToken: string;
  readonly userId: string;
  readonly tokenExpiresAt: number;
  readonly clientPrivateKey: string;
  readonly clientPublicKey: string;
  readonly serverPublicKey: string;
  readonly apiIdentity: WebApiIdentity;
}

export interface WebAuthResult {
  readonly state: "authenticated" | "verification-required" | "captcha-required";
  readonly captcha?: { readonly id: string; readonly image: string };
}
