# Project memory

## Current architecture

The Home Assistant integration talks only to the companion gateway over its authenticated local API. The gateway owns the Eufy-specific protocol boundary.

As of v0.1.11, production authentication, device discovery, push-token registration, push normalization, media download, and event-image decoding use the gateway's first-party Mega implementation. `eufy-security-client` is not a runtime dependency. Generic Firebase Cloud Messaging delivery is provided by `@eneris/push-receiver`; no Eufy account or device behavior is delegated to it.

The supported Mega camera inventory types validated against the project hardware are 7 (video doorbell), 8 (HomeBase battery camera), and 10031 (T817L). HomeBase type 18 is retained only as parent metadata and is not registered as a camera.

Live transport is intentionally unavailable in the first-party provider until the current HomeBase or Mega handshake can be implemented and validated without an obsolete Eufy API or a legacy Eufy client. Event sensors and retained event snapshots must remain independent of live-stream support.

## Delivery state

v0.1.11 is the first release on the first-party Mega provider. An existing valid Mega session is migrated once from the previous client state, then saved in the gateway-owned session format. New authentication still supports email verification and the app's CAPTCHA interface when Eufy requires either challenge.

Never log or expose credentials, session tokens, signing identities, raw signed media URLs, complete push payloads, or device serial numbers in diagnostics.
