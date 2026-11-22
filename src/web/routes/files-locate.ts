/**
 * Where a CLICKED path lives: the one lookup every surface that opens a path
 * from text goes through (GET /api/files/locate).
 *
 * A session on one host now regularly names a file on another: a Mac handoff,
 * a video recorded on the Mac, a task directory that exists on both. The old
 * click looked only on the session's host, the listing healed to the nearest
 * existing folder, and for a Mac path on a Linux box that folder was `/`
 * (2026-11-01: a clouddev session's link to an MP4 in the Mac's task directory
 * opened the whole filesystem root of clouddev).
 *
 * Order, cheapest and most literal first:
 *  1. The exact path, on every host at once (one stat each, bounded by
 *     linkPathsExist's deadline). The session's host wins when it has it; else
 *     the first other host that has it, a `/Users/` path asking the Mac first
 *     and a `/home/` path the Linux hosts first.
 *  2. The layered resolver on the session's host (transcript, ancestor walk, git
 *     index, find): the reference as WRITTEN may still be a wrong-prefix or a
 *     relative path that only makes sense there.
 *  3. Nowhere: `missing` with the hosts that were asked, never a stand-in folder
 *     as shallow as `/`.
 *
 * Words whose writer Walnut did not record (`anywhere`) have no session host: every
 * machine is asked, the hosts of the task the words or the path name first
 * (`taskId`, a task directory's `<id>`), and the file opens from the one that has it.
 * The person is never asked to pick a machine (2026-11-23, Evan: "Why walnut not
 * auto pic the host it need me to pick", "or which task it is ... then walnut will
 * take care find it").
 */

import os from 'node:os'
import path from 'node:path'
import { getConfig } from '../../core/config-manager.js'
import { hostDisplayName } from '../../core/hosts/host-display-name.js'
import { parsePathRef, isUnsafePathRef } from '../../providers/path-ref-parse.js'
import { FilesOpError, linkPathsExist, resolveSessionPath } from './files.js'

export interface LocateRequest {
  ref: unknown
  /** The session's working directory: anchors a relative ref and the resolver. */
  cwd?: string
  /** The session's host (absent = this machine). */
  host?: string
  sessionId?: string
  sourceOnly?: boolean
  /** The writer is unknown: no session host, every machine is asked (locateAnywhere). */
  anywhere?: boolean
  /** A task the words belong to: its sessions' hosts are asked first when `anywhere`. */
  taskId?: string
  /** Sessions that wrote the words ('__local__' for the person on the primary): their hosts are
   *  asked first of all when `anywhere` (several writers on a Board or a Brief). */
  hintSessions?: string[]
}

/** The request as the web route, the v1 route and the replica relay hand it over. */
export function locateRequestOf(q: Record<string, unknown>): LocateRequest {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const flag = (v: unknown) => v === true || v === '1'
  return {
    ref: q.ref, cwd: str(q.cwd), host: str(q.host), sessionId: str(q.sessionId),
    sourceOnly: flag(q.sourceOnly),
    ...(flag(q.anywhere) ? { anywhere: true } : {}),
    ...(str(q.taskId) ? { taskId: str(q.taskId) } : {}),
    ...(hintsOf(q.hintSessions).length ? { hintSessions: hintsOf(q.hintSessions) } : {}),
  }
}

/** Up to 20 session ids, from a comma list (the query) or an array (the relay). */
function hintsOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  return [...new Set(list.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))].slice(0, 20)
}

/** The query string fields of a request, for a relay to the primary (only those set). */
export function locateBodyOf(r: LocateRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { ref: r.ref }
  for (const k of ['cwd', 'host', 'sessionId', 'taskId'] as const) if (r[k]) body[k] = r[k]
  if (r.sourceOnly) body.sourceOnly = true
  if (r.anywhere) body.anywhere = true
  if (r.hintSessions?.length) body.hintSessions = r.hintSessions
  return body
}

