# Changelog

## 0.1.11

- Replace the obsolete Eufy login and device client with the gateway's own Mega API implementation.
- Discover HomeBase 3 battery cameras, video doorbells, and T817L cameras directly from Mega inventory.
- Register and normalize current Eufy push notifications without the `eufy-security-client` runtime dependency.
- Decode and retain event snapshots using the gateway's own image decoder.
- Reuse an existing authenticated Mega session during the one-time upgrade, avoiding unnecessary CAPTCHA authentication.

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
