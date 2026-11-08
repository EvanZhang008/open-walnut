/**
 * The writes of found hosts (rules in found-hosts.ts):
 *
 *   settleFoundHosts   at server start, before anything dials: every found host
 *                      an older Walnut left with no answer is decided from what
 *                      Walnut recorded (never flipping a host someone uses), and
 *                      on the first start a found host in use that config.yaml
 *                      did not hold yet is written as a yes. Then the server asks
 *                      (`hosts_found.asking_since`): a host found later waits.
 *   answerFoundHost    the person's Connect or Not now (Remote Hosts, Runs on).
 *
 * A fact that cannot be read stops the decision for this start: the rows stay as
 * the older Walnut read them until the next start, rather than a used host going quiet.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { CRON_FILE, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { DiscoveredHost } from '../ssh-config-scanner.js'
import {
  addFoundTarget, decideFoundHost, foundTargetTaken, isFoundHostAnswer, knownFoundTargets, recordScanIfSame, withFoundHostAnswer,
  type FoundHostAnswer, type FoundHostFacts, type FoundHostReason, type FoundHostRow,
} from './found-hosts.js'

export interface FoundHostDecision {
  alias: string
  answer: FoundHostAnswer
  reason: FoundHostReason
  /** The row was only in memory (merged from ~/.ssh/config) and is now written. */
  added?: boolean
}

export interface SettleFoundHostsDeps {
  readFacts: () => Promise<FoundHostFacts>
  scan: () => Promise<ReadonlyMap<string, DiscoveredHost>>
  /** Read-modify-write the stored config mapping; `mutate` returns whether it changed it. */
  modify: (mutate: (doc: Record<string, unknown>) => boolean) => Promise<boolean>
  reserved?: ReadonlySet<string>
  now?: () => Date
}

type Doc = Record<string, unknown>
type Rows = Record<string, FoundHostRow>

function rowsOf(doc: Doc): Rows {
  const hosts = doc.hosts
  return hosts && typeof hosts === 'object' && !Array.isArray(hosts) ? hosts as Rows : {}
}

/** Decide the stored found hosts with no answer; on the first start also write the used found hosts kept only in memory. */
export function settleFoundHostsDoc(
  doc: Doc,
  ctx: { facts: FoundHostFacts; scanned: ReadonlyMap<string, DiscoveredHost>; reserved?: ReadonlySet<string>; now: Date },
): FoundHostDecision[] {
  const decided: FoundHostDecision[] = []
  const rows: Rows = { ...rowsOf(doc) }
  const runOn = (doc.expose as { run_on?: unknown } | undefined)?.run_on
  let recorded = false
  for (const [alias, row] of Object.entries(rows)) {
    if (!row || typeof row !== 'object' || row.discovered !== true) continue
    if (isFoundHostAnswer(row.connect)) {
      // A row answered before the scan record existed: from now on it follows ~/.ssh/config
      // when its values still equal it (a value that differs may be the person's edit).
      const next = recordScanIfSame(row, ctx.scanned.get(alias))
      if (next !== row) { rows[alias] = next; recorded = true }
      continue
    }
    const d = decideFoundHost(alias, row, { facts: ctx.facts, runOn, scanned: ctx.scanned.get(alias), persisted: true })
    rows[alias] = withFoundHostAnswer(row, d.answer, 'walnut', ctx.scanned.get(alias))
    decided.push({ alias, ...d })
  }
  const marker = doc.hosts_found as { asking_since?: unknown } | undefined
  const firstStart = !(typeof marker?.asking_since === 'string' && marker.asking_since)
  if (firstStart) {
    // Found hosts an older Walnut kept only in memory, merged on: one in use is kept a yes.
    const known = knownFoundTargets(Object.values(rows))
    for (const [alias, host] of ctx.scanned) {
      if (ctx.reserved?.has(alias) || rows[alias] || foundTargetTaken(known, host)) continue
      const row: FoundHostRow = {
        hostname: host.hostname,
        ...(host.user ? { user: host.user } : {}),
        ...(host.port ? { port: host.port } : {}),
        ...(host.label ? { label: host.label } : {}),
        discovered: true,
      }
      const d = decideFoundHost(alias, row, { facts: ctx.facts, runOn, scanned: host, persisted: false })
      if (d.answer !== 'yes') continue
      rows[alias] = withFoundHostAnswer(row, 'yes', 'walnut', host)
      addFoundTarget(known, host.hostname, host.port, host.user)
      decided.push({ alias, ...d, added: true })
    }
    doc.hosts_found = { ...(marker && typeof marker === 'object' ? marker : {}), asking_since: ctx.now.toISOString() }
  }
  if (decided.length > 0 || recorded) doc.hosts = rows
  return decided
}

