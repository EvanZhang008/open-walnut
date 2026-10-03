/**
 * Per-hunk attribution for "commit only this session's changes", shared by both
 * daemon twins and the tests.
 *
 * Several sessions (and the human) edit one working tree, so a file's diff
 * against HEAD can hold hunks from more than one writer. A session's transcript
 * records exactly what it wrote (Edit old/new strings, Write contents), so the
 * file is read as four versions:
 *
 *   H (HEAD) -> S (the file before this session wrote it) -> E (what this
 *   session's own ops produced) -> W (the working tree now)
 *
 * S is W with the session's ops reversed, newest first; E is S with them
 * replayed. E equals W unless the session Wrote the whole file and someone
 * changed it afterwards. Three line diffs (H->S, S->E, E->W) then say who put
 * each line of the H->W diff there: a line is THIS SESSION'S only when the
 * S->E step added (or removed) it and nothing after changed it. Everything else
 * is "other" (someone before or after the session) or "unknown" (the diffs
 * disagree). A hunk is the session's only when every one of its lines is: a
 * positive match, never a guess.
 *
 * Conservative rules that keep a false "mine" out:
 *   - an op the CLI answered with an error (`failed`) is skipped;
 *   - an edit is reversed only where it is certain: its new text must sit at
 *     exactly one place whose reversal leaves the old text unique (Claude Code's
 *     own rule: old_string was unique when the edit ran). Anything else is left
 *     unreversed, which can only make lines look "not this session's";
 *   - a shell command that wrote the file (`create` from a Bash `>`, `cp`,
 *     `touch`) stops the reversal: what the shell wrote is never claimed;
 *   - a diff that hit its size budget makes the whole file "unknown".
 *
 * Hunks are zero-context change regions of H->W. A region holding two writers'
 * lines is split where the owners change when the pieces stay independent (pure
 * insertions, pure deletions, or replacements whose owner runs line up), so two
 * sessions appending to the same list still get one hunk each.
 *
 * How each twin gets it: daemon-standalone.ts imports createGitAttribution;
 * daemon-source.ts inlines `createGitAttribution.toString()` through
 * `__CREATE_GIT_ATTRIBUTION__`. So the factory body references NOTHING at module
 * scope (no imports, no helpers outside it), and it carries no backticks.
 */

export type LineOwner = 'mine' | 'other' | 'unknown'
export type HunkOwner = LineOwner | 'mixed'
export type FileOwner = 'mine' | 'mixed' | 'other' | 'unknown'

/** The session ops, as session-changes-core.ts records them (structurally). */
export interface AttrOp {
  kind: 'edit' | 'write' | 'create' | 'delete' | 'rename'
  oldString?: string
  newString?: string
  replaceAll?: boolean
  content?: string
  original?: string
  from?: string
  failed?: boolean
}

/** One change region of HEAD -> working tree, with every line it carries. */
export interface CommitHunk {
  /** Stable for the same HEAD position and content. */
  id: string
  /** 0-based index of the first HEAD line it replaces (the insertion point when oldLines is empty). */
  oldStart: number
  /** HEAD lines it removes, each with its line terminator. */
  oldLines: string[]
  /** 0-based index of its first line in the working-tree file. */
  newStart: number
  newLines: string[]
  /** Order among hunks that share oldStart (a split insertion). */
  seq: number
  owner: HunkOwner
  /** Up to 3 HEAD lines above and below, for display and for locating by content. */
  before: string[]
  after: string[]
}

export interface FileAttribution {
  hunks: CommitHunk[]
  owner: FileOwner
  /** Why the file is not fully attributed: 'shell', 'partial', 'too-large', 'replay', 'untouched'. */
  reason?: string
  added: number
  removed: number
}

export interface AttributeInput {
  /** HEAD content ('' when the file is new). */
  head: string
  /** Working-tree content. */
  work: string
  /** This session's ops on the file, oldest first. Empty = not this session's file. */
  ops: AttrOp[]
  /** HEAD content of the path the session renamed this file from, if any. */
  renameBase?: string
}

