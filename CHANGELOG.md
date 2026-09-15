# Changelog

## 0.1.21

- Register Mega inventory type 23 after an EufyCam T8161 installation reported a complete HomeBase/PPCS stream path but was excluded only by camera classification.

## 0.1.20

- Remove the unused Web Portal/WebRTC, Thing/MQTT, and experimental native-relay code paths and their dependencies.
- Replace the saved session's fast password-derived value with a version 2 `scrypt` credential verifier. The first start after upgrading requires a fresh Eufy sign-in.
- Document why live PPCS sessions still use an ephemeral RSA-1024 key: current cameras return the encrypted video key in a fixed 128-byte protocol field.

## 0.1.19

- Discover T8160/S330, T8410/T8410C, and T8213 cameras from the Mega inventory types reported by affected installations.
- Keep the type 18 HomeBase as parent metadata instead of exposing it as a camera.
- Thanks to @AbeltjeNL for patiently testing the setup and sharing the inventory log that identified the missing device types.

## 0.1.18

- Prefix every gateway support-log line with a UTC timestamp, severity, release version, process run ID, component, and event name.
- Record explicit process start, listening, stop, and fatal-error events so copied logs preserve restart boundaries.
- Report grouped Mega inventory classifications and stream-readiness fields without device names or serial numbers.
- Suppress expected readiness-probe connection noise and redact common credentials and account email addresses from gateway diagnostics.

## 0.1.17

- Show the verification-code field directly in app configuration instead of hiding it behind the optional-field control.
- Capture retained images sequentially for newly discovered cameras that have no snapshot.
- Exit cleanly after Supervisor sends `SIGTERM` instead of reporting the gateway process's signal status as app exit code 143.

## 0.1.16

- Preserve Eufy's limited pre-verification Mega session across the documented app restart so email-code submission retains its required token.
- Submit Web UI email verification through the active Mega client instead of the separate legacy web session.
- Add regression coverage for verification-required login, app restart, and successful code submission.

## 0.1.15

- Add a first-day developer guide covering the repository architecture, Mega authentication, inventory, push events, snapshots, PPCS streaming, and Home Assistant conversion.
- Add a detailed Mega platform and protocol reference with endpoint, payload, encryption, and media-flow documentation.
- Expand file-level TypeScript, Python, probe, and test documentation so maintainers can understand ownership, lifecycle, and protocol boundaries from the source.
- Add direct links to the developer documentation from the public and app READMEs.

## 0.1.14

- Add contributor, security, and repository file-map documentation.
- Document the internal `eufy_event_gateway` compatibility identifiers separately from the Eufy Mega Security branding.
- Expand source comments around the Mega, PPCS, state, storage, and Home Assistant integration boundaries.
- Clarify that a battery camera with no charge can complete the PPCS handshake without producing video.

## 0.1.13

- Rename the project, Home Assistant integration, and HACS repository to Eufy Mega Security.

## 0.1.12

- Add the gateway-owned first-party PPCS transport for live H.264 streams and fresh camera snapshots.
- Discover and use Eufy's DSK and ECC cipher APIs without the Web Portal PIN, SmartLife/Thing login, or `eufy-security-client`.
- Validate the transport against wired T8210 and battery T817L cameras before exposing the Home Assistant live entities.

## 0.1.11

- Replace the obsolete Eufy login and device client with the gateway's own Mega API implementation.
- Discover HomeBase 3 battery cameras, video doorbells, and T817L cameras directly from Mega inventory.
- Register and normalize current Eufy push notifications without the `eufy-security-client` runtime dependency.
- Decode and retain event snapshots using the gateway's own image decoder.
- Reuse an existing authenticated Mega session during the one-time upgrade, avoiding unnecessary CAPTCHA authentication.
- Add a first-party client for Eufy's current web authentication and WebRTC signalling services.
- Restore on-demand live viewing, fresh snapshots, and clip recording for the discovered cameras without `eufy-security-client`.
- Persist the separate web session and handle its CAPTCHA or email verification prompt inside the app Web UI.

## 0.1.10

- Fetch the complete Mega camera inventory using the current API's supported device-list request.

## 0.1.9

- Load Mega camera inventory directly when the legacy Eufy service is unavailable.

## 0.1.8

- Continue through Eufy's current API when its obsolete legacy login requests CAPTCHA after Mega authentication has already succeeded.

## 0.1.7

- Keep CAPTCHA results inside the app web interface and show a fresh challenge when Eufy rejects an answer.

## 0.1.6

- Add a Home Assistant app web interface for completing Eufy CAPTCHA challenges during first sign-in.

## 0.1.5

- Show retained event thumbnails for push-only cameras discovered through HomeBase 3.

## 0.1.4

- Remove internal development notes from the public release.

## 0.1.3

- Use a HACS-compatible static MIT licence badge.

## 0.1.2

- Fix the project icon in HACS's rendered README.
- Add one-click HACS installation and licence badges.

## 0.1.1

- Add the local integration brand icon required by HACS.
- Publish a versioned update to validate the HACS upgrade path.

## 0.1.0

- Initial public hardware-validation release.
- Event-first Eufy camera gateway with legacy and Mega inventory discovery.
- Home Assistant camera, motion, person, and familiar-person entities.
- On-demand battery-camera live streams with retained idle images.
- Fresh-snapshot and timed-recording actions for automations and Node-RED.
- Home Assistant OS app with generated private API authentication and Supervisor discovery.
- Separate process-liveness and Eufy-connection health checks so authentication prompts do not cause app restart loops.
