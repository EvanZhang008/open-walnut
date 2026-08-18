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
 *
 * 'session.control' — narrow bridge control relay (model/effort/fork/
 * model-options; same forward-to-walnut-server shape as session.launch).
 * Optional: a pre-session.control daemon answers with an unknown-command
 * error, which the cloud route maps to 400 session_control_needs_upgrade
 * (self-heals on the next primary reconnect via the normal auto-deploy).
 *
 * 'mobile-event' — reverse relay for the mobile events feed: the walnut
 * server pushes slim task/session frames DOWN to the daemon, which forwards
 * them over the bridge to the cloud box (events-v1 → phones). Optional: the
 * feed checks hasCapability before pushing, so an old daemon just means the
 * cloud feed degrades to snapshot + heartbeats until the next auto-deploy.
 *
 * 'agent-gateway' — on-host unix-socket gateway for the `wn` peer-session
 * CLI (daemon relays `gateway-request` events UP; the server answers with
 * the `gateway-result` command). Optional: on an old daemon `wn` simply
 * exits 6 (socket absent) until the next auto-deploy upgrades it.
 *
 * 'session.message' — narrow bridge message relay (phone → cloud → daemon →
 * connected walnut server, which enqueues into the DURABLE session message
 * queue — same store, delivery paths, and reconnect redelivery as web sends).
 * This is the asymmetry fix for the 2026-08-13 phone-send data-loss family:
 * the old direct marker+send/bridgeResume sequence had no queue, so a daemon
 * death between steps lost the message. Optional: on an old daemon the cloud
 * route falls back to the direct sequence (now marker-after-delivery).
 *
 * 'fs.readBounded' — narrow bridge-safe file read (path sandbox + 2MB cap,
 * both enforced HOST-SIDE by the daemon: traversal/absolute checks, realpath
 * secret-path denylist (~/.ssh, ~/.aws, key files, config.yaml, …), regular
 * files only). Lets the cloud replica serve GET /api/v1/file-content (JSON +
 * raw preview) for files on any bridged exec host — the phone HTML/text
 * preview path. NOT fs.read: a compromised cloud box must never get
 * arbitrary/unbounded reads on exec hosts. Optional: a pre-fs.readBounded
 * daemon answers with an unknown-command error, which the cloud route maps to
 * 501 not_supported_cloud (self-heals on the next primary reconnect via the
 * normal auto-deploy).
 *
 * 'changes-v1' — host-local session-changes compute (changes.compute /
 * changes.file). The daemon parses the session's JSONLs + reads file contents
 * ON ITS OWN HOST and returns a light list / one file's diff — the design-
 * principle path (host-local work belongs to the daemon; only small results
 * cross the tunnel). Binary daemons bundle the pipeline; source-deployed
 * daemons require() a sidecar (changes-core.cjs, shipped by deploySource) and
 * advertise this capability only when that load succeeds — otherwise the
 * server uses its reader-based fallback compute (old daemons likewise).
 *
 * 'external-scan-v1' — host-local discovery of sessions started OUTSIDE
 * Walnut (sessions.discoverExternal). The daemon walks its own
 * ~/.claude/projects + ~/.codex/sessions, classifies each transcript by its
 * recorded entrypoint/originator, and returns a SMALL descriptor list — the
 * host has thousands of transcript files, so neither the walk nor the parse
 * may happen server-side. Binary daemons bundle the scanner; source-deployed
 * daemons require() a sidecar (external-scan-core.cjs) and advertise this only
 * when that load succeeds. Optional: a host without it simply contributes no
 * external sessions (the importer skips it on capability) until the next
 * auto-deploy.
 */
export const ADVERTISED_DAEMON_CAPABILITIES = [
  ...REQUIRED_DAEMON_CAPABILITIES,
  'snapshot-v1',
  'image.save',
  'session.launch',
  'session.control',
  'mobile-event',
  'agent-gateway',
  'session.message',
  'changes-v1',
  'external-scan-v1',
  'fs.readBounded',
] as const

export type DaemonCapability = typeof REQUIRED_DAEMON_CAPABILITIES[number]
