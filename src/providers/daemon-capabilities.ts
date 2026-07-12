/**
 * Canonical list of WebSocket commands a remote daemon MUST implement to be
 * protocol-compatible with the current server. The daemon returns this list
 * from `hello`; the server checks it after connecting. Any missing capability
 * forces a redeploy.
 *
 * This is the final safety net under version-hash checks: even if the version
 * string somehow matches but the binary is stale/corrupted/hand-swapped, a
 * capability gap will catch it before the first broken `sendRaw` hangs a
 * permission prompt for 30 minutes.
 *
 * Hand-maintained (not derived from the daemon's switch statement) because
 * daemon-standalone is a bun-compiled binary and daemon-source is an embedded
 * string template evaluated on the remote host — neither can introspect its
 * own switch at distribution time.
 *
 * When you add a new `case 'foo':` to daemon-standalone.ts / daemon-source.ts,
 * add 'foo' here too. Forgetting to add it here only costs you one extra
 * redeploy, not a silent hang.
 */
export const REQUIRED_DAEMON_CAPABILITIES = [
  'start',
  'attach',
  'send',
  'sendRaw',
  'stop',
  'status',
  'getState',
  'rename',
  'read-history',
  'subscribe-agent',
  'unsubscribe-agent',
  'write-inbox',
  'fs.read',
  'fs.write',
  'fs.ls',
  'fs.find',
  'fs.stat',
  'fs.readRange',
  'git.diff',
  'list',
  'ping',
  'hello',
  'setMode',
  'appendUserMarker',
  'bridge.configure',
  'bridgeResume',
] as const

export type DaemonCapability = typeof REQUIRED_DAEMON_CAPABILITIES[number]