/** A hunk picked for a commit (the fields applyHunks and verifyPresent read). */
export interface ChosenHunk {
  id?: string
  oldStart: number
  oldLines: string[]
  newLines: string[]
  seq?: number
  before?: string[]
  after?: string[]
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createGitAttribution(opts?: { maxD?: number; maxLines?: number }) {
  /** Edit-distance budget of one line diff; past it the file is "unknown". */
  var MAX_D = (opts && opts.maxD) || 1000
  /** Lines (HEAD + working tree) past which a file is offered whole, never by hunk. */
  var MAX_LINES = (opts && opts.maxLines) || 40000
  var CONTEXT = 3

  /** Lines keep their terminator (the last may have none), so joining them is exact. */
  function splitLines(text: string): string[] {
    var out: string[] = []
    var start = 0
    var s = String(text || '')
    for (;;) {
      var nl = s.indexOf('\n', start)
      if (nl < 0) break
      out.push(s.slice(start, nl + 1))
      start = nl + 1
    }
    if (start < s.length) out.push(s.slice(start))
    return out
  }

  function fnv(s: string, seed: number): number {
    var h = seed >>> 0
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
    return h
  }

  function hashHex(s: string): string {
    return ('00000000' + fnv(s, 2166136261).toString(16)).slice(-8) + ('00000000' + fnv(s, 3735928559).toString(16)).slice(-8)
  }

  /**
   * Myers' O(ND) diff over two int arrays (ranges [a0,a1) and [b0,b1)). Returns
   * the matched pairs as a flat [ai, bi, ...] list, or null past maxD edits.
   */
  function myers(A: Int32Array, a0: number, a1: number, B: Int32Array, b0: number, b1: number, maxD: number): number[] | null {
    var N = a1 - a0
    var M = b1 - b0
    var MAX = N + M
    var limit = Math.min(MAX, maxD)
    var off = MAX + 1
    var v = new Int32Array(2 * MAX + 3)
    var trace: Int32Array[] = []
    for (var d = 0; d <= limit; d++) {
      // v[k] for k in [-d-1, d+1], read back by the backtrack at index k + d + 1.
      trace.push(v.slice(off - d - 1, off + d + 2))
      for (var k = -d; k <= d; k += 2) {
        var x: number
        if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1]
        else x = v[off + k - 1] + 1
        var y = x - k
        while (x < N && y < M && A[a0 + x] === B[b0 + y]) { x++; y++ }
        v[off + k] = x
        if (x >= N && y >= M) {
          var pairs: number[] = []
          var cx = N
          var cy = M
          for (var bd = d; bd >= 0; bd--) {
            var snap = trace[bd]
            var ck = cx - cy
            var prevK: number
            if (ck === -bd || (ck !== bd && snap[ck - 1 + bd + 1] < snap[ck + 1 + bd + 1])) prevK = ck + 1
            else prevK = ck - 1
            var prevX = snap[prevK + bd + 1]
            var prevY = prevX - prevK
            while (cx > prevX && cy > prevY) { cx--; cy--; pairs.push(a0 + cx, b0 + cy) }
            if (bd > 0) { cx = prevX; cy = prevY }
          }
          return pairs
        }
      }
    }
    return null
  }

  /** Line alignment of a -> b: each side's matched index on the other, or -1. */
  function diffMaps(a: string[], b: string[]): { aToB: Int32Array; bToA: Int32Array; exact: boolean } {
    var ids = new Map<string, number>()
    var A = new Int32Array(a.length)
    var B = new Int32Array(b.length)
    for (var i = 0; i < a.length; i++) {
      var ka = ids.get(a[i])
      if (ka === undefined) { ka = ids.size; ids.set(a[i], ka) }
      A[i] = ka
    }
    for (var j = 0; j < b.length; j++) {
      var kb = ids.get(b[j])
      if (kb === undefined) { kb = ids.size; ids.set(b[j], kb) }
      B[j] = kb
    }
    var aToB = new Int32Array(a.length).fill(-1)
    var bToA = new Int32Array(b.length).fill(-1)
    var n = a.length
    var m = b.length
    var pre = 0
    while (pre < n && pre < m && A[pre] === B[pre]) { aToB[pre] = pre; bToA[pre] = pre; pre++ }
    var suf = 0
    while (suf < n - pre && suf < m - pre && A[n - 1 - suf] === B[m - 1 - suf]) {
      aToB[n - 1 - suf] = m - 1 - suf
      bToA[m - 1 - suf] = n - 1 - suf
      suf++
    }
    var exact = true
    if (n - pre - suf > 0 && m - pre - suf > 0) {
      var pairs = myers(A, pre, n - suf, B, pre, m - suf, MAX_D)
      if (pairs === null) exact = false
      else for (var p = 0; p < pairs.length; p += 2) { aToB[pairs[p]] = pairs[p + 1]; bToA[pairs[p + 1]] = pairs[p] }
    }
    return { aToB: aToB, bToA: bToA, exact: exact }
  }

