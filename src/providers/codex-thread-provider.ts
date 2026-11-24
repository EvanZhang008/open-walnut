/**
 * A resumed Codex thread keeps the provider id it was created under.
 *
 * Codex records that id in the first line of the thread's rollout
 * (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`,
 * `{"type":"session_meta","payload":{"model_provider":"<id>",...}}`) and checks it on
 * every resume: Codex 0.171 refuses a thread whose id is not configured ("This chat uses
 * model provider X, which is no longer configured") and a resume that names another id
 * ("Cannot change this thread's model provider from X to Y on resume"). A provider id Walnut
 * defined goes away when a user renames theirs or when a host gets a provider of its own under
 * another name (codex-engine-config.ts codexProviderForPlace), and every older thread then
 * failed to resume and was replaced by a new, empty one (2026-11-24).
 *
 * So the host that resumes a thread reads the id it recorded and makes the resume name it:
 *   - an id Walnut's CODEX_CONFIG defines: the resume names it;
 *   - an id nothing defines any more: it is defined as an alias of the provider Walnut uses
 *     now (the same entry, under the old id), and the resume names it, so the thread goes on
 *     at today's endpoint. The alias is a copy of the provider the server already resolved
 *     for this host, so it never adds an endpoint (a loopback one stays on its own machine);
 *   - an id the user's own config.toml defines, or one of Codex's built-in providers:
 *     nothing changes (that provider is the user's own, and resuming under it would go past
 *     the provider Walnut was set to use), so Codex 0.171 still refuses that resume;
 *   - a rollout that cannot be found or read in time: nothing changes.
 *
 * The codex-acp adapter names one provider for all the threads its worker loads, so with it
 * only the first thread a start tries resumes under its own id; a second load whose thread
 * recorded another id is refused as before (no alias helps: Codex refuses any resume that
 * names an id other than the recorded one). The direct client, the default, names each.
 *
 * Runs in the session daemon before it starts the worker (acp-daemon.ts acpStart), with a
 * deadline; node builtins only (it is compiled into the daemon).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The adapter env naming how a Codex session reaches Codex (codex-app-server/transport.ts,
 * which re-exports it): named here so the daemon reads it without loading the direct client.
 */
export const CODEX_TRANSPORT_ENV = 'WALNUT_CODEX_TRANSPORT'
/** A provider id codex reads as a table key. */
export const CODEX_PROVIDER_ID = /^[A-Za-z0-9_-]+$/
/** Codex's built-in providers: always configured, and a user table of the same id never wins over one. */
export const CODEX_BUILT_IN_PROVIDER_IDS: ReadonlySet<string> = new Set(['openai', 'ollama', 'lmstudio', 'oss'])

/** How much of a rollout's first line is read: its session_meta names the provider near its start. */
const FIRST_LINE_CAP = 1024 * 1024
const CHUNK = 64 * 1024
/** How much of config.toml is read. */
const CONFIG_CAP = 1024 * 1024
/** The day folders a thread id that carries no time (not a UUIDv7) is looked for in, newest first. */
const UNDATED_DAY_DIRS = 62
const DEADLINE_MS = 3_000
const THREAD_ID = /^[A-Za-z0-9-]{8,80}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function codexHomeOf(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  return env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')
}

/** The UTC time a UUIDv7 thread id was minted at, or undefined for another kind of id. */
function uuidV7Time(id: string): number | undefined {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i.exec(id)
  if (!m) return undefined
  const ms = parseInt(m[1] + m[2], 16)
  return Number.isFinite(ms) ? ms : undefined
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** The day folders a thread minted at `ms` may be in: Codex names them in local time, so the UTC day and the days beside it. */
function dayDirsAround(ms: number): string[] {
  const out = new Set<string>()
  for (const shift of [0, -1, 1]) {
    const at = new Date(ms + shift * 86_400_000)
    out.add(path.join(String(at.getUTCFullYear()), pad(at.getUTCMonth() + 1), pad(at.getUTCDate())))
    out.add(path.join(String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate())))
  }
  return [...out]
}

async function listDir(dir: string): Promise<string[]> {
  try { return await fs.promises.readdir(dir) } catch { return [] }
}

/** The newest day folders under sessions/, up to `limit`. */
async function newestDayDirs(sessions: string, limit: number): Promise<string[]> {
  const out: string[] = []
  const desc = (names: string[]) => names.filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a))
  for (const year of desc(await listDir(sessions))) {
    for (const month of desc(await listDir(path.join(sessions, year)))) {
      for (const day of desc(await listDir(path.join(sessions, year, month)))) {
        out.push(path.join(year, month, day))
        if (out.length >= limit) return out
      }
    }
  }
  return out
}

