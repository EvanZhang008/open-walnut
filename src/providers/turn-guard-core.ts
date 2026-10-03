/**
 * The rewind guard, shared by both daemon twins.
 *
 * A rewind that restores files writes back what THIS session's file history
 * holds. If someone else changed one of those files after this session last
 * wrote it (another session, the user, a formatter), the restore throws that
 * work away. Before the dialog restores, the daemon answers, for each file the
 * CLI's dry run named, whether that happened and, when it can, who did it.
 *
 * Two facts per file, both host-local:
 *   - snapshot: the current content against this session's newest turn
 *     snapshot (turn-snapshot-core.ts `compareToLatest`). Fresh when the
 *     snapshot was taken at the session's last turn end; stale when a later
 *     turn ended with its snapshot skipped.
 *   - transcript: the current content against the LAST op this session's
 *     transcript records for the file (a Write's content, an Edit's new text).
 *
 * Verdict (guardVerdict):
 *   snapshot differs, fresh                 -> conflict (written after this
 *                                              session's last turn ended)
 *   snapshot differs, stale                 -> the transcript decides; unknown
 *                                              = suspect
 *   snapshot same, transcript differs       -> suspect (changed during the
 *                                              turn, a hook, a Bash edit)
 *   no snapshot, transcript differs         -> conflict
 *   otherwise                               -> clear
 *
 * A suspect becomes a conflict only when a sibling session's last op on the
 * file matches the current content, so a session's own Bash edit or a
 * formatter run never raises a false alarm on its own.
 *
 * Writers: other sessions on this host whose cwd is in the same repository and
 * whose transcript ops include the file (`sessionOps`, the daemon's cached
 * changes compute), bounded by count and by the budget. A writer is
 * `consistent` when its last op matches the current content: that is the
 * session to name. No consistent writer = "edited outside this session".
 *
 * Self-contained factory (daemon-source.ts inlines `createTurnGuard.toString()`
 * through `__CREATE_TURN_GUARD__`): nothing at module scope is referenced.
 */

export interface TurnGuardOp {
  kind: string
  content?: string
  newString?: string
  failed?: boolean
}

export interface TurnGuardCompareFile {
  path: string
  rel: string | null
  exists: boolean
  regular: boolean
  text: string | null
  snapshot: 'same' | 'differs' | 'unknown'
}

export interface TurnGuardCompare {
  repoRoot: string | null
  snapshotN: number | null
  snapshotAt: number | null
  snapshotStale: boolean
  files: TurnGuardCompareFile[]
}

export interface TurnGuardDeps {
  compare?: (sid: string, cwd: string, files: string[], budgetMs: number) => Promise<TurnGuardCompare>
  repoRootOf?: (cwd: string) => Promise<string | null>
  /** A session's transcript ops per absolute path (null: no transcript). */
  sessionOps?: (sid: string, cwd: string) => Promise<Map<string, { ops: TurnGuardOp[] }> | null>
  realpath?: (p: string) => Promise<string>
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, data?: Record<string, unknown>) => void
  /** Whole-guard budget (default 8s). */
  budgetMs?: number
  /** Sibling sessions read at most (default 12). */
  maxSiblings?: number
}

export interface TurnGuardSibling {
  sid: string
  cwd: string
  title?: string
}

export interface TurnGuardWriter {
  sid: string
  title?: string
  /** Its last op on the file matches the current content. */
  consistent: boolean
}

export type TurnGuardFact = 'same' | 'differs' | 'unknown'
export type TurnGuardVerdict = 'conflict' | 'suspect' | 'clear'

export interface TurnGuardFile {
  path: string
  rel: string | null
  exists: boolean
  snapshot: TurnGuardFact
  transcript: TurnGuardFact
  verdict: TurnGuardVerdict
  writers: TurnGuardWriter[]
  /** Someone else changed it after this session last wrote it. */
  conflict: boolean
}

