import { defineCapability } from './manifest.js'

/**
 * The box has a public address (on the companion, Caddy on 443 in front of it,
 * scripts/cloud/setup.sh): phones pair and reach it from anywhere, push, voice
 * and the revoke queue answer there. Its /api routes take the device-token check
 * every /api route takes (web/middleware/auth.ts); the routes below are the ones
 * that check something else, an invite code or the box's own relay.
 */
export const publicDoor = defineCapability({
  name: 'public-door',
  summary: 'Phones pair here and reach it from the internet: invites, revokes, voice and the tunnel in front of the box.',
  companionDefault: true,
  jobs: ['host-network-door', 'setup-token-banner', 'revoke-queue', 'expose-runtime', 'stt-auto-setup'],
  doors: [],
  routes: [
    {
      path: '/join/:code',
      opensWith: 'anyone holding a live invite code: the code in the path is the credential (made by the owner Mac, one use, ten minutes); wrong codes are rate limited per address; it answers only the install script',
      verifiedIn: 'src/web/routes/net-v1.ts',
      check: 'if (!peekInvite(code))',
    },
    {
      path: '/join/:code/windows',
      opensWith: 'the same invite code as /join/:code, for the PowerShell script',
      verifiedIn: 'src/web/routes/net-v1.ts',
      check: 'if (!peekInvite(code))',
    },
    {
      path: '/api/v1/net/join',
      opensWith: 'a new machine with a live invite code in the body (the same code as the link); wrong codes are rate limited per address',
      verifiedIn: 'src/web/routes/net-v1.ts',
      check: 'if (!peekInvite(body.code))',
    },
    {
      path: '/__walnut/tunnel-probe',
      opensWith: "anyone who reaches the tunnel address (the tunnel port listens on 127.0.0.1, its client carries the public address in): it answers only 'ok' and this run's probe token, a random value that tells which listener holds the address and opens nothing else; every other request on that port goes to the app with its usual checks, and local-trust.ts never trusts that port",
      verifiedIn: 'src/core/expose/probe.ts',
      check: "if ((req.url ?? '').split('?')[0] !== TUNNEL_PROBE_PATH) return false",
    },
    {
      path: '/api/v1/net/relay-access',
      opensWith: "only this box's own relay: a request from this machine, not carried in by Caddy, with the relay's token file",
      verifiedIn: 'src/web/routes/net-v1.ts',
      check: '!isLocalOrigin(requestOrigin(req)) || !relayTokenOk(req)',
    },
  ],
  reads: [
    'src/core/devices/revoke-queue.ts',
    'src/core/push/device-revoke.ts',
    'src/core/stt/voice-archive-replication.ts',
    'src/core/stt/voice-archive-transcribe.ts',
    'src/core/stt/voice-archive.ts',
    'src/web/routes/devices.ts',
    'web/src/components/settings/sections/cloud/PhonesCloudTabs.tsx',
  ],
})
