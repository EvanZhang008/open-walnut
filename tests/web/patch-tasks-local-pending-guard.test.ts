/**
 * Guard: every `patchTasksLocal(` call in web/src says whether its write is still out.
 *
 * `patchTasksLocal` (web/src/hooks/useTasks.ts) writes task rows locally. When the
 * write that patch stands for has not been answered yet, the call must pass
 * `{ pending: true }` and run the returned settle once the write answers or fails:
 * otherwise a task list read that left after the patch but was answered before the
 * write landed draws the old values back (1971accf7: a project rename's rows jumped
 * back under the old name; then the Focus Bar's reorder, whose pin_order has no
 * per-task event, kept the old order until the next list read).
 *
 * The class, enumerated from the source: every `patchTasksLocal(` call outside
 * comments, keyed by file and the function it sits in. Each one is listed below
 * with `pending` (its write is still out) or not, and why. A new call fails until it
 * is listed; a listed call whose `pending` no longer matches the source fails too.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const WEB_SRC = join(__dirname, '../../web/src')

interface Site { file: string; in: string; pending: boolean; why: string }

const SITES: Site[] = [
  // ── web/src/hooks/useFocusBar.ts ──
  { file: 'hooks/useFocusBar.ts', in: 'applyFocusData', pending: false, why: 'applies a server snapshot already answered; no write of its own is out' },
  { file: 'hooks/useFocusBar.ts', in: 'pin', pending: true, why: 'the pin write is out until pinTask answers; settled in heldWrite' },
  { file: 'hooks/useFocusBar.ts', in: 'pin', pending: false, why: 'rollback after the failed pin, made after its settle' },
  { file: 'hooks/useFocusBar.ts', in: 'unpin', pending: true, why: 'the unpin write is out until unpinTask answers; settled in heldWrite' },
  { file: 'hooks/useFocusBar.ts', in: 'reorder', pending: true, why: 'the reorder write is out until reorderPinnedTasks answers; settled in heldWrite' },
  { file: 'hooks/useFocusBar.ts', in: 'setTier', pending: true, why: 'the reorder and tier writes are out until setTaskTier answers; settled in heldWrite' },
  { file: 'hooks/useFocusBar.ts', in: 'setTierBulk', pending: true, why: 'the batch write is out until setTierBulk answers; settled in heldWrite' },
  { file: 'hooks/useFocusBar.ts', in: 'setTierBulk', pending: false, why: 'rollback after the failed batch, made after its settle' },
  { file: 'hooks/useFocusBar.ts', in: 'addLocalPin', pending: false, why: 'a temp row no server list carries; the create that holds the pin is its own write' },
  { file: 'hooks/useFocusBar.ts', in: 'replaceLocalPinId', pending: false, why: 'runs once the create is answered (its response or its broadcast), so no write is out' },
  { file: 'hooks/useFocusBar.ts', in: 'removeLocalPin', pending: false, why: 'rollback after the create failed; nothing is out' },
  // ── web/src/components/tasks/PhoneTaskDetailHead.tsx ──
  { file: 'components/tasks/PhoneTaskDetailHead.tsx', in: 'commit', pending: false, why: 'patched after the title write answered' },
  // ── web/src/components/tasks/ProjectDetailPane.tsx ──
  { file: 'components/tasks/ProjectDetailPane.tsx', in: 'handleDelete', pending: true, why: 'the project delete is out until deleteProject answers; settled on both paths' },
  { file: 'components/tasks/ProjectDetailPane.tsx', in: 'handleDelete', pending: false, why: 'rollback after the failed delete, made after its settle' },
  // ── web/src/hooks/useProjectActions.ts ──
  { file: 'hooks/useProjectActions.ts', in: 'moveLoadedTasks', pending: true, why: 'the rename or delete is out until it answers; the caller settles it' },
  { file: 'hooks/useProjectActions.ts', in: 'moveLoadedTasks', pending: false, why: 'the undo, made after its settle' },
  // ── web/src/undo/TaskUndoContext.tsx ──
  { file: 'undo/TaskUndoContext.tsx', in: 'setStartDate', pending: true, why: "a snooze's Undo: the start date write is out until update answers; settled on both paths" },
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

/** Blank out comments (keeping offsets and newlines) so a call named in prose is no call. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length))
}

/** The text of the call starting at `open` (the index of its `(`), parens balanced. */
function callText(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

/** A function declaration line: `const x = useCallback(`, `const x = (`, `const x = async (`, `function x(`. */
const DECL = /^\s*(?:export\s+)?(?:const\s+(\w+)\s*=\s*(?:useCallback\(\s*)?(?:async\s*)?\(|(?:async\s+)?function\s+(\w+)\s*[<(])/

/** The nearest function declared above the call whose body is still open at it. */
function enclosing(lines: string[], lineIndex: number, column: number): string {
  for (let i = lineIndex; i >= 0; i--) {
    const m = DECL.exec(lines[i])
    if (!m) continue
    const between = [...lines.slice(i, lineIndex), lines[lineIndex].slice(0, column)].join('\n')
    let depth = 0
    for (const ch of between) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0
    if (depth > 0) return m[1] ?? m[2]
  }
  return '<module>'
}

function found(): Array<Omit<Site, 'why'>> {
  const out: Array<Omit<Site, 'why'>> = []
  for (const path of sourceFiles(WEB_SRC)) {
    const src = stripComments(readFileSync(path, 'utf8'))
    if (!src.includes('patchTasksLocal(')) continue
    const lines = src.split('\n')
    const file = relative(WEB_SRC, path)
    const re = /patchTasksLocal\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const open = m.index + 'patchTasksLocal'.length
      const before = src.slice(0, m.index)
      const lineIndex = before.split('\n').length - 1
      const column = m.index - (before.lastIndexOf('\n') + 1)
      out.push({ file, in: enclosing(lines, lineIndex, column), pending: /pending\s*:\s*true/.test(callText(src, open)) })
    }
  }
  return out
}

const key = (s: Omit<Site, 'why'>) => `${s.file} :: ${s.in} :: ${s.pending ? 'pending' : 'not pending'}`

function tally(sites: Array<Omit<Site, 'why'>>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of sites) counts.set(key(s), (counts.get(key(s)) ?? 0) + 1)
  return counts
}

describe('patchTasksLocal call sites', () => {
  it('finds the calls (the scan itself works)', () => {
    expect(found().length).toBeGreaterThanOrEqual(10)
  })

  it('every call is listed with whether its write is still out, and every listing still exists', () => {
    const actual = tally(found())
    const listed = tally(SITES)
    const unlisted = [...actual].filter(([k, n]) => (listed.get(k) ?? 0) < n).map(([k, n]) => `${k} (x${n - (listed.get(k) ?? 0)})`)
    const stale = [...listed].filter(([k, n]) => (actual.get(k) ?? 0) < n).map(([k, n]) => `${k} (x${n - (actual.get(k) ?? 0)})`)
    expect(unlisted, 'patchTasksLocal call(s) not in SITES: if the write this patch stands for is still out, pass { pending: true } and settle on every path, then list it with why').toEqual([])
    expect(stale, 'SITES entries no call matches any more (removed, moved to another function, or pending changed)').toEqual([])
  })

  it('every listing says why', () => {
    for (const s of SITES) expect(s.why.length, key(s)).toBeGreaterThan(15)
  })
})
