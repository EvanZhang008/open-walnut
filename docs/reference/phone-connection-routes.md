# Phone connection routes

The iOS app holds one device token and several addresses ("routes") for the same
Walnut. It uses the best route that answers and moves to another one by itself when
that changes. Nothing about this needs the user's attention after the first pairing.

## The three routes

| Route | Address | Reaches the machine when | Needs |
|---|---|---|---|
| Wi-Fi (`lan`) | `http://192.168.x.y:3456` | the phone is on the same network | nothing |
| Tailscale (`tailnet`) | `http://100.x.y.z:3456` | both devices are on the same tailnet and the machine is awake | Tailscale on the machine and the phone |
| Cloud (`cloud`) | `https://<your companion>` | always, including while the machine sleeps | a self-hosted cloud companion ([Cloud sync](./cloud-sync.md)) |

The server lists a Tailscale route when it finds a 100.64/10 address on a tunnel
interface (`utun*`, `tailscale*`, `wg*`). It also runs `tailscale status --json`
(3 s timeout, cached one minute) to show the MagicDNS name and whether Tailscale is
connected; when the CLI is missing the route is still offered under the generic label
"Tailnet", so Headscale and Netbird work too. Settings › Phones & Cloud shows an
install hint when no tailnet address exists.

Plain `http` is fine on the two direct routes: Wi-Fi is your own network, and
Tailscale encrypts every packet between the two devices. The app allows plain http
only to IP addresses (ATS `NSAllowsLocalNetworking`), so the server always lists the
tailnet route as an IP, never as a MagicDNS name.

## Guided setup: "Reach Walnut from anywhere"

Nobody should have to know what a tailnet is. Settings › Phones & Cloud on the machine
(never on the companion) carries a three-row card that tells the user what to do next,
and updates itself as they do it (`RemoteAccessCard.tsx`, steps derived in
`remote-access-steps.ts`, state from `GET /api/devices/tailscale`, polled every 5 s
while a step is open, every minute once all are done, never while the tab is hidden):

1. **Tailscale on this Mac.** Not installed: `Get from the App Store` (the Mac App Store
   page; one click, no password) and, when Homebrew exists, `Install with Homebrew`
   (`POST /api/devices/tailscale/install` runs `brew install --cask tailscale-app` in the
   background and shows its last log lines; the cask is a `.pkg`, so Homebrew asks sudo,
   which only works where sudo takes Touch ID; elsewhere the row says so and points back
   at the App Store). Installed but signed out: `Open Tailscale` (`POST .../open` runs
   `open -a Tailscale`) and `Sign in` when the CLI printed a login link. Connected: the
   MagicDNS name. Both POSTs answer only the console on this machine (403 for a device
   token): a phone never starts an installer on the Mac.
2. **Tailscale on your phone.** Shown once the Mac is on the tailnet: an App Store QR
   plus the iPhone and Android store links, until the CLI lists an online phone peer
   (then the row names it; a signed-in but offline phone gets its own line).
3. **Pair the phone.** Already paired: nothing to do, the phone learns the route by
   itself. Not paired: clicking the row picks the Tailscale address in the pairing
   picker below.

The phone has the mirror image in Settings › Connection, under the route list
(`TailscaleGuidance.swift`, `TailscaleGuidanceSection.swift`). It reads the `tailscale`
hint `GET /api/v1/routes` carries (`{installed, running, dnsName?}`: the Mac's own
summary, and on the companion the one the Mac sent inside its adopt reply, so a phone
that only reaches the cloud still hears about the Mac) and whether the phone itself
has a tunnel interface up (`TailnetInterface.swift`: a 100.64/10 address on `utun*`).
Three sentences, one at a time: no Tailscale route and the Mac says Tailscale is
missing or stopped, "set up Tailscale on the Mac: Walnut, Settings, Phones & Cloud";
a Tailscale route but no tunnel on the phone, "install Tailscale on this iPhone and
sign in with the same account" with a `Get Tailscale` App Store button; a tunnel up but
the route did not answer, "check Tailscale is connected here, both devices use the same
account, and the Mac is awake". Nothing while the app is talking through Tailscale,
while the Tailscale route's token was refused (the route row already says so), and
before the first probe. On the Mac's own Wi-Fi the advice is a muted footnote: it is
about later, away from home.

## One pairing, every box

`auth.json` never syncs between the machine and the companion, so each box has its
own device registry. The phone still carries one token: after it connects anywhere
it calls `GET /api/v1/routes`, and the box it reached copies the pairing's sha256
hash (never the token) into the other box's registry before listing that box's
routes. The machine does this through its own cloud credential
(`POST /api/devices/adopt`); the companion does it over the bridge
(`server.devices.adopt`). Removing or re-pairing a device on either box removes the
copy on the other one.

A phone that paired with the companion before this feature existed needs no new
QR: its first `/routes` call on a current build teaches it the direct routes.

## How the app picks a route

```
trigger: app comes to the front, network path changes, two requests fail,
         a confirmed 401 on the current route, "Check Now" in Settings
   -> probe every known route in parallel: GET <origin>/api/v1/instance, no token, 2.5 s
   -> keep the routes whose answer names the expected box
   -> prefer custom > lan > tailnet > cloud
   -> switch only to a strictly better kind, or away from a route that failed
```

`GET /api/v1/instance` is the one endpoint that answers without a token. Each route
remembers the id of the box behind it, and the app sends its token only to an
address whose answer matches. That matters for the Wi-Fi route: `192.168.1.20` in a
cafe is somebody else's machine.

A refused token on one route does not unpair the phone while another route still
takes it; the route is set aside for 30 minutes and the app moves on. Only a token
refused everywhere returns the app to setup.

Switching rebuilds the live streams (chat SSE, the task event feed) against the new
address and keeps the token and the on-device cache. Settings › Connection shows
which route is in use and the last probe of every known route.

## What the companion still adds

A direct route needs the machine awake. With only Wi-Fi and Tailscale, a sleeping
laptop means no tasks, no notes, no sessions and no push until it wakes
(`src/core/keep-awake.ts` holds it awake only while local sessions run). The
companion keeps a read mirror, cloud exec and the chat fallback available in the
meantime. Both can be paired at once; the app upgrades to a direct route whenever one
answers.

## Where the code lives

- `src/core/tailnet.ts`, `src/core/pairing-targets.ts`: route detection, the Tailscale CLI probe and the pairing targets
- `src/web/routes/instance-routes-v1.ts`, `src/web/routes/device-twins.ts`, `src/core/device-adoption.ts`, `src/core/devices/relay.ts`: the two endpoints and adoption
- `src/web/routes/devices-tailscale.ts`, `src/core/tailscale-install.ts`: the guided card's endpoints and the Homebrew install job
- `web/src/components/settings/sections/cloud/RemoteAccessCard.tsx`, `remote-access-steps.ts`: the card
- `ios-native/Walnut/Core/ServerRoute.swift`, `RouteSelector.swift`, `ios-native/Walnut/Stores/RouteCoordinator.swift`: the app side
- `ios-native/Walnut/Core/TailscaleGuidance.swift`, `TailnetInterface.swift`, `ios-native/Walnut/Views/Settings/TailscaleGuidanceSection.swift`: the phone's guidance
- Endpoint shapes: [API v1, "Instance identity and routes"](./api-v1.md)
