/**
 * Bridge log line parsers for the three writers:
 *
 *  daemon   JSON lines {ts, level, msg, ...fields} in daemon-d-*.log. Today's
 *           builds log "bridge: connected / disconnected / inbound silence /
 *           starting / dial timeout / configured"; newer builds add one
 *           structured record per connection: bridge-conn-open {connId,
 *           dialMs} and bridge-conn-close {connId, uptimeMs, code, ...}.
 *  server   the local Walnut server's JSON log {time, level, subsystem,
 *           message, ...}; only the SSH-tunnel lines matter here (did the
 *           Mac's other links die at the same moment?).
 *  replica  the cloud box's server log, same JSON shape, or the TSV cut the
 *           investigation used (ts, hostAlias, msg, reason, silentMs).
 *
 * Messages are matched by prefix so the punctuation inside them (the logs
 * use a dash character between clauses) never matters.
 */

// [pattern, ev, the message text stored for it]
const DAEMON_KINDS = [
  [/^bridge: connected\b/, 'connected', 'bridge: connected'],
  [/^bridge: disconnected\b/, 'closed', 'bridge: disconnected'],
  [/^bridge: inbound silence\b/, 'silence', 'bridge: inbound silence'],
  [/^bridge: starting\b/, 'restart', 'bridge: starting'],
  [/^bridge: dial timeout\b/, 'dial-timeout', 'bridge: dial timeout'],
  [/^bridge: dial failed\b/, 'dial-failed', 'bridge: dial failed'],
  [/^bridge: invalid url\b/, 'disabled', 'bridge: invalid url'],
  [/^bridge: configured\b/, 'configured', 'bridge: configured'],
  [/^bridge[-: ]conn[-_ ]?open\b/, 'conn-open', 'bridge-conn-open'],
  [/^bridge[-: ]conn[-_ ]?close\b/, 'conn-close', 'bridge-conn-close'],
]

/**
 * The only fields copied from a daemon line: what the classifier reads (the
 * close record, the dial time, the silence). An allowlist, so a field a newer
 * daemon adds (a session id, a working directory, a host alias, a URL, a
 * token) is never recorded until the monitor is changed to use it.
 */
export const DAEMON_FIELDS = Object.freeze([
  'connId', 'dialMs', 'silentMs', 'limitMs', 'uptimeMs', 'code', 'reason', 'wasClean', 'lastError', 'bytesIn', 'bytesOut',
  'framesIn', 'framesOut', 'maxOutFrameBytes', 'maxOutFrameKind', 'bufferedAmountPeak', 'bufferedAmountAtClose',
  'lastInboundAgeMs', 'rttMsP50', 'rttMsMax', 'loopDriftMax60sMs', 'loopDriftMax5sMs',
])
/** The same for a replica JSON line: what the replica join reads. */
export const REPLICA_FIELDS = Object.freeze(['reason', 'silentMs', 'initiator'])
/** What the parser itself sets, plus what the collector adds (kind, file). */
export const DAEMON_RECORD_KEYS = Object.freeze(['t', 'ev', 'msg', 'level', 'kind', 'file', ...DAEMON_FIELDS])

function pickFields(obj, allowed) {
  const out = {}
  for (const k of allowed) {
    const v = obj[k]
    if (v === undefined || (v !== null && typeof v === 'object')) continue
    out[k] = v
  }
  return out
}

/**
 * The message text kept with a record. Never the daemon's own text, which
 * may carry an address, a path, a URL or an id after its first words: a known
 * message is stored as its fixed name, any other as its first word only
 * ("bridgeResume"), a log family name and never data.
 */
export function daemonMsg(ev, msg) {
  const known = DAEMON_KINDS.find(([, kind]) => kind === ev)
  if (known) return known[2]
  return /^[A-Za-z][A-Za-z-]*/.exec(String(msg ?? ''))?.[0] ?? ''
}

/**
 * A server log names SSH hosts by the user's own aliases. The classifier only
 * asks "the Mac's own daemon, or a remote host?", so that is all that is kept.
 */
export function hostKind(host) {
  if (host == null) return null
  return host === '__local__' ? '__local__' : 'remote'
}

function parseJson(line) {
  const s = line.trim()
  if (!s.startsWith('{')) return null
  try { return JSON.parse(s) } catch { return null }
}

/** One daemon log line -> {t, ev, msg, ...fields} or null. */
export function parseDaemonLine(line) {
  if (!line.includes('"bridge')) return null
  const o = parseJson(line)
  if (!o || typeof o.msg !== 'string' || typeof o.ts !== 'string') return null
  const hit = DAEMON_KINDS.find(([re]) => re.test(o.msg))
  if (!hit && !o.msg.startsWith('bridge')) return null
  return { ...pickFields(o, DAEMON_FIELDS), t: o.ts, ev: hit ? hit[1] : 'other', msg: daemonMsg(hit ? hit[1] : 'other', o.msg), level: typeof o.level === 'string' ? o.level : null }
}

const SERVER_MESSAGES = [
  [/^DaemonConnection: WebSocket closed/, 'ssh-ws-closed'],
  [/^DaemonConnection: connection lost/, 'ssh-lost'],
  [/^DaemonConnection: SSH tunnel died/, 'ssh-died'],
  [/^DaemonConnection: SSH tunnel created/, 'ssh-up'],
  [/^DaemonConnection: reconnect failed/, 'ssh-reconnect-failed'],
  [/^DaemonConnection: bridge enabled but NOT connected/, 'bridge-not-connected'],
]

/** One local server log line -> {t, ev, host: '__local__' | 'remote' | null} or null. */
export function parseServerLine(line) {
  if (!line.includes('DaemonConnection: ')) return null
  const o = parseJson(line)
  if (!o || typeof o.message !== 'string' || typeof o.time !== 'string') return null
  const hit = SERVER_MESSAGES.find(([re]) => re.test(o.message))
  if (!hit) return null
  return { t: o.time, ev: hit[1], host: typeof o.host === 'string' ? hostKind(o.host) : null }
}

const REPLICA_KINDS = [
  [/^bridge: host connected/, 'connected'],
  [/^bridge: host disconnected/, 'disconnected'],
  [/^bridge: host silent/, 'silent'],
  [/^bridge: replacing existing connection/, 'replaced'],
  [/^bridge:? host closed/, 'closed'],
]

function replicaKind(msg) {
  return REPLICA_KINDS.find(([re]) => re.test(msg))?.[1] ?? null
}

/** Replica timestamps without a zone are UTC (the box logs in UTC). */
function utcIso(ts) {
  const s = String(ts).trim()
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`
  const ms = Date.parse(withZone)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/** One replica log line (JSON or TSV) -> {t, kind, alias, reason, ...} or null. */
export function parseReplicaLine(line) {
  if (!line.includes('bridge')) return null
  const o = parseJson(line)
  if (o) {
    const msg = typeof o.message === 'string' ? o.message : o.msg
    if (typeof msg !== 'string') return null
    const kind = replicaKind(msg)
    const t = utcIso(o.time ?? o.ts)
    if (!kind || !t) return null
    return { ...pickFields(o, REPLICA_FIELDS), t, kind, alias: o.hostAlias ?? null }
  }
  const p = line.replace(/\r$/, '').split('\t')
  if (p.length < 3) return null
  const kind = replicaKind(p[2])
  const t = utcIso(p[0])
  if (!kind || !t) return null
  const rec = { t, kind, alias: p[1] || null }
  if (p[3]) rec.reason = p[3]
  if (p[4] && /^\d+$/.test(p[4])) rec.silentMs = Number(p[4])
  return rec
}
