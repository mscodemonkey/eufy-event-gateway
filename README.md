# Eufy Event Gateway for Home Assistant

[![My Home Assistant](https://img.shields.io/badge/Home%20Assistant-%2341BDF5.svg?style=flat&logo=home-assistant&label=My)](https://my.home-assistant.io/redirect/hacs_repository/?owner=mscodemonkey&repository=eufy-event-gateway&category=integration)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue.svg)](https://github.com/mscodemonkey/eufy-event-gateway/blob/main/LICENSE)

<p align="center">
  <img src="https://raw.githubusercontent.com/mscodemonkey/eufy-event-gateway/main/custom_components/eufy_event_gateway/brand/icon.png" width="128" height="128" alt="Eufy Event Gateway icon">
</p>

Reliable, event-first Home Assistant support for Eufy cameras that do not provide a permanent RTSP stream.

Motion and person detections arrive as Home Assistant entities, HomeBase 3 familiar-person names are exposed when Eufy actually supplies one, and the last good event image remains visible while the camera is idle.

> [!IMPORTANT]
> This is an early community project built against real EufyCam 2C, HomeBase 3, and Doorbell hardware. It is not affiliated with Anker or Eufy and should not be your only security system.

## What it provides

For every discovered camera, the integration creates:

- a camera entity with a retained event image;
- a motion binary sensor;
- a person binary sensor;
- a last-recognized-person sensor, including the detection type and timestamp.

The integration also defines two Home Assistant actions for on-demand streaming:

- `eufy_event_gateway.capture_snapshot` requests a fresh frame from a camera with a supported live transport;
- `eufy_event_gateway.record_clip` records from a camera with a supported live transport.

Live viewing uses Eufy's native Thing MQTT/P2P signalling and relay media path. The gateway implements that path directly; it does not use `eufy-security-client` or its obsolete APIs.

The actions work in Home Assistant automations and through Node-RED's Home Assistant Action node. An importable example is included in [`examples/node-red-gate-and-motion.json`](examples/node-red-gate-and-motion.json).

## How it fits together

This repository contains two parts, and Home Assistant needs both:

1. **Eufy Event Gateway app** — signs in through Eufy's current Mega service, receives push/HomeBase events, and retains snapshots.
2. **Eufy Event Gateway integration** — turns the gateway data into normal Home Assistant camera, binary-sensor, and sensor entities.

On Home Assistant OS or Supervised, the app generates its own private API token and passes it directly to the integration through Supervisor discovery. The gateway port is closed to the LAN by default.

## Before installing

Create a separate Eufy guest account and share only the Home and cameras you want Home Assistant to access. Do not use the Eufy account currently signed into your everyday mobile app; simultaneous Eufy sessions can interfere with one another.

You will need:

- Home Assistant OS or Home Assistant Supervised for the app installation below;
- HACS, or File Editor/SSH for the manual integration method;
- the guest account username, password, and two-letter account country code;
- the Eufy account credentials; live viewing does not require the Web Portal Access PIN.

## Install the integration with HACS

The project does not need to be accepted into HACS's default catalogue. Add it as a custom repository:

1. Open **HACS** in Home Assistant.
2. Open the three-dot menu and choose **Custom repositories**.
3. Enter `https://github.com/mscodemonkey/eufy-event-gateway`.
4. Select **Integration** as the category and add it.
5. Find **Eufy Event Gateway**, choose **Download**, and restart Home Assistant.

If you do not use HACS, copy `custom_components/eufy_event_gateway` into `/config/custom_components/eufy_event_gateway` and restart Home Assistant.

## Install the Home Assistant app

1. Open **Settings > Apps > App Store**.
2. Open the repository manager from the top-right menu.
3. Add `https://github.com/mscodemonkey/eufy-event-gateway`.
4. Find **Eufy Event Gateway** under the new repository and select **Install**.
5. On its **Configuration** tab, enter the dedicated Eufy guest username, password, and country code.
6. Start the app and enable **Start on boot** and **Watchdog**.

If the log says Eufy requested email verification, enter the temporary code in **Verification code**, restart the app once, and remove the code after it connects. Never post credentials, verification codes, or app logs containing private account details in a GitHub issue.

Mega events and web live viewing use separate Eufy sessions. If Eufy requests a CAPTCHA or sends a six-digit email code for either session, open the app's **Web UI** and complete the prompt there. The gateway stores the resulting sessions so routine app upgrades and restarts do not repeat authentication. Challenge answers and email codes are kept in memory only and are not written to the app configuration or logs.

## Connect it to Home Assistant

After the app connects:

1. Open **Settings > Devices & services**.
2. A discovered **Eufy Event Gateway** card should appear.
3. Select **Configure** and submit the confirmation.

The app address and generated API token are transferred privately. You do not need to copy either value.

If discovery does not appear, first confirm the app log reports a healthy gateway. Then choose **Add integration**, search for **Eufy Event Gateway**, and use the manual gateway details only if you deliberately exposed a standalone gateway.

## Automations and Node-RED

Motion and person detections are ordinary Home Assistant binary sensors, so they appear directly in Node-RED's **Events: state** node. Snapshot and recording requests are ordinary Home Assistant actions, so use an **Action** node with one of:

```text
eufy_event_gateway.capture_snapshot
eufy_event_gateway.record_clip
```

Both actions target the camera entity. Example recording data:

```json
{
  "filename": "/media/eufy/gate_latest.mp4",
  "duration": 15
}
```

Create the target directory first and ensure the path is allowed by Home Assistant. The importable example uses JSONata to add a timestamp to each filename. Import [`examples/node-red-gate-and-motion.json`](examples/node-red-gate-and-motion.json), select your Home Assistant server, replace the example entity IDs, and deploy it.

Recordings are assembled by the gateway with a hard stream-start timeout and duration limit, then written atomically by Home Assistant. A failed request therefore cannot leave a partial MP4 at the requested filename.

## Camera behaviour

- Motion and person notifications update their Home Assistant sensors without waking a stream.
- The last valid event image remains visible while the camera sleeps.
- Opening a camera starts its live WebRTC session on demand and stops it after the configured limit.
- A familiar-person name appears only when HomeBase supplies an explicit identity. Generic detections such as `Someone` remain unknown.
- Powered cameras with their own RTSP feed can continue using that feed for video while this integration supplies Eufy/HomeBase detection entities.

## Standalone gateway

Home Assistant Container/Core users can run the gateway separately with Node.js 24 and FFmpeg. From `eufy_event_gateway`:

```sh
npm ci
npm run build
EUFY_USERNAME='guest@example.com' \
EUFY_PASSWORD='your-password' \
EUFY_COUNTRY='AU' \
EUFY_GATEWAY_API_TOKEN='use-a-random-secret-of-at-least-32-characters' \
EUFY_GATEWAY_HOST='0.0.0.0' \
npm start
```

Keep credentials outside source control. A non-loopback gateway refuses to start without a bearer token of at least 32 characters. Add the integration manually using the reachable gateway URL and the same token.

For development without a Eufy account:

```sh
cd eufy_event_gateway
npm ci
EUFY_GATEWAY_PROVIDER=simulated npm run dev
```

## Supported and known limitations

Validated inventory currently includes HomeBase 3, three EufyCam 2C cameras, a video doorbell, and a powered T817L camera.

- Eufy's cloud, push, and HomeBase protocols are undocumented and can change without notice.
- Familiar-person names depend on HomeBase recognition and are not present in every Eufy event.
- Live video uses Eufy's native camera transport. Eufy may require account verification the first time that session is created.
- The app handles authentication challenges in its Web UI, then reuses valid Mega and web sessions across upgrades and restarts.
- The app currently publishes source builds for `amd64` and `aarch64`; installation may take several minutes.

## Privacy and security

- Eufy credentials, sessions, generated API tokens, and snapshots stay in the app's private persistent data volume.
- The app's API port is not exposed to the LAN by default.
- Process liveness is checked separately from Eufy connectivity, so an email-code prompt or temporary Eufy outage does not create a restart loop.
- API, snapshot, and event endpoints require authentication when the gateway is remotely reachable.
- Diagnostics intentionally exclude passwords, access tokens, signing keys, notification text, media URLs, and raw payloads.

## Development

```sh
cd eufy_event_gateway
npm ci
npm run check
npm run build
docker build -t eufy-event-gateway:test .
```

## Licence

[MIT](LICENSE)