  /** Zero-context change regions between matched lines (aToB must be monotonic). */
  function gaps(aToB: Int32Array, n: number, m: number): Array<{ oldStart: number; oldEnd: number; newStart: number; newEnd: number }> {
    var out: Array<{ oldStart: number; oldEnd: number; newStart: number; newEnd: number }> = []
    var lastI = 0
    var lastJ = 0
    for (var i = 0; i < n; i++) {
      var j = aToB[i]
      if (j < 0) continue
      if (i > lastI || j > lastJ) out.push({ oldStart: lastI, oldEnd: i, newStart: lastJ, newEnd: j })
      lastI = i + 1
      lastJ = j + 1
    }
    if (lastI < n || lastJ < m) out.push({ oldStart: lastI, oldEnd: n, newStart: lastJ, newEnd: m })
    return out
  }

  /** Non-overlapping occurrences of s in t, left to right, at most `cap` (+1 to tell "more"). */
  function occurrences(t: string, s: string, cap: number): number[] {
    var out: number[] = []
    if (!s) return out
    var from = 0
    for (;;) {
      var at = t.indexOf(s, from)
      if (at < 0 || out.length > cap) break
      out.push(at)
      from = at + s.length
    }
    return out
  }

  /** Every start position of s in t (overlapping), at most `cap` + 1. */
  function starts(t: string, s: string, cap: number): number[] {
    var out: number[] = []
    if (!s) return out
    var from = 0
    for (;;) {
      var at = t.indexOf(s, from)
      if (at < 0 || out.length > cap) break
      out.push(at)
      from = at + 1
    }
    return out
  }

  /**
   * Reverse one edit on `t`: put old_string back where new_string is. Returns
   * the reversed text and where old_string now sits, `{ noop }` for an edit that
   * changed nothing, or null when the reversal is not certain.
   */
  function reverseEdit(t: string, op: AttrOp): { text: string; positions: number[] } | { noop: true } | null {
    var oldS = typeof op.oldString === 'string' ? op.oldString : ''
    var newS = typeof op.newString === 'string' ? op.newString : ''
    if (oldS === newS) return { noop: true }
    // A pure deletion leaves nothing to find.
    if (newS === '') return null
    if (oldS === '') return t === newS ? { text: '', positions: [0] } : null
    if (op.replaceAll) {
      var all = occurrences(t, newS, 100000)
      if (all.length === 0) return null
      var built = ''
      var last = 0
      var positions: number[] = []
      for (var i = 0; i < all.length; i++) {
        built += t.slice(last, all[i])
        positions.push(built.length)
        built += oldS
        last = all[i] + newS.length
      }
      built += t.slice(last)
      return { text: built, positions: positions }
    }
    var cands = starts(t, newS, 32)
    if (cands.length === 0 || cands.length > 32) return null
    var hit = -1
    var hitText = ''
    for (var c = 0; c < cands.length; c++) {
      var r = t.slice(0, cands[c]) + oldS + t.slice(cands[c] + newS.length)
      if (occurrences(r, oldS, 2).length === 1) {
        if (hit >= 0) return null
        hit = cands[c]
        hitText = r
      }
    }
    if (hit < 0) return null
    return { text: hitText, positions: [hit] }
  }

  /** Forward-apply one edit by search (after a Write, where recorded positions no longer hold). */
  function applyBySearch(t: string, op: AttrOp): string | null {
    var oldS = typeof op.oldString === 'string' ? op.oldString : ''
    var newS = typeof op.newString === 'string' ? op.newString : ''
    if (oldS === newS) return t
    if (oldS === '') return t === '' ? newS : null
    if (op.replaceAll) return t.indexOf(oldS) < 0 ? null : t.split(oldS).join(newS)
    var occ = occurrences(t, oldS, 2)
    if (occ.length !== 1) return null
    return t.slice(0, occ[0]) + newS + t.slice(occ[0] + oldS.length)
  }