/** The rollout file of `threadId` under `codexHome`, or undefined. */
export async function findCodexRollout(codexHome: string, threadId: string): Promise<string | undefined> {
  if (!THREAD_ID.test(threadId)) return undefined
  const suffix = `-${threadId}.jsonl`
  const sessions = path.join(codexHome, 'sessions')
  const ms = uuidV7Time(threadId)
  const days = ms !== undefined ? dayDirsAround(ms) : await newestDayDirs(sessions, UNDATED_DAY_DIRS)
  for (const day of days) {
    const hit = (await listDir(path.join(sessions, day))).find((n) => n.startsWith('rollout-') && n.endsWith(suffix))
    if (hit) return path.join(sessions, day, hit)
  }
  const archived = path.join(codexHome, 'archived_sessions')
  const hit = (await listDir(archived)).find((n) => n.startsWith('rollout-') && n.endsWith(suffix))
  return hit ? path.join(archived, hit) : undefined
}

/** The provider id a rollout's first line (its session_meta) records, or undefined. */
export async function readRolloutProvider(file: string): Promise<string | undefined> {
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(file, 'r')
    const chunks: Buffer[] = []
    let total = 0
    let ended = false
    while (total < FIRST_LINE_CAP) {
      const buf = Buffer.alloc(Math.min(CHUNK, FIRST_LINE_CAP - total))
      const { bytesRead } = await handle.read(buf, 0, buf.length, total)
      if (bytesRead === 0) break
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a)
      chunks.push(buf.subarray(0, nl >= 0 ? nl : bytesRead))
      total += bytesRead
      if (nl >= 0) { ended = true; break }
    }
    const line = Buffer.concat(chunks).toString('utf8')
    let id: unknown
    if (ended || total < FIRST_LINE_CAP) {
      try {
        const rec = JSON.parse(line) as { type?: unknown; payload?: { model_provider?: unknown } }
        if (rec.type !== 'session_meta') return undefined
        id = rec.payload?.model_provider
      } catch { /* a line cut short: the key below */ }
    }
    // A first line longer than the cap: the key as written, ahead of the long instructions it carries.
    if (id === undefined && line.startsWith('{') && line.includes('"session_meta"')) id = /"model_provider":"([A-Za-z0-9_-]+)"/.exec(line)?.[1]
    return typeof id === 'string' && CODEX_PROVIDER_ID.test(id) ? id : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** The provider ids the user's own `<codexHome>/config.toml` defines (`[model_providers.<id>]`, dotted keys, an inline table). */
export async function userDefinedCodexProviders(codexHome: string): Promise<Set<string>> {
  const ids = new Set<string>()
  let text: string
  try {
    const handle = await fs.promises.open(path.join(codexHome, 'config.toml'), 'r')
    try {
      const buf = Buffer.alloc(CONFIG_CAP)
      const { bytesRead } = await handle.read(buf, 0, CONFIG_CAP, 0)
      text = buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close().catch(() => {})
    }
  } catch {
    return ids
  }
  const key = String.raw`(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))`
  const header = new RegExp(String.raw`^\s*\[\s*model_providers\s*\.\s*${key}\s*[\].]`)
  const dotted = new RegExp(String.raw`^\s*model_providers\s*\.\s*${key}\s*[.=]`)
  const inline = /^\s*model_providers\s*=\s*\{(.*)\}\s*$/
  let table = ''
  for (const line of text.split(/\r?\n/)) {
    const h = header.exec(line)
    if (h) { ids.add(h[1] ?? h[2] ?? h[3]); table = 'model_providers'; continue }
    if (/^\s*\[/.test(line)) { table = /^\s*\[\s*model_providers\s*\]/.test(line) ? 'providers-root' : 'other'; continue }
    if (table === 'other' || table === 'model_providers') continue
    if (table === 'providers-root') {
      // Under [model_providers]: `<id> = { ... }` or `<id>.base_url = ...`.
      const m = new RegExp(String.raw`^\s*${key}\s*[.=]`).exec(line)
      if (m) ids.add(m[1] ?? m[2] ?? m[3])
      continue
    }
    const d = dotted.exec(line)
    if (d) { ids.add(d[1] ?? d[2] ?? d[3]); continue }
    const i = inline.exec(line)
    if (i) for (const m of i[1].matchAll(new RegExp(String.raw`(?:^|,)\s*${key}\s*=\s*\{`, 'g'))) ids.add(m[1] ?? m[2] ?? m[3])
  }
  return ids
}

export interface CodexResumePlan {
  /** The CODEX_CONFIG to start the worker with (aliases added, and for the adapter its provider), or undefined when it stays. */
  codexConfig?: string
  /** Thread id → the provider id its resume names (the id it recorded). */
  providers: Record<string, string>
  /** What was done, for the daemon's log. */
  notes: Array<{ thread: string; recorded: string; current: string; action: 'alias' | 'named' | 'user-provider' }>
}

export interface CodexResumeDeps {
  readRecorded?: (codexHome: string, threadId: string) => Promise<string | undefined>
  userProviders?: (codexHome: string) => Promise<Set<string>>
  deadlineMs?: number
}

async function recordedProviderOf(codexHome: string, threadId: string): Promise<string | undefined> {
  const file = await findCodexRollout(codexHome, threadId)
  return file ? readRolloutProvider(file) : undefined
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms) })
  return Promise.race([work.catch(() => undefined), late]).finally(() => clearTimeout(timer))
}

