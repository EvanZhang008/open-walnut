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
  'fs.mkdir',
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
  'stt',
  // ACP worker command family (in-process ACP host worker per session; MVP =
  // local Mac daemon only — daemon-source answers these with a structured
  // acp_unsupported error until the remote deploy phase lands).
  'acpStart',
  'acpSend',
  'acpCancel',
  'acpRespond',
  'acpSetConfigOption',
  'acpState',
  'acpNewSession',
  'acpStop',
  'acpSubscribe',
] as const

/**
 * Full capability list a CURRENT daemon advertises on `hello`. Superset of
 * REQUIRED_DAEMON_CAPABILITIES: optional capabilities live ONLY here so that
 * old daemons (which don't advertise them) stay usable — the server gates the
 * corresponding feature on presence instead of forcing a redeploy.
 *
 * 'snapshot-v1' — C1 session-snapshot push/pull (docs/plan/
 * session-snapshot-source-of-truth.md §4). Walnut treats hosts without it as
 * legacy: no snapshot flow, old status writers stay authoritative. Do NOT
 * move it into REQUIRED until the C4 soak completes.
 *
 * 'image.save' — narrow bridge-safe image save (phone → cloud → daemon).
 * Optional: a pre-image.save daemon answers with an unknown-command error,
 * which the cloud route maps to 400 images_need_daemon_upgrade (self-heals
 * on the next Mac reconnect via the normal auto-deploy).
 *
 * 'session.launch' — narrow bridge launch relay (phone → cloud → daemon →
 * connected walnut server, which runs the full quick-start chain). Optional:
 * a pre-session.launch daemon answers with an unknown-command error, which
 * the cloud route maps to 400 session_launch_needs_upgrade (self-heals on
 * the next primary reconnect via the normal auto-deploy).
 */
export const ADVERTISED_DAEMON_CAPABILITIES = [
  ...REQUIRED_DAEMON_CAPABILITIES,
  'snapshot-v1',
  'image.save',
  'session.launch',
] as const

export type DaemonCapability = typeof REQUIRED_DAEMON_CAPABILITIES[number]