  interface ReplayStep { kind: 'edit' | 'write'; op: AttrOp; positions?: number[] }

  /**
   * S and E for one file: reverse the ops from the working tree, newest first,
   * then replay what was reversed. `headText` stands in for the file the session
   * deleted before writing it again.
   */
  function replay(work: string, ops: AttrOp[], headText: string): {
    S: string; E: string; partial: boolean; shell: boolean; eOk: boolean; renamedFrom: string | null; steps: number
  } {
    var t = work
    var steps: ReplayStep[] = []
    var partial = false
    var shell = false
    var sawWrite = false
    var startOverride: string | null = null
    var renamedFrom: string | null = null
    for (var i = ops.length - 1; i >= 0; i--) {
      var op = ops[i]
      if (!op || op.failed) continue
      if (op.kind === 'edit') {
        var r = reverseEdit(t, op)
        if (r === null) { partial = true; continue }
        if ('noop' in r) continue
        steps.push({ kind: 'edit', op: op, positions: r.positions })
        t = r.text
      } else if (op.kind === 'write') {
        if (typeof op.content !== 'string') { partial = true; break }
        steps.push({ kind: 'write', op: op })
        sawWrite = true
        t = typeof op.original === 'string' ? op.original : ''
      } else if (op.kind === 'create') {
        // A shell command wrote the file: what it wrote is not claimed.
        shell = true
        break
      } else if (op.kind === 'delete') {
        // Deleted, then written again: the deleted file is taken as HEAD's.
        if (i < ops.length - 1) startOverride = headText
        break
      } else if (op.kind === 'rename') {
        if (renamedFrom === null && typeof op.from === 'string') renamedFrom = op.from
      }
    }
    var S = startOverride !== null ? startOverride : t
    if (!sawWrite && startOverride === null) return { S: S, E: work, partial: partial, shell: shell, eOk: true, renamedFrom: renamedFrom, steps: steps.length }
    // Replay oldest first. Until the first Write the reversal's positions hold
    // exactly; after it the text differs from what the reversal saw, so edits
    // are found by their (unique) old text instead.
    var e = S
    var bySearch = startOverride !== null
    var ok = true
    for (var s = steps.length - 1; s >= 0; s--) {
      var st = steps[s]
      if (st.kind === 'write') { e = st.op.content as string; bySearch = true; continue }
      if (bySearch) {
        var next = applyBySearch(e, st.op)
        if (next === null) { ok = false; break }
        e = next
      } else {
        var oldS = st.op.oldString || ''
        var newS = st.op.newString || ''
        var pos = (st.positions || []).slice().sort(function (x, y) { return y - x })
        for (var q = 0; q < pos.length; q++) e = e.slice(0, pos[q]) + newS + e.slice(pos[q] + oldS.length)
      }
    }
    return { S: S, E: e, partial: partial, shell: shell, eOk: ok, renamedFrom: renamedFrom, steps: steps.length }
  }

  function runsOf(owners: LineOwner[]): Array<{ owner: LineOwner; start: number; end: number }> {
    var out: Array<{ owner: LineOwner; start: number; end: number }> = []
    for (var i = 0; i < owners.length; i++) {
      var last = out[out.length - 1]
      if (last && last.owner === owners[i]) last.end = i + 1
      else out.push({ owner: owners[i], start: i, end: i + 1 })
    }
    return out
  }

  function sameOwners(a: Array<{ owner: LineOwner }>, b: Array<{ owner: LineOwner }>): boolean {
    if (a.length !== b.length) return false
    for (var i = 0; i < a.length; i++) if (a[i].owner !== b[i].owner) return false
    return true
  }

  function makeHunk(H: string[], W: string[], oldStart: number, oldEnd: number, newStart: number, newEnd: number, seq: number, owner: HunkOwner): CommitHunk {
    var oldLines = H.slice(oldStart, oldEnd)
    var newLines = W.slice(newStart, newEnd)
    return {
      id: hashHex(oldStart + ':' + (oldEnd - oldStart) + ':' + seq + '\u0000' + oldLines.join('') + '\u0000' + newLines.join('')),
      oldStart: oldStart, oldLines: oldLines, newStart: newStart, newLines: newLines, seq: seq, owner: owner,
      before: H.slice(Math.max(0, oldStart - CONTEXT), oldStart),
      after: H.slice(oldEnd, oldEnd + CONTEXT),
    }
  }

