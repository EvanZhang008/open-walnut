/**
 * The daemon's `fs.ls`, shared by both twins, with time budgets.
 *
 * readdir dirents have lstat semantics, so a symlink needs one stat() to tell a
 * linked directory from a file. A link into a hung mount (an autofs home, a NAS
 * off the VPN) makes that stat block for the mount's own timeout, tens of
 * seconds, and the old listing awaited every entry: one bad link held the whole
 * answer until the server gave up and said "Could not connect". Now:
 *   - each stat gets STAT_TIMEOUT_MS (1.5s, same as the local picker in
 *     core/sessions/dir-listing.ts), the whole listing LIST_BUDGET_MS (6s);
 *   - an entry that does not answer comes back `{ type: 'unknown', timedOut:
 *     true }` (a detail stat that times out keeps the type readdir already
 *     knew), and the reply says `partial: true, timedOut: <n>`, so the server
 *     can say "listing incomplete: n entries did not answer".
 *
 * Why the stats are rationed: a hung stat holds a libuv threadpool thread (4 by
 * default) until the mount answers, and every other async file read in the
 * daemon waits for that pool. So:
 *   - at most MAX_IN_FLIGHT stats run at once (a semaphore; a hung stat keeps
 *     its slot until it settles). An entry waits for a slot while stats keep
 *     finishing (a big healthy directory just queues), and gives up once no
 *     slot has moved for STAT_TIMEOUT_MS or the listing's budget is spent;
 *   - stats are grouped by the directory they reach: a link's target directory
 *     (read with readlink, which never touches the target), or the listed
 *     directory for detail stats. A group that has not answered recently runs
 *     ONE stat at a time, so six links into one dead NAS pin one thread, not
 *     six; once that stat outlives its timeout the group is "hung" and the rest
 *     answer timed out without asking;
 *   - a hung group heals the moment its stat settles, and a group that answered
 *     in time is trusted for TRUST_MS (full concurrency). Healthy directories
 *     elsewhere never wait on a dead one.
 *
 * How each twin gets it: daemon-standalone.ts imports createFsLs;
 * daemon-source.ts inlines `createFsLs.toString()` through `__CREATE_FS_LS__`.
 * So the factory body references NOTHING at module scope.
 */

