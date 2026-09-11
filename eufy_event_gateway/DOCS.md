# Eufy Event Gateway

This app runs the local Eufy gateway beside Home Assistant. It signs in through Eufy's current Mega service, receives Eufy and HomeBase events continuously, and retains the last useful camera image.

## Configuration

- **Username**: the dedicated guest Eufy account shared with the required cameras.
- **Password**: that account's Eufy password.
- **Country**: the two-letter Eufy account country, such as `AU`.
- **Native camera transport**: live viewing uses Eufy's Thing MQTT/P2P relay session and does not require a Web Portal Access PIN.
- **Verification code**: leave this empty unless the log says Eufy requires an emailed code. Enter the code, restart once, then remove it after the app connects.

The app generates its own API token on first start and sends the private connection details to the integration through Supervisor discovery. The gateway port is not exposed to the LAN and no token needs to be copied or entered manually.

The app stores its authenticated Eufy session and retained snapshots in its private `/data` volume so they survive restarts and are included in Home Assistant backups.

After the app starts, open **Settings > Devices & services**. Home Assistant should show a discovered **Eufy Event Gateway** integration. Select **Configure** to create its camera and detection entities.

Mega events and web live viewing use separate Eufy sessions. If Eufy requests a CAPTCHA or sends an email code, open the app's **Web UI** and complete the prompt. The authenticated sessions persist in the app's private data volume, so routine upgrades and restarts do not repeat the challenge.

The companion integration exposes live camera views plus `capture_snapshot` and `record_clip` actions. The gateway receives standard WebRTC video from Eufy's current web service and converts its H.264 track for Home Assistant without a legacy Eufy client dependency.
