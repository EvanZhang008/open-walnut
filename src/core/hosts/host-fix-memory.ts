/**
 * The automatic host fixes that failed, kept across server restarts.
 *
 * The autofix runs each fix once per host per server lifetime (host-autofix.ts),
 * and a deploy is a new server lifetime. 2026-11-03: on a home PC every prod
 * restart of the day ran install-claude-native again (four downloads of the
 * Claude Code installer, each failing the same way after five minutes), then
 * install-compiler again, which needs a password it never has. A fix that
 * failed here is tried again only after FIX_RETRY_AFTER_MS, or when a person
 * asks (Check again / Connect: resetHostAutofixAttempts), never because the
 * server restarted. A fix that worked leaves nothing behind; one the person
 * made outside Walnut leaves its failure until the window ends, so a problem
 * that comes back within the day waits for Check again.
 *
 * Stored at WALNUT_HOME/cache/host-fix-failures.json on the primary:
 * { [host]: { [action]: HostFixRecord } }. Reads and writes are async and
 * one at a time; an unreadable file reads as empty (the fix runs, as before).
 */

import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import type { HostFixRecord } from './host-autofix.js'

/** A failed fix waits this long before a server tries it again on its own. */
export const FIX_RETRY_AFTER_MS = 24 * 60 * 60_000

type Store = Record<string, Record<string, HostFixRecord>>

let fileOverride: string | null = null
function file(): string {
  return fileOverride ?? path.join(WALNUT_HOME, 'cache', 'host-fix-failures.json')
}

let cache: Promise<Store> | null = null
/** Bumped on every test reset: a write queued before it never lands in the next test's file. */
let generation = 0

/** Tests: point the store at a temp file (null = back to WALNUT_HOME), and forget what was read. */
export function setHostFixMemoryFileForTest(f: string | null): void {
  fileOverride = f
  cache = null
  generation++
  chain = Promise.resolve()
}

/** Tests: what a new server process does, read the file again (after the writes asked for so far). */
export async function reloadHostFixMemoryForTest(): Promise<void> {
  await chain
  cache = null
}

function load(): Promise<Store> {
  cache ??= fs.promises.readFile(file(), 'utf8').then((raw) => {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Store : {}
  }).catch(() => ({}))
  return cache
}

function isRecord(r: unknown): r is HostFixRecord {
  const x = r as HostFixRecord | null
  return !!x && typeof x.action === 'string' && x.ok === false && typeof x.finishedAt === 'number' && typeof x.text === 'string'
}

/** The fixes that failed on `host` within the retry window, oldest first. */
export async function recentFailedFixes(host: string, now: number = Date.now()): Promise<HostFixRecord[]> {
  // After any write already asked for (a forget from Check again must win).
  await chain
  const entry = (await load())[host] ?? {}
  return Object.values(entry)
    .filter((r) => isRecord(r) && now - r.finishedAt < FIX_RETRY_AFTER_MS && r.finishedAt <= now + 60_000)
    .sort((a, b) => a.finishedAt - b.finishedAt)
    // Copies: the caller keeps these in its own state, apart from the stored ones.
    .map((r) => ({ ...r }))
}

let chain: Promise<unknown> = Promise.resolve()
function mutate(fn: (s: Store) => boolean): Promise<void> {
  const target = file()
  const gen = generation
  const next = chain.then(async () => {
    if (gen !== generation) return
    const s = await load()
    if (!fn(s)) return
    const tmp = `${target}.${process.pid}.tmp`
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
    await fs.promises.rename(tmp, target)
  })
  chain = next.catch(() => {})
  return next.catch(() => {})
}

/** A fix that was really attempted on `host`: a failure is kept, a success clears its earlier failure. */
export function rememberFixOutcome(host: string, record: HostFixRecord): Promise<void> {
  return mutate((s) => {
    const entry = s[host] ?? {}
    if (record.ok) {
      if (!(record.action in entry)) return false
      delete entry[record.action]
    } else {
      entry[record.action] = { ...record }
    }
    if (Object.keys(entry).length) s[host] = entry
    else delete s[host]
    return true
  })
}

/** Every host's (a reset of the whole readiness store). */
export function forgetAllHostFixes(): Promise<void> {
  return mutate((s) => {
    if (!Object.keys(s).length) return false
    for (const k of Object.keys(s)) delete s[k]
    return true
  })
}

/** A person asked for every fix again on `host` (or the host is gone). */
export function forgetHostFixes(host: string): Promise<void> {
  return mutate((s) => {
    if (!(host in s)) return false
    delete s[host]
    return true
  })
}