export interface FsLsDirent {
  name: string
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface FsLsStat {
  isDirectory(): boolean
  isFile(): boolean
  size: number
  mtimeMs: number
}

export interface FsLsDeps {
  readdir: (dir: string) => Promise<FsLsDirent[]>
  stat: (p: string) => Promise<FsLsStat>
  /** Reads a link's target without touching it. Without it, links are grouped by their own directory. */
  readlink?: (p: string) => Promise<string>
  statTimeoutMs?: number
  listBudgetMs?: number
  maxInFlight?: number
  trustMs?: number
  now?: () => number
}

export interface FsLsEntry {
  name: string
  type: 'dir' | 'file' | 'other' | 'unknown'
  symlink?: boolean
  size?: number
  mtimeMs?: number
  timedOut?: boolean
}

export interface FsLsResult {
  entries: FsLsEntry[]
  /** Entries that did not answer in time (0 = complete). */
  timedOut: number
}

interface Settled { st?: FsLsStat; err?: unknown }

export function createFsLs(deps: FsLsDeps) {
  var STAT_TIMEOUT_MS = deps.statTimeoutMs || 1500
  var LIST_BUDGET_MS = deps.listBudgetMs || 6000
  var MAX_IN_FLIGHT = deps.maxInFlight || 2
  var TRUST_MS = deps.trustMs || 30000
  var now = deps.now || function () { return Date.now() }

  /** Stats in flight, by full path: a hung one is reused, never restarted. */
  var pending = new Map<string, Promise<Settled>>()
  /** Stats issued and not settled (hung ones included): the semaphore count. */
  var inFlight = 0
  /** Last time a slot was taken or given back: waiters give up when nothing moves. */
  var lastProgress = 0
  var slotWaiters: Array<() => void> = []
  var groupBusy = new Map<string, number>()
  var groupWaiters = new Map<string, Array<() => void>>()
  /** Groups with a stat that outlived its timeout and has not settled, with how many. */
  var hungGroups = new Map<string, number>()
  var trustedUntil = new Map<string, number>()
  /** readdirs in flight, by dir: listing a hung dir again reuses the stuck call. */
  var pendingDirs = new Map<string, Promise<FsLsDirent[]>>()

  function sharedReaddir(dir: string): Promise<FsLsDirent[]> {
    var p = pendingDirs.get(dir)
    if (p) return p
    p = deps.readdir(dir)
    pendingDirs.set(dir, p)
    var clear = function () { pendingDirs.delete(dir) }
    p.then(clear, clear)
    return p
  }

  /** `p`'s answer, or null when it has not come by `until`. */
  function within<T>(p: Promise<T>, until: number): Promise<T | null> {
    var ms = until - now()
    if (ms <= 0) return Promise.resolve(null)
    return new Promise(function (resolve) {
      var done = false
      var timer = setTimeout(function () { if (!done) { done = true; resolve(null) } }, ms)
      p.then(function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v) } },
        function () { if (!done) { done = true; clearTimeout(timer); resolve(null) } })
    })
  }

  /** "/a/b/../c" → "/a/c"; a relative link target resolves against the link's directory. */
  function resolvePath(fromDir: string, target: string): string {
    var raw = target.charAt(0) === '/' ? target : fromDir + '/' + target
    var out: string[] = []
    var segs = raw.split('/')
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i]
      if (!s || s === '.') continue
      if (s === '..') out.pop(); else out.push(s)
    }
    return '/' + out.join('/')
  }

  function parentOf(p: string): string {
    var i = p.lastIndexOf('/')
    return i <= 0 ? '/' : p.slice(0, i)
  }

  function trusted(group: string): boolean {
    var until = trustedUntil.get(group)
    if (until === undefined) return false
    if (until > now()) return true
    trustedUntil.delete(group)
    return false
  }

  function wakeSlots(): void {
    while (slotWaiters.length > 0 && inFlight < MAX_IN_FLIGHT) {
      var w = slotWaiters.shift()
      if (w) w()
    }
  }

  function wakeGroup(group: string): void {
    var ws = groupWaiters.get(group)
    if (!ws) return
    groupWaiters.delete(group)
    for (var i = 0; i < ws.length; i++) ws[i]()
  }

  /**
   * Take a slot for one stat into `group`, or false: the group went hung, the
   * listing's `deadline` passed, or no slot moved for STAT_TIMEOUT_MS (every
   * slot is held by a hung stat).
   */
  function admit(group: string, deadline: number): Promise<boolean> {
    var waitingSince = now()
    return new Promise(function (resolve) {
      var finished = false
      var timer: ReturnType<typeof setTimeout> | null = null
      function finish(ok: boolean): void {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        resolve(ok)
      }
      function arm(): void {
        if (finished) return
        var giveUpAt = Math.min(deadline, Math.max(waitingSince, lastProgress) + STAT_TIMEOUT_MS)
        var ms = giveUpAt - now()
        if (ms <= 0) return finish(false)
        timer = setTimeout(arm, ms)
      }
      function attempt(): void {
        if (finished) return
        if (hungGroups.has(group)) return finish(false)
        if (!trusted(group) && (groupBusy.get(group) || 0) > 0) {
          var ws = groupWaiters.get(group)
          if (!ws) { ws = []; groupWaiters.set(group, ws) }
          ws.push(attempt)
          return
        }
        if (inFlight >= MAX_IN_FLIGHT) { slotWaiters.push(attempt); return }
        inFlight++
        lastProgress = now()
        groupBusy.set(group, (groupBusy.get(group) || 0) + 1)
        finish(true)
      }
      if (deadline <= now()) return finish(false)
      arm()
      attempt()
    })
  }

  function releaseSlot(group: string): void {
    inFlight--
    lastProgress = now()
    var busy = (groupBusy.get(group) || 1) - 1
    if (busy > 0) groupBusy.set(group, busy); else groupBusy.delete(group)
  }

  /** Issue a stat that already holds a slot; it keeps the slot until it settles. */
  function issue(full: string, group: string): Promise<Settled> {
    var markedHung = false
    var settledInTime = false
    var hungTimer = setTimeout(function () {
      if (settledInTime) return
      markedHung = true
      hungGroups.set(group, (hungGroups.get(group) || 0) + 1)
      wakeGroup(group)  // its waiters now answer timed out instead of waiting
    }, STAT_TIMEOUT_MS)
    var p = deps.stat(full).then(
      function (st): Settled { return { st: st } },
      function (err): Settled { return { err: err } },
    )
    pending.set(full, p)
    p.then(function () {
      pending.delete(full)
      releaseSlot(group)
      if (markedHung) {
        var h = (hungGroups.get(group) || 1) - 1
        if (h > 0) hungGroups.set(group, h); else hungGroups.delete(group)
      } else {
        settledInTime = true
        clearTimeout(hungTimer)
        trustedUntil.set(group, now() + TRUST_MS)
      }
      wakeGroup(group)
      wakeSlots()
    })
    return p
  }

  /** One entry's stat: at most STAT_TIMEOUT_MS once issued, never past the listing's `deadline`. */
  async function statWithin(full: string, group: string, deadline: number): Promise<Settled | null> {
    if (hungGroups.has(group)) return null
    var existing = pending.get(full)
    if (existing) return within(existing, Math.min(deadline, now() + STAT_TIMEOUT_MS))
    if (!(await admit(group, deadline))) return null
    var raced = pending.get(full)
    if (raced) {
      // Another listing issued it while this one waited: give the slot back.
      releaseSlot(group)
      wakeGroup(group)
      wakeSlots()
      return within(raced, Math.min(deadline, now() + STAT_TIMEOUT_MS))
    }
    return within(issue(full, group), Math.min(deadline, now() + STAT_TIMEOUT_MS))
  }

  /** The directory a link reaches (its group). Falls back to the link's own directory. */
  async function linkGroup(full: string, dir: string, deadline: number): Promise<string> {
    if (!deps.readlink) return dir
    var target = await within(deps.readlink(full), Math.min(deadline, now() + STAT_TIMEOUT_MS))
    if (typeof target !== 'string' || !target) return dir
    return parentOf(resolvePath(dir, target))
  }

  function typeOf(x: { isDirectory(): boolean; isFile(): boolean }): 'dir' | 'file' | 'other' {
    return x.isDirectory() ? 'dir' : x.isFile() ? 'file' : 'other'
  }

  async function list(dirPath: string, detail: boolean): Promise<FsLsResult> {
    var started = now()
    var deadline = started + LIST_BUDGET_MS
    var dirents = await new Promise<FsLsDirent[]>(function (resolve, reject) {
      var done = false
      var timer = setTimeout(function () {
        if (done) return
        done = true
        reject(new Error('directory did not answer within ' + Math.round(LIST_BUDGET_MS / 1000) + 's (a hung mount?)'))
      }, LIST_BUDGET_MS)
      sharedReaddir(dirPath).then(
        function (d) { if (!done) { done = true; clearTimeout(timer); resolve(d) } },
        function (e) { if (!done) { done = true; clearTimeout(timer); reject(e) } },
      )
    })
    var timedOut = 0
    var dir = resolvePath('/', dirPath)
    var base = dirPath.endsWith('/') ? dirPath : dirPath + '/'
    var entries = await Promise.all(dirents.map(async function (e): Promise<FsLsEntry> {
      var full = base + e.name
      if (e.isSymbolicLink()) {
        // Follow the link once so a linked directory lists as a dir;
        // `symlink: true` tells walkers not to descend (link loops).
        var r = await statWithin(full, await linkGroup(full, dir, deadline), deadline)
        if (!r) { timedOut++; return { name: e.name, type: 'unknown', symlink: true, timedOut: true } }
        if (!r.st) return { name: e.name, type: 'other', symlink: true } // dangling link
        var lt = typeOf(r.st)
        if (detail && lt === 'file') return { name: e.name, type: lt, symlink: true, size: r.st.size, mtimeMs: r.st.mtimeMs }
        return { name: e.name, type: lt, symlink: true }
      }
      var t = typeOf(e)
      if (!detail || t !== 'file') return { name: e.name, type: t }
      var d = await statWithin(full, dir, deadline)
      if (!d) { timedOut++; return { name: e.name, type: t, timedOut: true } }
      if (!d.st) return { name: e.name, type: t }
      return { name: e.name, type: t, size: d.st.size, mtimeMs: d.st.mtimeMs }
    }))
    return { entries: entries, timedOut: timedOut }
  }

  return { list: list }
}
