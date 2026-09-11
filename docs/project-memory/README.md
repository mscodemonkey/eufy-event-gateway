# Project memory

## Current architecture

The Home Assistant integration talks only to the companion gateway over its authenticated local API. The gateway owns the Eufy-specific protocol boundary.

As of v0.1.11, production authentication, device discovery, push-token registration, push normalization, media download, event-image decoding, web authentication, WebRTC signalling, and H.264 RTP conversion use gateway-owned implementations. `eufy-security-client` is not a runtime dependency. Generic Firebase Cloud Messaging delivery is provided by `@eneris/push-receiver`; no Eufy account or device behavior is delegated to it. The standard WebRTC peer implementation is provided by `werift`.

The supported Mega camera inventory types validated against the project hardware are 7 (video doorbell), 8 (HomeBase battery camera), and 10031 (T817L). HomeBase type 18 is retained only as parent metadata and is not registered as a camera.

The live-transport replacement is being moved to Eufy's native Mega/Thing MQTT and P2P signalling path. The gateway now contains first-party Thing gateway authentication, native MQTT identity/topic/framing support, provider-level RTC/session orchestration, relay handshake and keepalive framing, KCP segmentation/acknowledgement, channel-zero authentication, and AES/KCP media extraction primitives. Live H.264 validation remains before release. The existing web/WebRTC path is temporary compatibility code only and still requires the account's expiring Web Portal Access PIN. Event sensors and retained event snapshots remain independent of live-stream support.

## Delivery state

v0.1.11 is the first release on the first-party Mega and web-stream providers. An existing valid Mega session is migrated once from the previous client state, then saved in the gateway-owned session format. New Mega or web authentication supports email verification and the app's CAPTCHA interface when Eufy requires either challenge. The two Eufy sessions are independently scoped and stored.

Never log or expose credentials, session tokens, signing identities, raw signed media URLs, complete push payloads, or device serial numbers in diagnostics.
