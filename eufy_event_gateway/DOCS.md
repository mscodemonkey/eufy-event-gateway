# Eufy Event Gateway

This app runs the local Eufy gateway beside Home Assistant. It signs in through Eufy's current Mega service, receives Eufy and HomeBase events continuously, and retains the last useful camera image.

## Configuration

- **Username**: the dedicated guest Eufy account shared with the required cameras.
- **Password**: that account's Eufy password.
- **Country**: the two-letter Eufy account country, such as `AU`.
- **Verification code**: leave this empty unless the log says Eufy requires an emailed code. Enter the code, restart once, then remove it after the app connects.

The app generates its own API token on first start and sends the private connection details to the integration through Supervisor discovery. The gateway port is not exposed to the LAN and no token needs to be copied or entered manually.

The app stores its authenticated Eufy session and retained snapshots in its private `/data` volume so they survive restarts and are included in Home Assistant backups.

After the app starts, open **Settings > Devices & services**. Home Assistant should show a discovered **Eufy Event Gateway** integration. Select **Configure** to create its camera and detection entities.

The companion integration exposes `capture_snapshot` and `record_clip` actions for cameras with a supported live transport. The first-party Mega provider in v0.1.11 does not yet provide live video, so these actions clearly report that streaming is unsupported.