/**
 * THE step every Codex resume on a host takes (acp-daemon.ts, before the worker starts;
 * tests/providers/codex-thread-provider-ratchet.test.ts holds every load to it).
 *
 *   codexConfig   the CODEX_CONFIG the worker would start with (the server resolved it for this host)
 *   codexHome     where this host's Codex keeps its threads
 *   threadIds     the threads the start may load, in the order it tries them
 *   adapter       the codex-acp adapter runs the threads (it names one provider for all of
 *                 them): the first thread's recorded id becomes CODEX_CONFIG's provider
 */
export async function planCodexResume(
  opts: { codexConfig: string | undefined; codexHome: string; threadIds: ReadonlyArray<string | null | undefined>; adapter?: boolean },
  deps: CodexResumeDeps = {},
): Promise<CodexResumePlan> {
  const plan: CodexResumePlan = { providers: {}, notes: [] }
  if (!opts.codexConfig) return plan
  let config: unknown
  try { config = JSON.parse(opts.codexConfig) } catch { return plan }
  if (!isRecord(config)) return plan
  const current = config.model_provider
  const providers = isRecord(config.model_providers) ? config.model_providers : undefined
  // Walnut names no provider here: Codex uses the host's own, and nothing is Walnut's to change.
  if (typeof current !== 'string' || !providers || !isRecord(providers[current])) return plan
  const ids = [...new Set(opts.threadIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) return plan
  const read = deps.readRecorded ?? recordedProviderOf
  const deadline = deps.deadlineMs ?? DEADLINE_MS
  const recorded = await withDeadline(Promise.all(ids.map((id) => read(opts.codexHome, id).catch(() => undefined))), deadline) ?? []
  const differing = ids.map((id, i) => ({ id, recorded: recorded[i] })).filter((t) => t.recorded && t.recorded !== current)
  if (differing.length === 0) return plan
  const userOwn = differing.some((t) => !Object.hasOwn(providers, t.recorded!))
    ? (await withDeadline((deps.userProviders ?? userDefinedCodexProviders)(opts.codexHome), deadline)) ?? new Set<string>()
    : new Set<string>()
  const nextProviders: Record<string, unknown> = { ...providers }
  let changed = false
  for (const { id, recorded: rec } of differing) {
    const old = rec!
    if (Object.hasOwn(nextProviders, old)) {
      plan.providers[id] = old
      plan.notes.push({ thread: id, recorded: old, current, action: Object.hasOwn(providers, old) ? 'named' : 'alias' })
      continue
    }
    if (CODEX_BUILT_IN_PROVIDER_IDS.has(old.toLowerCase()) || userOwn.has(old)) {
      plan.notes.push({ thread: id, recorded: old, current, action: 'user-provider' })
      continue
    }
    nextProviders[old] = { ...(providers[current] as Record<string, unknown>), name: old }
    changed = true
    plan.providers[id] = old
    plan.notes.push({ thread: id, recorded: old, current, action: 'alias' })
  }
  const next: Record<string, unknown> = { ...config, model_providers: nextProviders }
  // The adapter's resume names the app-server's own provider: the thread it tries first decides it.
  const first = plan.providers[ids[0]]
  if (opts.adapter && first && first !== current) {
    next.model_provider = first
    changed = true
  }
  if (changed) plan.codexConfig = JSON.stringify(next)
  return plan
}