  /** Split one change region where its owners change, when the pieces stay independent. */
  function splitRegion(
    H: string[], W: string[],
    g: { oldStart: number; oldEnd: number; newStart: number; newEnd: number },
    ownH: LineOwner[], ownW: LineOwner[],
  ): CommitHunk[] {
    var rem = runsOf(ownH.slice(g.oldStart, g.oldEnd))
    var add = runsOf(ownW.slice(g.newStart, g.newEnd))
    var out: CommitHunk[] = []
    var o0 = g.oldStart
    var n0 = g.newStart
    var i: number
    if (rem.length === 0) {
      for (i = 0; i < add.length; i++) out.push(makeHunk(H, W, o0, o0, n0 + add[i].start, n0 + add[i].end, i, add[i].owner))
      return out
    }
    if (add.length === 0) {
      for (i = 0; i < rem.length; i++) out.push(makeHunk(H, W, o0 + rem[i].start, o0 + rem[i].end, n0, n0, 0, rem[i].owner))
      return out
    }
    if (sameOwners(rem, add)) {
      for (i = 0; i < rem.length; i++) out.push(makeHunk(H, W, o0 + rem[i].start, o0 + rem[i].end, n0 + add[i].start, n0 + add[i].end, 0, rem[i].owner))
      return out
    }
    if (rem.length === 1 && add[0].owner === rem[0].owner) {
      // The replacement first, then insertions after the replaced lines.
      out.push(makeHunk(H, W, g.oldStart, g.oldEnd, n0 + add[0].start, n0 + add[0].end, 0, rem[0].owner))
      for (i = 1; i < add.length; i++) out.push(makeHunk(H, W, g.oldEnd, g.oldEnd, n0 + add[i].start, n0 + add[i].end, i - 1, add[i].owner))
      return out
    }
    if (rem.length === 1 && add[add.length - 1].owner === rem[0].owner) {
      // Insertions before the replaced lines, then the replacement (same oldStart, later seq).
      for (i = 0; i < add.length - 1; i++) out.push(makeHunk(H, W, g.oldStart, g.oldStart, n0 + add[i].start, n0 + add[i].end, i, add[i].owner))
      var la = add[add.length - 1]
      out.push(makeHunk(H, W, g.oldStart, g.oldEnd, n0 + la.start, n0 + la.end, add.length - 1, rem[0].owner))
      return out
    }
    if (add.length === 1 && rem[0].owner === add[0].owner) {
      // The first removed run goes with the insertion; the rest are deletions.
      out.push(makeHunk(H, W, o0 + rem[0].start, o0 + rem[0].end, g.newStart, g.newEnd, 0, add[0].owner))
      for (i = 1; i < rem.length; i++) out.push(makeHunk(H, W, o0 + rem[i].start, o0 + rem[i].end, g.newEnd, g.newEnd, 0, rem[i].owner))
      return out
    }
    if (add.length === 1 && rem[rem.length - 1].owner === add[0].owner) {
      for (i = 0; i < rem.length - 1; i++) out.push(makeHunk(H, W, o0 + rem[i].start, o0 + rem[i].end, g.newStart, g.newStart, 0, rem[i].owner))
      var lr = rem[rem.length - 1]
      out.push(makeHunk(H, W, o0 + lr.start, o0 + lr.end, g.newStart, g.newEnd, 0, add[0].owner))
      return out
    }
    out.push(makeHunk(H, W, g.oldStart, g.oldEnd, g.newStart, g.newEnd, 0, 'mixed'))
    return out
  }

  function summarize(hunks: CommitHunk[]): FileOwner {
    if (hunks.length === 0) return 'other'
    var mine = 0
    var other = 0
    for (var i = 0; i < hunks.length; i++) {
      if (hunks[i].owner === 'mine') mine++
      else if (hunks[i].owner === 'other') other++
    }
    if (mine === hunks.length) return 'mine'
    if (mine > 0) return 'mixed'
    return other === hunks.length ? 'other' : 'unknown'
  }

  /** Whether a file is too large to offer by hunk. */
  function tooLarge(head: string, work: string): boolean {
    return head.length + work.length > 8 * 1024 * 1024
  }