export interface TurnGuardResult {
  /** False when nothing could be judged (budget gone before the first fact). */
  checked: boolean
  repoRoot: string | null
  snapshotN: number | null
  snapshotStale: boolean
  /** The budget ran out while naming writers. */
  partial: boolean
  files: TurnGuardFile[]
  conflicts: TurnGuardFile[]
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createTurnGuard(deps: TurnGuardDeps) {
  var BUDGET_MS = deps.budgetMs ?? 8000
  var MAX_SIBLINGS = deps.maxSiblings ?? 12
  var MAX_FILES = 200
  var now = deps.now ?? (() => Date.now())
  var log = deps.log ?? (() => {})

  function norm(s: string): string {
    return s.indexOf('\r') >= 0 ? s.replace(/\r\n/g, '\n') : s
  }

  /** Does the current file agree with this op having been the last write? */
  function opVerdict(op: TurnGuardOp | null | undefined, file: { path: string; exists: boolean; regular?: boolean; text: string | null }): TurnGuardFact {
    if (!op) return 'unknown'
    // A notebook's ops are cell edits: their text is not the file's.
    if (/\.ipynb$/i.test(file.path)) return 'unknown'
    var kind = op.kind
    if (kind === 'delete') return file.exists ? 'differs' : 'same'
    if (!file.exists) return 'differs'
    if (kind === 'write') {
      if (typeof op.content !== 'string' || file.text === null) return 'unknown'
      return norm(file.text) === norm(op.content) ? 'same' : 'differs'
    }
    if (kind === 'edit') {
      if (typeof op.newString !== 'string' || op.newString === '' || file.text === null) return 'unknown'
      return norm(file.text).indexOf(norm(op.newString)) >= 0 ? 'same' : 'differs'
    }
    // create (no content recorded), rename: present, content unknown.
    return 'unknown'
  }

  function guardVerdict(snapshot: TurnGuardFact, stale: boolean, transcript: TurnGuardFact): TurnGuardVerdict {
    if (snapshot === 'differs') {
      if (!stale) return 'conflict'
      return transcript === 'differs' ? 'conflict' : transcript === 'same' ? 'clear' : 'suspect'
    }
    if (snapshot === 'same') return transcript === 'differs' ? 'suspect' : 'clear'
    return transcript === 'differs' ? 'conflict' : 'clear'
  }

  /** The last op that reached the file (a failed tool call never did). */
  function lastOp(accum: { ops: TurnGuardOp[] } | null | undefined): TurnGuardOp | null {
    if (!accum || !Array.isArray(accum.ops)) return null
    for (var i = accum.ops.length - 1; i >= 0; i--) {
      var op = accum.ops[i]
      if (op && !op.failed) return op
    }
    return null
  }

  function raceDeadline<T>(p: Promise<T>, deadline: number): Promise<T | null> {
    var left = deadline - now()
    if (left <= 0) return Promise.resolve(null)
    return new Promise<T | null>((resolve) => {
      var done = false
      var timer = setTimeout(() => { if (!done) { done = true; resolve(null) } }, left)
      p.then((v) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(v)
      }, () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(null)
      })
    })
  }

  /** `map`'s entry for `abs`, also through symlinked spellings (/var vs /private/var). */
  async function lookup(
    map: Map<string, { ops: TurnGuardOp[] }> | null, abs: string, realOf: Map<string, string>,
    byReal: { m: Map<string, { ops: TurnGuardOp[] }> | null },
  ): Promise<{ ops: TurnGuardOp[] } | null> {
    if (!map) return null
    var hit = map.get(abs)
    if (hit) return hit
    if (!deps.realpath || map.size > 5000) return null
    if (!byReal.m) {
      var m = new Map<string, { ops: TurnGuardOp[] }>()
      for (var entry of map) {
        var r = await realOf_(entry[0], realOf)
        m.set(r, entry[1])
      }
      byReal.m = m
    }
    return byReal.m.get(await realOf_(abs, realOf)) || null
  }

  async function realOf_(p: string, cache: Map<string, string>): Promise<string> {
    var known = cache.get(p)
    if (known !== undefined) return known
    var r = p
    if (deps.realpath) {
      try { r = await deps.realpath(p) } catch {
        // A deleted file: resolve its directory instead.
        var slash = p.lastIndexOf('/')
        if (slash > 0) {
          try { r = (await deps.realpath(p.slice(0, slash))) + p.slice(slash) } catch { r = p }
        }
      }
    }
    cache.set(p, r)
    return r
  }

  async function guard(input: { sid: string; cwd: string; files: unknown; siblings?: unknown }): Promise<TurnGuardResult> {
    var started = now()
    var deadline = started + BUDGET_MS
    var empty: TurnGuardResult = { checked: false, repoRoot: null, snapshotN: null, snapshotStale: false, partial: false, files: [], conflicts: [] }
    var seen = new Set<string>()
    var files: string[] = []
    var raw = Array.isArray(input.files) ? input.files : []
    for (var i = 0; i < raw.length && files.length < MAX_FILES; i++) {
      var f = raw[i]
      if (typeof f === 'string' && f.charAt(0) === '/' && f.length < 4096 && !seen.has(f)) { seen.add(f); files.push(f) }
    }
    if (!files.length || !input.cwd || !deps.compare) return Object.assign(empty, { checked: files.length === 0 })
    var cmp = await raceDeadline(deps.compare(input.sid, input.cwd, files, Math.max(500, BUDGET_MS - 1500)), deadline)
    if (!cmp) return empty
    var realOf = new Map<string, string>()
    var ownOps = deps.sessionOps ? await raceDeadline(deps.sessionOps(input.sid, input.cwd), deadline) : null
    var ownByReal = { m: null as Map<string, { ops: TurnGuardOp[] }> | null }
    var out: TurnGuardFile[] = []
    var current = new Map<string, TurnGuardCompareFile>()
    for (var k = 0; k < cmp.files.length; k++) {
      var c = cmp.files[k]
      current.set(c.path, c)
      var own = lastOp(await lookup(ownOps, c.path, realOf, ownByReal))
      var tx = opVerdict(own, c)
      var verdict = guardVerdict(c.snapshot, cmp.snapshotStale, tx)
      out.push({
        path: c.path, rel: c.rel, exists: c.exists, snapshot: c.snapshot, transcript: tx,
        verdict: verdict, writers: [], conflict: verdict === 'conflict',
      })
    }

    // Name the writers of every file that is not clear.
    var open = out.filter((x) => x.verdict !== 'clear')
    var partial = false
    var sibs = Array.isArray(input.siblings) ? input.siblings as TurnGuardSibling[] : []
    var read = 0
    if (open.length && sibs.length && deps.sessionOps) {
      for (var s = 0; s < sibs.length && read < MAX_SIBLINGS; s++) {
        var sib = sibs[s]
        if (!sib || typeof sib.sid !== 'string' || !sib.sid || sib.sid === input.sid || typeof sib.cwd !== 'string' || !sib.cwd) continue
        if (now() >= deadline) { partial = true; break }
        if (cmp.repoRoot) {
          var root = deps.repoRootOf ? await raceDeadline(deps.repoRootOf(sib.cwd), deadline) : null
          if (root !== cmp.repoRoot) continue
        } else if (sib.cwd !== input.cwd) {
          continue
        }
        read++
        var ops = await raceDeadline(deps.sessionOps(sib.sid, sib.cwd), deadline)
        if (!ops) continue
        var byReal = { m: null as Map<string, { ops: TurnGuardOp[] }> | null }
        for (var q = 0; q < open.length; q++) {
          var last = lastOp(await lookup(ops, open[q].path, realOf, byReal))
          if (!last) continue
          var cur = current.get(open[q].path)
          var w: TurnGuardWriter = { sid: sib.sid, consistent: !!cur && opVerdict(last, cur) === 'same' }
          if (typeof sib.title === 'string' && sib.title) w.title = sib.title.slice(0, 200)
          open[q].writers.push(w)
        }
      }
    }
    for (var o = 0; o < open.length; o++) {
      open[o].writers.sort((a, b) => Number(b.consistent) - Number(a.consistent))
      if (open[o].verdict === 'suspect') open[o].conflict = open[o].writers.some((x) => x.consistent)
    }
    var conflicts = out.filter((x) => x.conflict)
    log('info', 'rewind guard', {
      sid: input.sid, files: out.length, conflicts: conflicts.length, siblingsRead: read, partial: partial, ms: now() - started,
    })
    return {
      checked: true, repoRoot: cmp.repoRoot, snapshotN: cmp.snapshotN, snapshotStale: cmp.snapshotStale,
      partial: partial, files: out, conflicts: conflicts,
    }
  }

  return { guard, opVerdict, guardVerdict, lastOp }
}

export type TurnGuard = ReturnType<typeof createTurnGuard>

var pureGuard = createTurnGuard({})
export const turnGuardVerdict = pureGuard.guardVerdict
export const turnGuardOpVerdict = pureGuard.opVerdict