/** Decide the found hosts once per start. Returns what it decided (empty when nothing was left to decide). */
export async function settleFoundHosts(depsArg?: Partial<SettleFoundHostsDeps>): Promise<FoundHostDecision[]> {
  const deps = { ...(await defaultDeps()), ...depsArg }
  let facts: FoundHostFacts
  let scanned: ReadonlyMap<string, DiscoveredHost>
  try {
    ;[facts, scanned] = await Promise.all([deps.readFacts(), deps.scan()])
  } catch (err) {
    log.session.warn('found hosts: could not read what Walnut recorded; deciding at the next start', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
  let decided: FoundHostDecision[] = []
  await deps.modify((doc) => {
    const before = JSON.stringify([doc.hosts, doc.hosts_found])
    decided = settleFoundHostsDoc(doc, { facts, scanned, reserved: deps.reserved, now: (deps.now ?? (() => new Date()))() })
    return JSON.stringify([doc.hosts, doc.hosts_found]) !== before
  })
  if (decided.length > 0) log.session.info('found hosts: decided the hosts an older Walnut left', { decided })
  return decided
}

async function defaultDeps(): Promise<SettleFoundHostsDeps> {
  const [{ migrateStoredConfig }, { scanSshConfig }, { realSshReachAllowed }, { COMPANION_ALIAS }] = await Promise.all([
    import('../config-manager.js'), import('../ssh-config-scanner.js'), import('../../lib/real-ssh-guard.js'), import('../replication/companion-keep.js'),
  ])
  return {
    readFacts: readFoundHostFacts,
    scan: async () => (realSshReachAllowed() ? scanSshConfig() : new Map()),
    modify: (mutate) => migrateStoredConfig(mutate),
    reserved: new Set([COMPANION_ALIAS]),
  }
}

/** Should this process decide found hosts? Only the leader, the server that owns config.yaml. */
export async function settlesFoundHosts(): Promise<boolean> {
  return !(await import('../server-role.js')).isFollower()
}

/** What Walnut recorded about hosts. Throws when a store cannot be read (the caller then decides nothing). */
export async function readFoundHostFacts(): Promise<FoundHostFacts> {
  const [{ listSessions }, { listTasks, getStoreProjects }] = await Promise.all([
    import('../session-tracker.js'), import('../task-manager.js'),
  ])
  const sessionHosts = new Set<string>()
  for (const s of await listSessions()) if (s.host) sessionHosts.add(s.host)
  const taskHosts = new Set<string>()
  for (const t of await listTasks()) {
    if (t.last_start?.host) taskHosts.add(t.last_start.host)
    if (t.transfer?.stage?.host) taskHosts.add(t.transfer.stage.host)
  }
  for (const p of Object.values(await getStoreProjects())) {
    const h = (p.metadata as { default_host?: unknown } | undefined)?.default_host
    if (typeof h === 'string' && h) taskHosts.add(h)
  }
  for (const h of await routineHosts()) taskHosts.add(h)
  return { sessionHosts, taskHosts, connectedHosts: await probedHosts(), serverHosts: await serverHosts() }
}

/**
 * Hosts a routine names (its check's host, its launch's host, a clock's host), read from the
 * stored jobs as data: a routine set on a host that has not fired yet still uses that host.
 */
async function routineHosts(): Promise<Set<string>> {
  let raw: unknown
  try { raw = JSON.parse(await fs.readFile(CRON_FILE, 'utf8')) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw err
  }
  const jobs = Array.isArray(raw) ? raw : (raw as { jobs?: unknown } | null)?.jobs
  const out = new Set<string>()
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || !value || typeof value !== 'object') return
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'host' && typeof inner === 'string' && inner && inner !== '__local__') out.add(inner)
      else walk(inner, depth + 1)
    }
  }
  if (Array.isArray(jobs)) for (const job of jobs) walk(job, 0)
  return out
}