  /** The hunks of HEAD -> working tree with an owner on each. */
  function attribute(input: AttributeInput): FileAttribution {
    var head = String(input.head || '')
    var work = String(input.work || '')
    var ops = Array.isArray(input.ops) ? input.ops : []
    var H = splitLines(head)
    var W = splitLines(work)
    if (H.length + W.length > MAX_LINES || tooLarge(head, work)) return { hunks: [], owner: ops.length ? 'unknown' : 'other', reason: 'too-large', added: 0, removed: 0 }
    var hw = diffMaps(H, W)
    var regions = gaps(hw.aToB, H.length, W.length)
    var ownH: LineOwner[] = new Array(H.length)
    var ownW: LineOwner[] = new Array(W.length)
    var reason: string | undefined
    var k: number
    var live = ops.filter(function (o) { return o && !o.failed })
    if (live.length === 0) {
      for (k = 0; k < H.length; k++) ownH[k] = 'other'
      for (k = 0; k < W.length; k++) ownW[k] = 'other'
      reason = 'untouched'
    } else {
      var base = typeof input.renameBase === 'string' ? input.renameBase : null
      var rep = replay(work, live, base !== null ? base : head)
      if (!rep.eOk || !hw.exact) {
        for (k = 0; k < H.length; k++) ownH[k] = 'unknown'
        for (k = 0; k < W.length; k++) ownW[k] = 'unknown'
        reason = !hw.exact ? 'too-large' : 'replay'
      } else {
        var Hb = base !== null ? splitLines(base) : H
        var S = splitLines(rep.S)
        var E = splitLines(rep.E)
        var hs = diffMaps(Hb, S)
        var se = diffMaps(S, E)
        var ew = diffMaps(E, W)
        if (!hs.exact || !se.exact || !ew.exact) {
          for (k = 0; k < H.length; k++) ownH[k] = 'unknown'
          for (k = 0; k < W.length; k++) ownW[k] = 'unknown'
          reason = 'too-large'
        } else {
          for (k = 0; k < W.length; k++) {
            var e = ew.bToA[k]
            if (e < 0) { ownW[k] = 'other'; continue }
            var s = se.bToA[e]
            if (s < 0) { ownW[k] = 'mine'; continue }
            var h = hs.bToA[s]
            if (h < 0) { ownW[k] = 'other'; continue }
            // Unchanged all the way, yet added in HEAD -> W: the diffs disagree,
            // unless the session moved the file here from the rename base.
            ownW[k] = base !== null && rep.renamedFrom !== null ? 'mine' : 'unknown'
          }
          for (k = 0; k < H.length; k++) {
            if (base !== null) { ownH[k] = 'unknown'; continue }
            var s2 = hs.aToB[k]
            if (s2 < 0) { ownH[k] = 'other'; continue }
            var e2 = se.aToB[s2]
            if (e2 < 0) { ownH[k] = 'mine'; continue }
            var w2 = ew.aToB[e2]
            ownH[k] = w2 < 0 ? 'other' : 'unknown'
          }
          if (rep.shell) reason = 'shell'
          else if (rep.partial) reason = 'partial'
        }
      }
    }
    var hunks: CommitHunk[] = []
    var added = 0
    var removed = 0
    for (var gi = 0; gi < regions.length; gi++) {
      var g = regions[gi]
      added += g.newEnd - g.newStart
      removed += g.oldEnd - g.oldStart
      var pieces = splitRegion(H, W, g, ownH, ownW)
      for (var pi = 0; pi < pieces.length; pi++) hunks.push(pieces[pi])
    }
    var out: FileAttribution = { hunks: hunks, owner: live.length === 0 ? 'other' : summarize(hunks), added: added, removed: removed }
    if (reason) out.reason = reason
    return out
  }

  /** The unsplit change regions of HEAD -> working tree (commit-time check). */
  function rawRegions(head: string, work: string): { H: string[]; W: string[]; regions: Array<{ oldStart: number; oldEnd: number; newStart: number; newEnd: number }>; exact: boolean } {
    var H = splitLines(head)
    var W = splitLines(work)
    var hw = diffMaps(H, W)
    return { H: H, W: W, regions: gaps(hw.aToB, H.length, W.length), exact: hw.exact }
  }

  function matchesAt(lines: string[], at: number, want: string[]): boolean {
    if (at < 0 || at + want.length > lines.length) return false
    for (var i = 0; i < want.length; i++) if (lines[at + i] !== want[i]) return false
    return true
  }

