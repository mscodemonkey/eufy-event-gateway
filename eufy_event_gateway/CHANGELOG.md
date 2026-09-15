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

- Add a gateway-owned first-party PPCS camera transport with level-2 key negotiation.
- Prove live H.264 and fresh JPEG snapshots for wired and battery camera classes before Home Assistant integration.
- Remove the obsolete Web Portal PIN and Thing-login stream configuration.

## 0.1.11

- Use the gateway's first-party Mega authentication, inventory, push, and event-image implementations.
- Register camera types 7, 8, and 10031 from the current Mega inventory.
- Migrate an existing authenticated Mega session without retaining the obsolete client dependency.
- Disable unsupported live-stream actions instead of routing them through the retired legacy API.

## 0.1.10

- Use the Mega client's supported device-list request instead of an incompatible low-level payload.

## 0.1.9

- Avoid the legacy device list while operating through an authenticated Mega-only session.

## 0.1.8

- Use an authenticated Mega session for camera discovery and push notifications without requiring the failed legacy login.

## 0.1.7

- Keep CAPTCHA results inside the app web interface and show a fresh challenge when Eufy rejects an answer.

## 0.1.6

- Add an authenticated Home Assistant app web interface for completing Eufy CAPTCHA challenges.

## 0.1.5

- Download and retain event thumbnails for push-only HomeBase 3 cameras.

## 0.1.4

- Keep the app and companion integration release versions aligned.

## 0.1.3

- Keep the app and companion integration release versions aligned.

## 0.1.2

- Keep the app and companion integration release versions aligned.

## 0.1.1

- Include the companion integration's HACS brand asset in the repository release.

## 0.1.0

- Initial event-first gateway release.
- Generated private API authentication and Home Assistant discovery.
- Legacy and Mega device inventory, push detections, retained images, and on-demand P2P video.
- Independent liveness checks that keep authentication-required and temporary-disconnection states observable.
