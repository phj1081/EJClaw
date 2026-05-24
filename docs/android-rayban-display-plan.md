# Android / Meta Ray-Ban Display Plan

## Goal

Build a personal Android companion for EJClaw that reuses the existing server and dashboard APIs, then extend it to Meta Ray-Ban Display through the Meta Wearables Device Access Toolkit (DAT) when the device developer preview is available to the account.

## Current Platform Facts

- EJClaw is a Bun/Node host service. Android should be a thin client, not a port of the runtime.
- Meta DAT is in developer preview and provides Android SDK artifacts and sample app guidance through the public `facebook/meta-wearables-dat-android` repo.
- DAT preview allows SDK/documentation access and sharing builds with organization/team testers; general public publishing is limited during preview.
- Ray-Ban Display currently has two developer paths: Web Apps Dev Mode for HTML/CSS/JS standalone display apps, and DAT Display Developer Preview for extending Android/iOS apps onto the display.

Sources:

- https://developers.meta.com/blog/introducing-meta-wearables-device-access-toolkit/
- https://github.com/facebook/meta-wearables-dat-android
- https://www.levinriegner.com/news/l-r-joins-meta-to-open-ray-ban-display-to-developers/

## MVP Shape

1. Keep EJClaw running on the existing server.
2. Expose the web dashboard only through localhost, VPN, or a private tunnel.
3. Require `WEB_DASHBOARD_TOKEN` for `/api/*` before phone clients connect.
4. Build an Android app that talks to the existing dashboard API:
   - `GET /api/overview`
   - `GET /api/rooms-timeline`
   - `GET /api/rooms/:jid/timeline`
   - `POST /api/rooms/:jid/messages`
5. Add DAT only for the display surface:
   - short current-room status
   - latest assistant output
   - progress text
   - quick reply / send command entry

## Security Model

Do not expose EJClaw directly to the internet without a private transport.

Recommended personal setup:

- `WEB_DASHBOARD_HOST=127.0.0.1` for local-only use, or bind through Tailscale / VPN / SSH tunnel.
- Set `WEB_DASHBOARD_TOKEN` and send it from Android as `Authorization: Bearer <token>`.
- Keep restart/settings/account routes available only over the same protected API; do not add unauthenticated mobile-only shortcuts.

## Android App Plan

Use Kotlin for the first native client. The app can be small:

- `EJClawApi`: HTTP client with bearer token.
- `RoomListViewModel`: fetches `/api/rooms-timeline` on interval.
- `RoomThreadViewModel`: fetches room timeline and sends messages.
- `DisplayBridge`: DAT integration boundary, initially hidden behind an interface so the app can run without glasses.

The first build does not need DAT to validate EJClaw connectivity. DAT comes after the phone client can read rooms and send one message.

## DAT Integration Boundary

Keep Meta SDK code isolated under an Android module/package such as:

```text
apps/android/app/src/main/java/.../display/
```

Suggested interfaces:

```kotlin
interface DisplaySurface {
    fun showStatus(roomName: String, state: String, progress: String?)
    fun showMessage(roomName: String, text: String)
}

class NoopDisplaySurface : DisplaySurface { ... }
class MetaDatDisplaySurface : DisplaySurface { ... }
```

This avoids blocking normal phone testing when DAT access, glasses firmware, region support, or Developer Mode is not ready.

## Open Questions

- Is the Meta Wearables Developer Center account approved for DAT Display Developer Preview?
- Is the target phone able to pair with Ray-Ban Display in the current region/account setup?
- Should first Android build be native Kotlin UI or a minimal WebView wrapper around the existing dashboard?
- Which private transport will be used: Tailscale, SSH tunnel, Cloudflare Tunnel with access policy, or LAN only?

## Next Step

Implement the Android MVP only after the API token guard is merged and deployed. The initial Android client should prove:

1. Authenticate to EJClaw.
2. List rooms.
3. Open one room timeline.
4. Send one message.
5. Run without DAT using `NoopDisplaySurface`.