export interface LocateResult {
  /** The path to open (on `host`), or the ref as asked when `missing`. */
  path: string
  /** Where it lives; absent = this machine. */
  host?: string
  /** `host` as a person knows it (the phone names it in the viewer). */
  hostName?: string
  found: boolean
  /** It is on a host other than the session's. */
  elsewhere?: boolean
  /** No host has it: the surface says so instead of opening a stand-in. */
  missing?: boolean
  /** Names of the hosts that were asked, as a person knows them (for `missing`). */
  checked?: string[]
  /** `anywhere` only: hosts that could not answer now (down, dialing): the file may be there. */
  unreachable?: string[]
  via?: string
  line?: number
  column?: number
  endLine?: number
}

/** The name the web console gives this machine (web/src/utils/host-display-label.ts). */
const LOCAL_NAME = 'This Mac'

/** A `/Users/` path is written on a Mac, a `/home/` path on Linux. */
function pathOrigin(p: string): 'mac' | 'linux' | null {
  if (/^\/(Users|Volumes)\//.test(p)) return 'mac'
  if (/^\/home\//.test(p)) return 'linux'
  return null
}

/**
 * The hosts to ask besides the session's, in tie-break order. This machine is
 * a host like the others (absent key); a disabled host is not asked.
 */
async function otherHosts(sessionHost: string | undefined, p: string, withLocal = !!sessionHost): Promise<Array<{ key?: string; name: string }>> {
  const config = await getConfig()
  const { runsSessions } = await import('../../core/server-role.js')
  const remotes = Object.entries(config.hosts ?? {})
    .filter(([key, def]) => key !== sessionHost && def?.hostname && def.enabled !== false)
    .map(([key, def]) => ({ key, name: hostDisplayName(key, def.label) }))
  // A box where no session runs (the companion) holds none of their files (linkPathsExist answers nothing there anyway).
  const local = withLocal && runsSessions() ? [{ name: LOCAL_NAME }] : []
  const localIsMac = os.platform() === 'darwin'
  const origin = pathOrigin(p)
  const localFirst = origin === null || (origin === 'mac') === localIsMac
  return localFirst ? [...local, ...remotes] : [...remotes, ...local]
}

/** Display name of the session's host. */
async function nameOf(host: string | undefined): Promise<string> {
  if (!host) return LOCAL_NAME
  const def = (await getConfig()).hosts?.[host] as { label?: unknown } | undefined
  return hostDisplayName(host, def?.label)
}

/** Whether `p` exists on `host`: true / false, or undefined when the host cannot say now. */
async function existsOn(p: string, host: string | undefined): Promise<boolean | undefined> {
  return (await linkPathsExist([p], host))[p]
}

/** The resolver's search budget here: a click waits on it, and an honest miss
 *  over a big home directory otherwise ran the remote default (12 s). */
const RESOLVE_BUDGET_MS = 4_000
/** How long a host earlier in the order may still answer once a later one has the file. */
const TIE_GRACE_MS = 300
/** With no session host (`anywhere`), how long a host earlier in the order (a hint) may still
 *  answer once a later one has the file: a hinted host that is down must not hold the click. */
const ANYWHERE_GRACE_MS = 800

/**
 * The first answer that has the file, in order: index `i` wins once it answers
 * true and every earlier one answered, or TIE_GRACE_MS after it did (a host that
 * is down must not hold every click for its whole deadline). Index 0, the
 * session's host, is always waited for: over SSH it often answers after this
 * machine, and its copy of a path both have (`/tmp/...`) is the one meant.
 * `hit` is -1 when none has it; `answers` is then complete.
 */
function firstFound(asks: Promise<boolean | undefined>[], opts: { waitFirst?: boolean; graceMs?: number } = {}): Promise<{ hit: number; answers: (boolean | undefined)[] }> {
  const waitFirst = opts.waitFirst ?? true
  const graceMs = opts.graceMs ?? TIE_GRACE_MS
  return new Promise((resolve) => {
    const answers: (boolean | undefined)[] = new Array(asks.length)
    const settled: boolean[] = new Array(asks.length).fill(false)
    let done = false
    let grace: ReturnType<typeof setTimeout> | undefined
    // Once the grace ran out, the session host's own answer decides at once.
    let forced = false
    const best = () => answers.findIndex((a, i) => settled[i] && a === true)
    const decide = (force: boolean) => {
      if (done) return
      const b = best()
      if (b !== -1 && (settled[0] || !waitFirst) && (force || settled.slice(0, b).every(Boolean))) {
        done = true; clearTimeout(grace); resolve({ hit: b, answers }); return
      }
      if (settled.every(Boolean)) { done = true; clearTimeout(grace); resolve({ hit: -1, answers }); return }
      if (b !== -1 && !grace) grace = setTimeout(() => { forced = true; decide(true) }, graceMs)
    }
    asks.forEach((ask, i) => {
      void ask.catch(() => undefined).then((a) => { answers[i] = a; settled[i] = true; decide(forced) })
    })
  })
}

/** The task a path in a Walnut task directory belongs to (`.../open-walnut/tasks/<id>/...`). */
export function taskIdOfTaskDirPath(p: string): string | undefined {
  return /\/open-walnut\/tasks\/([^/]+)\/./.exec(p)?.[1]
}

const LOCAL_KEYS = new Set(['', '__local__', 'local'])

/**
 * Host keys ('' = this machine) to ask first, in order: the writing sessions' hosts ('__local__'
 * is the person on the primary), then the hosts the tasks' sessions ran on, newest session first.
 * A task id counts only when it is a task's exact id (a path segment may be any word); an
 * unknown id or session adds none.
 */
async function hintedHosts(sessionIds: readonly string[], taskIds: Array<string | undefined>): Promise<string[]> {
  const out: string[] = []
  const add = (host: string | undefined) => { const key = !host || LOCAL_KEYS.has(host) ? '' : host; if (!out.includes(key)) out.push(key) }
  const [{ getTask }, { getSessionByClaudeId }] = await Promise.all([
    import('../../core/task-manager.js'), import('../../core/session-tracker.js'),
  ])
  const ofSession = async (sid: string) => {
    if (LOCAL_KEYS.has(sid)) { add(''); return }
    const record = await getSessionByClaudeId(sid).catch(() => null)
    if (record) add(record.host)
  }
  for (const sid of sessionIds) await ofSession(sid)
  for (const id of new Set(taskIds.filter((x): x is string => !!x))) {
    let task: Awaited<ReturnType<typeof getTask>>
    try { task = await getTask(id) } catch { continue }
    if (task.id !== id) continue
    const sids = [task.session_id, task.exec_session_id, task.plan_session_id, ...[...(task.session_ids ?? [])].reverse()]
    for (const sid of new Set(sids.filter((x): x is string => !!x))) await ofSession(sid)
  }
  return out
}

/**
 * A path whose writer is unknown: every machine is asked at once, in order (the named task's
 * hosts, then the host the path's shape points at), and the first that has it wins. A relative
 * path means nothing without its writer's folder: it says so instead of guessing one.
 */
async function locateAnywhere(req: LocateRequest, p: string, absolute: boolean, pos: Pick<LocateResult, 'line' | 'column' | 'endLine'>): Promise<LocateResult> {
  if (!absolute) return { path: p, found: false, missing: true, checked: [], ...pos }
  const every = await otherHosts(undefined, p, true)
  const hinted = await hintedHosts(req.hintSessions ?? [], [req.taskId, taskIdOfTaskDirPath(p)]).catch(() => [] as string[])
  const rank = (o: { key?: string }) => { const i = hinted.indexOf(o.key ?? ''); return i < 0 ? hinted.length : i }
  // A stable sort: hinted hosts first, the rest in the path's own order.
  const order = every.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i).map((x) => x.o)
  if (order.length === 0) return { path: p, found: false, missing: true, checked: [], ...pos }
  // No host here is the writer's for sure: a hint that is down must not hold the click.
  const { hit, answers } = await firstFound(order.map((o) => existsOn(p, o.key)), { waitFirst: false, graceMs: ANYWHERE_GRACE_MS })
  if (hit >= 0) {
    const o = order[hit]!
    return { path: p, ...(o.key ? { host: o.key } : {}), hostName: o.name, found: true, elsewhere: true, via: 'anywhere', ...pos }
  }
  const unreachable = order.filter((_, i) => answers[i] !== false).map((o) => o.name)
  return {
    path: p, found: false, missing: true, checked: order.filter((_, i) => answers[i] === false).map((o) => o.name),
    ...(unreachable.length ? { unreachable } : {}), ...pos,
  }
}

export async function locateClickedPath(req: LocateRequest): Promise<LocateResult> {
  if (!req.ref || typeof req.ref !== 'string' || req.ref.length > 4096) {
    throw new FilesOpError('Missing or invalid ref parameter', 400)
  }
  const host = req.host === '__local__' || req.host === 'local' || !req.host ? undefined : req.host
  const parsed = parsePathRef(req.ref)
  if (isUnsafePathRef(parsed.path) || (req.cwd && isUnsafePathRef(req.cwd))) {
    throw new FilesOpError('Invalid path', 400)
  }
  const pos = {
    ...(parsed.line !== undefined ? { line: parsed.line } : {}),
    ...(parsed.column !== undefined ? { column: parsed.column } : {}),
    ...(parsed.endLine !== undefined ? { endLine: parsed.endLine } : {}),
  }
  const p = parsed.path
  const absolute = p.startsWith('/') || p === '~' || p.startsWith('~/')
  if (req.anywhere && !host && !req.sourceOnly) return locateAnywhere(req, p, absolute, pos)

  // 1. The exact path, on every host at once.
  if (absolute) {
    const others = req.sourceOnly ? [] : await otherHosts(host, p)
    const { hit, answers } = await firstFound([existsOn(p, host), ...others.map((o) => existsOn(p, o.key))])
    if (hit === 0) return { path: p, ...(host ? { host } : {}), found: true, via: 'exact', ...pos }
    if (hit > 0) {
      const o = others[hit - 1]!
      return { path: p, ...(o.key ? { host: o.key } : {}), hostName: o.name, found: true, elsewhere: true, via: 'other-host', ...pos }
    }
    const [here, ...there] = answers
    // The session's host cannot say now (reconnecting): open it there as before,
    // and the Files panel says the host is reconnecting.
    if (here === undefined) return { path: p, ...(host ? { host } : {}), found: false, ...pos }
    const checked = others.filter((_, i) => there[i] === false).map((o) => o.name)
    // 2. The resolver on the session's host, for a path written with a prefix
    // from another machine (`/Users/me/repo/src/a.ts` for `/home/me/repo/src/a.ts`).
    if (req.cwd) {
      try {
        const r = await resolveSessionPath(req.ref, req.cwd, host, req.sessionId, RESOLVE_BUDGET_MS)
        if (r.resolved) return { path: r.path, ...(host ? { host } : {}), found: true, ...(r.via ? { via: r.via } : {}), ...pos }
      } catch { /* the host cannot search now: nothing more is known */ }
    }
    // 3. Nowhere.
    return { path: p, ...(host ? { host } : {}), found: false, missing: true, checked: [await nameOf(host), ...checked], ...pos }
  }

  // A relative ref only means something against the session's cwd.
  if (!req.cwd) throw new FilesOpError('A relative path needs cwd', 400)
  const r = await resolveSessionPath(req.ref, req.cwd, host, req.sessionId, RESOLVE_BUDGET_MS)
  // The host could not search (reconnecting, an old daemon's walk): open it there as before.
  if (!r.resolved && !r.via) return { path: path.posix.join(req.cwd, p), ...(host ? { host } : {}), found: false, ...pos }
  // Not found: say so, never hand back the resolver's nearest-folder stand-in
  // as if it were the file (it can be as shallow as `/`).
  if (!r.resolved) {
    return {
      path: path.posix.join(req.cwd, p), ...(host ? { host } : {}), found: false, missing: true,
      checked: [await nameOf(host)], ...pos,
    }
  }
  return {
    path: r.path, ...(host ? { host } : {}), found: true,
    ...(r.via ? { via: r.via } : {}),
    ...(r.line !== undefined ? { line: r.line } : {}),
    ...(r.column !== undefined ? { column: r.column } : {}),
    ...(r.endLine !== undefined ? { endLine: r.endLine } : {}),
  }
}
