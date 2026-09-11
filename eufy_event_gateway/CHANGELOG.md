# Changelog

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
