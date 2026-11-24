/**
 * No component keeps its own minute tick in state: time labels read the one shared minute clock.
 *
 * 2026-11-23 (task 9bceb9f2): on the Mac app with about 1,169 tasks, the Org page's root
 * (useMinuteNow), Home's task list (TodoPanel's `_tick`), the Dashboard, the task views and the
 * Tasks table each set a counter in their own state every 60 s, so every minute the whole page
 * drew again, 100 to 470 ms of main thread, to move a few "5m ago" labels. They now read
 * web/src/utils/minute-clock.ts: the small component that shows the time subscribes
 * (useMinuteNow), or redraws only when what it shows changed (useMinuteValue), and a filter that
 * moves with the clock is worked out again only when the clock moves a task in or out of it
 * (clockKey, timeWindowKey).
 *
 * The class: a timer with a minute period (setInterval, visibleInterval, a self-arming setTimeout,
 * a tick hook such as useServerTick(on, 60_000)) whose callback sets React state. Members are found
 * from the source of web/src. Each one left is pinned below with why it is not a page or list
 * redraw; a new one fails: read the shared clock instead.
 * The browser guard is tests/e2e/browser/org-home-redraw-budget.spec.ts (what a minute draws).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const WEB = path.join(ROOT, 'web/src')

/** The minute ticks left, each with why it may stay. */
const PINNED: Record<string, string> = {
  // A settings card's retry countdown on the server's own clock (skew corrected, useHostStatus
  // serverNow), not the browser's: the shared clock cannot stand in for it, and it draws one card.
  'web/src/components/settings/sections/RemoteHostReadiness.tsx': 'server clock, one settings card',
  // A poll of the vault's lock state behind its socket event: it sets state only when that state
  // changed (it keeps `cur` otherwise), so a quiet minute draws nothing. Not a clock.
  'web/src/components/passwords/PasswordsApp.tsx': 'a status poll that keeps an unchanged state',
}

const MINUTE = /\b60_000\b|\b60000\b|\b60\s*\*\s*1000\b|\bMINUTE_MS\b|\bONE_MINUTE(?:_MS)?\b/
const TIMER = /\b(setInterval|visibleInterval|setTimeout|useServerTick|useNow|useInterval)\s*\(/g
const SETS_STATE = /\bset[A-Z]\w*\s*\(/

/** The source without comments, its lines kept (the hits name a line). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

/** The call's argument text, from its open parenthesis to the matching close. */
function argsAt(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]!
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1) }
  }
  return src.slice(open)
}

/** The body of a function named `name` in the file (a `const name = ...` or `function name`), for a timer handed it by name. */
function bodyOf(src: string, name: string): string {
  const m = new RegExp(`(?:const|let|function)\\s+${name}\\b[^=({]*(?:=|\\()`).exec(src)
  if (!m) return ''
  const from = src.indexOf('{', m.index)
  const arrow = src.indexOf('=>', m.index)
  // `const tick = () => setNow(...)`: no braces, the expression to the line's end.
  if (arrow !== -1 && (from === -1 || arrow < from) && !/^\s*\{/.test(src.slice(arrow + 2))) return src.slice(arrow, src.indexOf('\n', arrow))
  return from === -1 ? '' : argsAt(src, from)
}

function minuteTicks(root = WEB): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(e.name) || /\.test\./.test(e.name)) continue
      const src = code(fs.readFileSync(p, 'utf8'))
      for (const m of src.matchAll(TIMER)) {
        const args = argsAt(src, m.index! + m[0].length - 1)
        if (!MINUTE.test(args)) continue
        const named = /^\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(args)?.[1]
        const hook = m[1]!.startsWith('use')
        if (hook || SETS_STATE.test(args) || (named && SETS_STATE.test(bodyOf(src, named)))) {
          out.push(`${path.relative(ROOT, p).split(path.sep).join('/')}:${src.slice(0, m.index).split('\n').length}`)
        }
      }
    }
  }
  walk(root)
  return out.sort()
}

describe('minute ticks held in component state (web/src)', () => {
  const found = minuteTicks()

  it('finds a minute tick in each form it looks for (so the scan reads what it should)', () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'minute-tick-'))
    try {
      fs.writeFileSync(path.join(dir, 'a.tsx'), 'useEffect(() => visibleInterval(() => setTick((t) => t + 1), 60_000), []);\n')
      fs.writeFileSync(path.join(dir, 'b.tsx'), 'const tick = () => setNow(Date.now());\nconst id = setInterval(tick, 60_000);\n')
      fs.writeFileSync(path.join(dir, 'c.ts'), 'timer = setTimeout(() => { setMinute(Math.floor(Date.now() / MINUTE_MS)); arm(); }, MINUTE_MS - (Date.now() % MINUTE_MS));\n')
      fs.writeFileSync(path.join(dir, 'd.tsx'), 'const minute = useServerTick(on, 60_000);\n')
      // Not members: a minute reload that sets no state here, and a 30 s tick.
      fs.writeFileSync(path.join(dir, 'e.tsx'), 'const t = setInterval(() => { void load(); }, 60_000);\nsetInterval(() => setNow(Date.now()), 30_000);\n')
      const hits = minuteTicks(dir).map((h) => h.replace(/^.*\//, ''))
      expect(hits).toEqual(['a.tsx:1', 'b.tsx:2', 'c.ts:1', 'd.tsx:1'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('has no minute tick outside the pinned ones: read web/src/utils/minute-clock.ts instead', () => {
    const fresh = found.filter((hit) => !PINNED[hit.replace(/:\d+$/, '')])
    expect(fresh, 'a component keeps its own minute tick in state, so each minute draws it and everything under it: use useMinuteNow / useMinuteValue (web/src/utils/minute-clock.ts) in the label that shows the time').toEqual([])
  })

  it('every pinned file still has its tick (remove the pin once it is gone)', () => {
    for (const f of Object.keys(PINNED)) expect(found.some((hit) => hit.startsWith(`${f}:`)), f).toBe(true)
  })

  it('Home\'s memoized task row reads no clock at its render: its date pills do (TaskDatePills)', () => {
    // A memo'd row drawn once kept "→ 3m" and a due pill short of Overdue until something else drew
    // it (review 2026-11-24): the time-dependent part lives in TaskDatePills, on the minute clock.
    const src = code(fs.readFileSync(path.join(ROOT, 'web/src/components/tasks/TodoPanel.tsx'), 'utf8'))
    const at = src.indexOf('const TaskRowBody = memo(function TaskRowBody(')
    expect(at).toBeGreaterThan(-1)
    const body = argsAt(src, src.indexOf('{', src.indexOf(')', src.indexOf('}: TaskRowBodyProps', at))))
    expect(body).toContain('<TaskDatePills')
    expect(body).not.toMatch(/\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bisOverdue\s*\(|\bformatDateDisplay\s*\(/)
  })

  it('the pages and lists of 2026-11-23 read the shared clock', () => {
    for (const f of ['web/src/pages/OrgPage.tsx', 'web/src/components/tasks/TodoPanel.tsx', 'web/src/pages/DashboardPage.tsx', 'web/src/components/tasks/TaskViewSurface.tsx', 'web/src/components/tasks/TasksPageTable.tsx']) {
      const src = code(fs.readFileSync(path.join(ROOT, f), 'utf8'))
      // The page or list itself never takes the whole minute: only its labels do (useMinuteValue).
      expect(src, f).not.toMatch(/\buseMinuteNow\s*\(|function useMinute/)
      expect(found.filter((hit) => hit.startsWith(`${f}:`)), f).toEqual([])
    }
  })
})
