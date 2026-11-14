import { defineCapability, type Entrance } from './manifest.js'

/**
 * Daemons dial in here (Walnut Connect): each host's daemon keeps an outbound
 * socket on /bridge, so the box reaches it with no SSH and while the Mac sleeps.
 * What a bridge socket may ask a daemon is the daemon's own allowlist
 * (BRIDGE_ALLOWED_COMMANDS in the daemon twins), never the full command set.
 * The Mac also writes this box's copies over HTTPS (/bridge/*), which take only its
 * own machine token, and backs its data up to /git/data, which takes a device token
 * (any paired device's, a phone's too) and refuses machine tokens.
 */

/** The Mac's own HTTP writes to this box: one gate (bridge-ingest.ts authenticate) for all. */
const MAC_WRITE = "only the paired Mac's own machine token (bridge-local, which can never be status-only: machine-credentials.ts refuses that), checked before the body is read; a device token or another machine's token gets 403, failures are rate limited per address"
const macWrite = (path: string, verifiedIn: string): Entrance => ({ path, opensWith: MAC_WRITE, verifiedIn, check: 'authenticate(req, res, next)' })

export const bridgeDoor = defineCapability({
  name: 'bridge-door',
  summary: 'Daemons dial in on /bridge, the Mac reaches its daemon on this box, and the Mac writes its copies and backs its data up here.',
  companionDefault: true,
  jobs: ['companion-ingest-routes', 'git-maintenance'],
  doors: [
    {
      path: '/bridge',
      opensWith: 'a machine token minted for that host (an older daemon may still send it as ?token=; a status-only token gets a link that may push no events and no large frames: one that does is cut off), or a feature node token (fn.) in a header or subprotocol only; a device token or an API key is refused, failures are rate limited per address, and a revoked token closes its socket',
      verifiedIn: 'src/web/ws/handler.ts',
      check: "cred.kind !== 'machine'",
    },
    {
      path: '/daemon-tunnel',
      opensWith: "only the paired Mac's own machine token (bridge-local) with more than status-only scope, and only while this box has cloud-exec and the user's cloud.exec.enabled is on; a device token, an API key or another host's token is refused. A probe request learns only whether a machine token is valid (204) and opens nothing",
      verifiedIn: 'src/web/ws/daemon-tunnel.ts',
      check: "cred.kind !== 'machine' || cred.name !== PRIMARY_MACHINE_DEVICE || cred.bridgeScope === 'status-only'",
    },
    {
      path: '/bridge/session-stream',
      opensWith: "only the paired Mac's own machine token (bridge-local) with more than status-only scope; it reads one session and can never write to it",
      verifiedIn: 'src/web/ws/bridge-session-stream.ts',
      check: "cred.kind !== 'machine' || cred.name !== 'bridge-local' || cred.bridgeScope === 'status-only'",
    },
  ],
  routes: [
    {
      path: '/git/data',
      opensWith: "git over HTTPS for the Mac's data backup: any paired device's token (a phone's too) or an API key as the Basic or Bearer credential, with read and write on the whole data hub; a machine token is refused, failures are rate limited per address",
      verifiedIn: 'src/web/routes/git-http.ts',
      check: "!cred || cred.kind === 'machine'",
    },
    { ...macWrite('/bridge/ingest', 'src/web/routes/bridge-ingest.ts'), check: "cred.kind !== 'machine' || cred.name !== PRIMARY_MACHINE_DEVICE" },
    macWrite('/bridge/send', 'src/web/routes/bridge-send.ts'),
    macWrite('/bridge/replica', 'src/web/routes/bridge-replica.ts'),
    macWrite('/bridge/journal', 'src/web/routes/bridge-journal.ts'),
    macWrite('/bridge/host-replica', 'src/web/routes/bridge-host-replica.ts'),
    macWrite('/bridge/build', 'src/web/routes/bridge-build.ts'),
  ],
  reads: [
    'src/integrations/git-maintenance.ts',
    'src/web/routes/api-v1.ts',
    'src/web/routes/devices.ts',
    'src/web/routes/hosts.ts',
  ],
})
