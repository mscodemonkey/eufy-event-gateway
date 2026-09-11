# Eufy Event Gateway

The gateway app is the event and video engine for the Eufy Event Gateway Home Assistant integration.

It signs in through Eufy's current Mega service, receives Eufy/HomeBase detections, retains the last useful event image, and starts live video on demand through Eufy's current web WebRTC service. Both Eufy protocol paths are implemented directly by the gateway. It generates a private API token automatically and announces its connection details to Home Assistant through Supervisor discovery; its API port is not exposed to the LAN by default.

Install the companion `eufy_event_gateway` custom integration before starting this app. Configure a dedicated Eufy guest account shared with the required cameras, then start the app and accept the discovered integration under **Settings > Devices & services**.

See the [project README](https://github.com/mscodemonkey/eufy-event-gateway) for complete HACS, app, automation, Node-RED, and troubleshooting instructions.