  /** Context agrees (shorter context at a file edge is fine, a mismatch is not). */
  function contextAt(lines: string[], at: number, oldCount: number, h: ChosenHunk): boolean {
    var before = h.before || []
    var after = h.after || []
    var bStart = at - before.length
    if (bStart < 0) return false
    if (!matchesAt(lines, bStart, before)) return false
    var aStart = at + oldCount
    if (aStart + after.length > lines.length) return false
    return matchesAt(lines, aStart, after)
  }

  /**
   * Where a chosen hunk applies in HEAD, by content: at its recorded line when
   * the lines (and, for an insertion, its context) are there, else the one place
   * whose context and old lines match. -1 when none or several match.
   */
  function locate(H: string[], h: ChosenHunk): number {
    var oldLines = h.oldLines || []
    if (matchesAt(H, h.oldStart, oldLines) && (oldLines.length > 0 || contextAt(H, h.oldStart, 0, h))) return h.oldStart
    if (!(h.before && h.before.length) && !(h.after && h.after.length) && oldLines.length === 0) return H.length === 0 ? 0 : -1
    var found = -1
    for (var p = 0; p <= H.length; p++) {
      if (!matchesAt(H, p, oldLines) || !contextAt(H, p, oldLines.length, h)) continue
      if (found >= 0) return -1
      found = p
    }
    return found
  }

  /** HEAD plus the chosen hunks, applied by content. */
  function applyHunks(head: string, chosen: ChosenHunk[]): { text: string } | { error: 'content' | 'overlap'; id?: string } {
    var H = splitLines(head)
    var placed: Array<{ at: number; h: ChosenHunk }> = []
    for (var i = 0; i < chosen.length; i++) {
      var at = locate(H, chosen[i])
      if (at < 0) return { error: 'content', id: chosen[i].id }
      placed.push({ at: at, h: chosen[i] })
    }
    placed.sort(function (x, y) { return x.at - y.at || (x.h.seq || 0) - (y.h.seq || 0) })
    var out: string[] = []
    var cursor = 0
    for (var j = 0; j < placed.length; j++) {
      var pl = placed[j]
      if (pl.at < cursor) return { error: 'overlap', id: pl.h.id }
      for (var c = cursor; c < pl.at; c++) out.push(H[c])
      for (var nl = 0; nl < pl.h.newLines.length; nl++) out.push(pl.h.newLines[nl])
      cursor = pl.at + (pl.h.oldLines || []).length
    }
    for (var r = cursor; r < H.length; r++) out.push(H[r])
    return { text: out.join('') }
  }

  function indexOfRun(hay: string[], needle: string[]): number {
    if (needle.length === 0) return 0
    for (var i = 0; i + needle.length <= hay.length; i++) if (matchesAt(hay, i, needle)) return i
    return -1
  }

  /**
   * The chosen hunks are still part of the working tree's change: each sits
   * inside one current change region, with its new lines among that region's.
   * Returns the ids (or indexes) that are not.
   */
  function verifyPresent(head: string, work: string, chosen: ChosenHunk[]): string[] {
    var rr = rawRegions(head, work)
    var missing: string[] = []
    for (var i = 0; i < chosen.length; i++) {
      var h = chosen[i]
      var oldCount = (h.oldLines || []).length
      var at = locate(rr.H, h)
      var ok = false
      if (at >= 0) {
        for (var g = 0; g < rr.regions.length && !ok; g++) {
          var reg = rr.regions[g]
          if (at < reg.oldStart || at + oldCount > reg.oldEnd) continue
          if (indexOfRun(rr.W.slice(reg.newStart, reg.newEnd), h.newLines || []) >= 0) ok = true
        }
      }
      if (!ok) missing.push(h.id || String(i))
    }
    return missing
  }

  return { splitLines: splitLines, diffMaps: diffMaps, replay: replay, attribute: attribute, applyHunks: applyHunks, verifyPresent: verifyPresent, rawRegions: rawRegions, hashHex: hashHex }
}

// Pure methods for the server and the tests.
var pure = createGitAttribution()
export const attributeFile = pure.attribute
export const applyChosenHunks = pure.applyHunks
export const verifyChosenPresent = pure.verifyPresent
export const splitFileLines = pure.splitLines
export const lineDiffMaps = pure.diffMaps
export const replaySessionOps = pure.replay
