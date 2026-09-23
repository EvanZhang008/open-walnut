/**
 * Preparing a `web --ephemeral` snapshot so it can never act as the real Walnut.
 *
 * The snapshot is a copy of the user's data dir, automations included. Left as
 * copied, the test server's cron engine ran the user's real jobs a second time
 * (a Slack monitor, a daily digest, pipeline watches on shared hosts), and the
 * sessions those jobs started reached out to real services. Jobs the tester
 * creates inside the snapshot still run: cron and trigger features stay testable.
 * The same copy carries the phone's push tokens, so a test turn that finished
 * with no browser attached sent a notification to the user's real phone.
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/** Cron store file name inside a data dir (CRON_FILE in constants.ts). */
const CRON_STORE_FILE = 'cron-jobs.json'

/**
 * Disable every enabled job in the snapshot's cron store. Returns how many were
 * paused. A missing or unreadable store pauses nothing and never throws: the
 * launcher must still start, and a store the cron engine cannot parse is one it
 * will not run either.
 */
export function pauseSnapshotCronJobs(snapshotDir: string): number {
  const file = path.join(snapshotDir, CRON_STORE_FILE)
  let store: { jobs?: unknown }
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return 0
  }
  if (!store || typeof store !== 'object' || !Array.isArray(store.jobs)) return 0
  let paused = 0
  for (const job of store.jobs as Array<Record<string, unknown>>) {
    if (job && typeof job === 'object' && job.enabled !== false) {
      job.enabled = false
      paused++
    }
  }
  if (paused === 0) return 0
  try {
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
    fs.renameSync(tmp, file)
  } catch {
    // Could not rewrite the copy: fail closed by removing it, so the test
    // server starts with no jobs rather than with the user's live ones.
    try { fs.rmSync(file, { force: true }) } catch { /* best-effort */ }
  }
  return paused
}

/**
 * Config files the server reads: config.yaml, and config.yaml.bak, which
 * config-manager restores from when config.yaml is missing or unreadable.
 */
const CONFIG_FILES = ['config.yaml', 'config.yaml.bak']

/**
 * Drop `push_tokens` from the snapshot's config files. Returns how many tokens
 * were removed. Every push sender reads its devices from that list, so an
 * empty list means the test server has no phone to notify. A file that holds
 * tokens but cannot be parsed or rewritten is removed (fail closed): the server
 * then starts on its defaults rather than with the user's devices.
 */
export function stripSnapshotPushTokens(snapshotDir: string): number {
  let removed = 0
  for (const name of CONFIG_FILES) {
    const file = path.join(snapshotDir, name)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    if (!raw.includes('push_tokens')) continue
    try {
      const doc = yaml.load(raw) as Record<string, unknown> | null
      if (!doc || typeof doc !== 'object' || !('push_tokens' in doc)) continue
      const tokens = doc.push_tokens
      delete doc.push_tokens
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, yaml.dump(doc, { indent: 2, lineWidth: 120 }))
      fs.renameSync(tmp, file)
      removed += Array.isArray(tokens) ? tokens.length : 0
    } catch {
      try { fs.rmSync(file, { force: true }) } catch { /* best-effort */ }
    }
  }
  return removed
}

/**
 * Environment for the ephemeral child. It gets its own data dir and its own
 * runtime (daemon) dir; every variable that could point it, its daemon, or its
 * sessions back at the launching Walnut is dropped. The launcher usually runs
 * inside a session of the REAL Walnut, whose env carries that session's agent
 * socket, session id and API URL.
 */
export function ephemeralChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  snapshotDir: string,
  runtimeDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv, OPEN_WALNUT_HOME: snapshotDir, WALNUT_DAEMON_DIR: runtimeDir }
  for (const key of [
    'WALNUT_STREAMS_DIR',
    'WALNUT_LEGACY_STREAMS_DIR',
    'WALNUT_FORCE_STREAMS_MIGRATION',
    'WALNUT_DAEMON_PARENT_PID',
    'WALNUT_AGENT_SOCKET',
    'WALNUT_SESSION_ID',
    'OPEN_WALNUT_API_URL',
    'WALNUT_SERVER_URL',
  ]) delete env[key]
  return env
}