/** Hosts with a probed profile (core/hosts/host-profile.ts): their daemon answered at least once. */
async function probedHosts(): Promise<Set<string>> {
  const { HOST_PROFILES_DIR } = await import('./host-profile.js')
  const out = new Set<string>()
  let names: string[]
  try { names = await fs.readdir(HOST_PROFILES_DIR) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out
    throw err
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(await fs.readFile(path.join(HOST_PROFILES_DIR, name), 'utf8')) as { probed?: unknown }
      if (raw?.probed) out.add(name.slice(0, -'.json'.length))
    } catch { /* a broken profile says nothing either way */ }
  }
  return out
}

/** Hosts with a Walnut server record (core/host-server/index.ts `stateFile`). */
async function serverHosts(): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'host-servers.json'), 'utf8')) as unknown
    return new Set(raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : [])
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw err
  }
}

export type AnswerFoundHostResult =
  | { ok: true; host: string; answer: 'yes' | 'not_now' }
  | { ok: false; status: number; error: string; code: string }

/**
 * The person's answer to "Connect to it?" on one found host, written to config.yaml
 * (a row kept only in memory is written whole). The caller dials it after a yes.
 */
export async function answerFoundHost(host: string, answer: unknown): Promise<AnswerFoundHostResult> {
  if (answer !== 'yes' && answer !== 'not_now') return { ok: false, status: 400, error: 'answer is "yes" or "not_now"', code: 'bad_answer' }
  if ((await import('../server-role.js')).isFollower()) return { ok: false, status: 409, error: 'Answer this on the computer that keeps the hosts.', code: 'not_here' }
  const [{ getConfig, migrateStoredConfig }, { scanSshConfig }, { realSshReachAllowed }] = await Promise.all([
    import('../config-manager.js'), import('../ssh-config-scanner.js'), import('../../lib/real-ssh-guard.js'),
  ])
  const hosts = (await getConfig()).hosts ?? {}
  const def = Object.hasOwn(hosts, host) ? hosts[host] as FoundHostRow | undefined : undefined
  if (!def) return { ok: false, status: 404, error: `Unknown host: ${host}`, code: 'unknown_host' }
  if (def.discovered !== true) return { ok: false, status: 409, error: `${host} was added by hand, not found in ~/.ssh/config.`, code: 'not_found_host' }
  // What ~/.ssh/config says now: the written row records it and keeps following it.
  const scan = realSshReachAllowed() ? (await scanSshConfig().catch(() => new Map<string, DiscoveredHost>())).get(host) : undefined
  await migrateStoredConfig((doc) => {
    const rows: Rows = { ...rowsOf(doc) }
    const stored = rows[host]
    const base: FoundHostRow = stored && typeof stored === 'object' ? stored : {
      hostname: def.hostname,
      ...(def.user ? { user: def.user } : {}),
      ...(def.port ? { port: def.port } : {}),
      ...(def.label ? { label: def.label } : {}),
      ...(def.scanned !== undefined ? { scanned: def.scanned } : {}),
    }
    const next = withFoundHostAnswer(base, answer, 'person', scan)
    if (JSON.stringify(next) === JSON.stringify(stored)) return false
    rows[host] = next
    doc.hosts = rows
    return true
  })
  log.session.info('found host answered', { host, answer })
  return { ok: true, host, answer }
}
