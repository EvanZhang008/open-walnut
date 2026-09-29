/**
 * Bridge monitor configuration: where things live and the knobs.
 *
 * Everything host-specific (the cloud URL, a probe token path, a replica log
 * export) lives in ONE local file outside the repo:
 *   ~/Library/Application Support/Walnut/bridge-monitor.json
 * The repo only ships neutral defaults. Storage is deliberately NOT /tmp (a
 * reboot wipes it) and NOT the Walnut data dir (it git-syncs to the cloud box).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME = os.homedir()
export const SUPPORT_DIR = path.join(HOME, 'Library', 'Application Support', 'Walnut')
export const CONFIG_FILE = path.join(SUPPORT_DIR, 'bridge-monitor.json')

export const DEFAULTS = Object.freeze({
  logDir: path.join(HOME, 'Library', 'Logs', 'Walnut', 'bridge-monitor'),
  stateDir: path.join(SUPPORT_DIR, 'bridge-monitor', 'state'),
  retentionDays: 14,
  /** Where the local daemon writes daemon-d-*.log and bridge.json. */
  daemonLogDir: '/tmp/open-walnut',
  /** Where the local server writes open-walnut-<date>.log. */
  serverLogDir: '/tmp/open-walnut',
  /** Only used for DNS + egress-route sampling; read from bridge.json when null. */
  bridgeUrl: null,
  /** Wi-Fi interface; auto-detected from `networksetup -listallhardwareports` when null. */
  wifiInterface: null,
  netEverySec: 10,
  loadEverySec: 60,
  publicIp: { url: 'https://api.ipify.org', everyMin: 5, timeoutMs: 5000 },
  wifiRadioEveryMin: 5,
  tcp: { everyMin: 15, windowMin: 20, maxWindowMin: 360, processNames: ['daemon-darwin'], retryMin: 5 },
  /**
   * When to skip the heavy samples (kernel log sweep, pmset log) and retry
   * later: memory pressure at this level or worse, or (only when set) every
   * slot of a machine-wide heavy-job semaphore held ({base, count}). The
   * semaphore gate is off by default on purpose: a busy machine is exactly
   * when the bridge flaps, and the kernel log only holds those sockets for
   * about 2 hours, so skipping then throws away the evidence most needed.
   */
  heavy: { busySlots: null, maxPressureLevel: 4 },
  daily: { sntpServer: 'time.apple.com', pmsetLookbackHours: 26 },
  /** First run only: how far back to backfill daemon logs (they die at reboot). */
  backfillHours: 48,
  inbox: { api: 'http://127.0.0.1:3456', enabled: true, retryHours: 12 },
  alert: {
    enabled: true,
    maxDropsPer10Min: 3,
    outageSec: 60,
    cooldownMin: 30,
    maxPerDay: 6,
    /** Outages that overlap a Mac sleep are expected; alert on them only when true. */
    includeSleep: false,
  },
  summary: { days: 7 },
  /** Optional dir of replica log exports (server JSON logs or the TSV cut). */
  replicaLogDir: null,
  probe: {
    enabled: false,
    url: null,
    tokenFile: null,
    hostAlias: 'probe',
    pingEveryMs: 30_000,
    payloadEveryMs: 30_000,
    payloadBytes: 64 * 1024,
    burstEveryMs: 15 * 60_000,
    burstBytes: 2 * 1024 * 1024,
    /** Seconds into the 5-minute cycle; 'auto' = the summarizer's M1 phase + 150 s. */
    burstPhaseSec: 'auto',
    silenceMs: 75_000,
    dialTimeoutMs: 20_000,
    backoffMaxMs: 60_000,
    tokenInQuery: true,
  },
})

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Deep merge: objects merge key by key, everything else replaces. */
export function mergeConfig(base, over) {
  if (!isPlainObject(over)) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? mergeConfig(base[k], v) : v
  }
  return out
}

function expandHome(p) {
  if (typeof p !== 'string') return p
  return p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p
}

/**
 * Load the effective config. A missing or unreadable file yields the
 * defaults (the monitor must never crash-loop on a bad config); the parse
 * error is returned so the caller can record it.
 */
export function loadConfig(file = process.env.BRIDGE_MONITOR_CONFIG || CONFIG_FILE) {
  let local = {}
  let error = null
  try {
    local = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    if (err && err.code !== 'ENOENT') error = String(err.message || err)
  }
  const cfg = mergeConfig(DEFAULTS, local)
  for (const key of ['logDir', 'stateDir', 'daemonLogDir', 'serverLogDir', 'replicaLogDir']) {
    cfg[key] = expandHome(cfg[key])
  }
  cfg.probe = { ...cfg.probe, tokenFile: expandHome(cfg.probe.tokenFile) }
  if (process.env.BRIDGE_MONITOR_LOG_DIR) cfg.logDir = process.env.BRIDGE_MONITOR_LOG_DIR
  if (process.env.BRIDGE_MONITOR_STATE_DIR) cfg.stateDir = process.env.BRIDGE_MONITOR_STATE_DIR
  return { cfg, error, file }
}

/**
 * The bridge URL the daemon dials, read from the daemon's bridge.json. Only
 * the URL is returned: the token in that file is never read into a record.
 */
export function readDaemonBridgeUrl(daemonLogDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(daemonLogDir, 'bridge.json'), 'utf-8'))
    return typeof raw?.url === 'string' && raw.url ? raw.url : null
  } catch {
    return null
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}
