/**
 * One rule counts a node's Threads (2026-11-21, the user, on a VP row with a red "1" and "1 thread:
 * <title>" while its Threads showed only Working, Waiting and Done: "It show 1 but there isn't
 * any"). The thread was a task's thread below the VP whose reply from him was still on its way to
 * that task: listed above it (thread-view.ts listedAbove), so threadCounts counted it, while the
 * grouped Threads drew it in Working (thread-groups.ts threadGroupOf, dde4964bea).
 *
 * The rule now: a thread lights a count up only when his Threads draw it in Needs you or Done
 * (thread-groups.ts threadsForHim; `read` is drawn as Done), both under All, his Threads' default.
 * Every count is made from it.
 *
 *   1. Every kind of thread (each state, pinned, snoozed, a task's below, his reply on its way,
 *      asked in a task, the task's own ask, Known, closed, overdue on the node) and their mix:
 *      the count is the Needs you and Done groups, each counted card is in his list, and none
 *      outside those groups is counted.
 *   2. Source guard: each file in src/ and web/src/ that calls a thread verdict is listed here with
 *      what it does with it, and only thread-groups.ts turns a verdict into a number; a new caller
 *      fails until it is classified. The places that send a count out (shown_count, the status
 *      facts, the phone's tab) read it from threadCounts or the `counted` flag.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { listedForHim, type ViewThread } from '../../../src/core/org/thread-view.js'
import { ALL_SHOWS, FOR_HIM_GROUPS, groupThreads, threadCounts, threadGroupOf, threadsForHim } from '../../../src/core/org/thread-groups.js'
import { keepsThreads } from '../../../src/core/org/keeps-threads.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const NOW = Date.parse('2026-11-21T00:42:00.000Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

type T = ViewThread & { id: string; title: string; state: string; updatedAt: string }
const STATES = ['new', 'working', 'needs', 'answered', 'pending'] as const

/** Each way a thread can be, on top of its state. */
const KINDS: Record<string, (t: T) => T> = {
  plain: (t) => t,
  pinned: (t) => ({ ...t, pinned: { at: ago(5), by: 'human' } }),
  snoozed: (t) => ({ ...t, snoozed: { until: new Date(NOW + 3600_000).toISOString(), at: ago(3) } }),
  below: (t) => ({ ...t, owner: { task_id: 'task-trays', title: 'Order the seed trays' } }),
  'below, his reply on its way': (t) => ({
    ...t, owner: { task_id: 'task-trays', title: 'Order the seed trays' },
    messages: [...t.messages, { id: `${t.id}-r`, at: ago(2), text: 'Put it where it belongs', delivery: { state: 'pending' } }],
  }),
  'asked in a task': (t) => ({ ...t, askedIn: { task: 'task-trays', title: 'Order the seed trays', ask: 'Which trays?', via: 'owner' } }),
  'asked in a task, answered there': (t) => ({ ...t, askedIn: { task: 'task-trays', title: 'Order the seed trays', ask: 'Which trays?', via: 'owner', answered: true } }),
  'the task\'s own ask': (t) => ({ ...t, heldAsk: { id: 'ask-1', ask: 'Which trays?', was: t.state } }),
  known: (t) => ({ ...t, ackedAt: ago(1) }),
  closed: (t) => ({ ...t, closed: { by: 'human' } }),
  'overdue on the node': (t) => ({ ...t, updatedAt: ago(200), by: 'human', messages: [{ id: `${t.id}-m`, at: ago(200), text: 'Is the order in?' }] }),
  'read already': (t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, readAt: ago(0) })) }),
}

let seq = 0
function base(state: string): T {
  const id = `th-${String(++seq).padStart(4, '0')}`
  return {
    id, title: `Thread ${id}`, state, updatedAt: ago(10), by: 'task:node',
    messages: [{ id: `${id}-m`, at: ago(20), text: 'Is the seed order in?', ...(state === 'answered' ? { answer: { text: 'Yes, it ships Monday.', at: ago(10) } } : {}) }],
  }
}

const every = (): Array<{ name: string; t: T }> => STATES.flatMap((s) => Object.entries(KINDS).map(([k, f]) => ({ name: `${s} / ${k}`, t: f(base(s)) })))

function expectOneRule(threads: readonly T[], label: string): void {
  const listed = new Set(listedForHim(threads, NOW))
  const counted = threadsForHim(threads, NOW)
  const groups = groupThreads(threads, NOW)
  // The count is the Needs you and Done groups, both shown under All.
  expect(threadCounts(threads, NOW).shown, label).toBe(FOR_HIM_GROUPS.reduce((n, g) => n + groups[g].length, 0))
  expect(new Set(counted), label).toEqual(new Set(FOR_HIM_GROUPS.flatMap((g) => groups[g])))
  for (const t of threads) {
    const group = threadGroupOf(t, listed.has(t), NOW)
    const isCounted = counted.includes(t)
    expect(isCounted, `${label}: ${t.id} in ${group}`).toBe(FOR_HIM_GROUPS.includes(group))
    // A counted card is in his list (the classic view lists it, the grouped one draws it open).
    if (isCounted) expect(listed.has(t), `${label}: ${t.id} counted but not listed`).toBe(true)
  }
  const c = threadCounts(threads, NOW)
  if (c.id) expect(counted.map((t) => t.id), `${label}: the line names a counted thread`).toContain(c.id)
  else expect(c.shown, label).toBe(0)
}

describe('every kind of thread is counted by its group', () => {
  it('each kind alone', () => {
    for (const { name, t } of every()) expectOneRule([t], name)
  })

  it('all of them on one node', () => {
    expectOneRule(every().map((x) => x.t), 'the whole mix')
  })

  it('the 2026-11-21 VP: a task\'s thread below, his reply on its way, lights nothing up and is listed in Working', () => {
    const t = KINDS['below, his reply on its way']!(base('working'))
    expect(listedForHim([t], NOW)).toEqual([t])
    expect(threadGroupOf(t, true, NOW)).toBe('working')
    expect(threadCounts([t], NOW)).toEqual({ shown: 0, needs: 0 })
    // Before his reply it waited on him there: counted, in Needs you, below.
    const before = KINDS.below!(base('needs'))
    expect(threadGroupOf(before, true, NOW)).toBe('needs')
    expect(threadCounts([before], NOW)).toMatchObject({ shown: 1, needs: 0, below: 1, id: before.id })
  })

  it('the groups a count lights up show under All, his Threads\' default (no pick to find the card)', () => {
    for (const g of FOR_HIM_GROUPS) expect(ALL_SHOWS).toContain(g)
  })

  it('every org node kind that keeps Threads is counted by threadCounts; a router keeps none', () => {
    // CEO (main), VP (lead), a Director or any task with Threads on: readNodeThreads counts each with threadCounts.
    for (const node of [{ org_role: 'main' }, { org_role: 'lead' }, { threads_on: true }]) expect(keepsThreads(node)).toBe(true)
    expect(keepsThreads({ org_role: 'router', threads_on: true })).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// Source guard
// ---------------------------------------------------------------------------------------------

/** The functions that judge a thread for him: a list, a group, or a count. */
const VERDICTS = ['listedForHim', 'shownToHim', 'listedAbove', 'aboveForHim', 'groupThreads', 'threadGroupOf', 'threadsForHim', 'threadCounts'] as const
/** The modules they come from (a file's own import says which). */
const VERDICT_MODULES = /(?:thread-view|thread-groups)(?:\.js)?['"]/

/**
 * Each file that calls a verdict, and what it does with it. Only `count` makes a number of a
 * node's threads, and every `count` file makes it with threadCounts or threadsForHim.
 */
const CALLERS: Record<string, { role: 'rule' | 'count' | 'list'; why: string }> = {
  'src/core/org/thread-view.ts': { role: 'rule', why: 'defines the per-thread rules (shownToHim, listedAbove, listedForHim)' },
  'src/core/org/thread-groups.ts': { role: 'rule', why: 'the groups, and the one count made from them (threadsForHim, threadCounts)' },
  'src/core/org/thread-popup.ts': { role: 'list', why: 'which threads of a task below are sent up to its leaders (listedAbove)' },
  'src/core/user-status-sync.ts': { role: 'count', why: 'user_status.threads of Main, every VP and lead, a Director and a task with Threads on' },
  'src/web/routes/org-threads-v1.ts': { role: 'count', why: 'shown_count, and each thread\'s `shown` (listed) and `counted` flags' },
  'web/src/components/org/OrgNodeDetail.tsx': { role: 'count', why: 'the node header\'s "N threads" pill' },
  'web/src/components/sessions/SessionPanel.tsx': { role: 'count', why: 'a Threads-on task\'s chip count' },
  'web/src/hooks/status-prediction.ts': { role: 'count', why: 'the row\'s predicted user_status.threads after a write' },
  'web/src/components/org/top-thread-model.ts': { role: 'count', why: 'the top of the chat steps through the counted threads, its N the header\'s' },
  'web/src/components/org/OrgThreads.tsx': { role: 'list', why: 'draws the list (classic) or the groups (brief_off); counts nothing' },
  'web/src/components/org/thread-badge.ts': { role: 'list', why: 'a card\'s word and dot are its group\'s (threadGroupOf); counts nothing' },
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p)
    return /\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : []
  })
}

/** The verdicts a file imports from thread-view / thread-groups (an aliased one included), or defines. */
function verdictNames(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    if (!VERDICT_MODULES.test(m[0])) continue
    for (const part of m[1]!.split(',')) {
      const [name, alias] = part.replace(/\btype\b/, '').trim().split(/\s+as\s+/)
      if ((VERDICTS as readonly string[]).includes(name ?? '')) out.set(alias ?? name!, name!)
    }
  }
  // A dynamic import: `const { threadCounts } = await import('./org/thread-groups.js')`.
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\(['"][^'"]*(?:thread-view|thread-groups)\.js['"]\)/g)) {
    for (const part of m[1]!.split(',')) {
      const [name, alias] = part.trim().split(/\s*:\s*/)
      if ((VERDICTS as readonly string[]).includes(name ?? '')) out.set(alias ?? name!, name!)
    }
  }
  for (const v of VERDICTS) if (new RegExp(`export function ${v}\\b`).test(src)) out.set(v, v)
  return out
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'web/src'))]
const callers = new Map<string, Set<string>>()
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const names = verdictNames(src)
  const used = new Set<string>()
  for (const [local, name] of names) if (new RegExp(`\\b${local}\\(`).test(src.replace(new RegExp(`export function ${local}\\b`, 'g'), ''))) used.add(name)
  if (used.size) callers.set(path.relative(ROOT, f).split(path.sep).join('/'), used)
}

/**
 * Every surface that draws a count of a node's threads, or steps through the counted cards, and
 * where its number comes from. A new surface fails until it is listed with its source (2026-11-21:
 * the top of the VP's chat kept a card he had answered, "I have to manually click next").
 */
const SURFACES: Record<string, string> = {
  'src/core/org/thread-view.ts': 'defines ThreadCounts, threadCountLabel and threadLine (the words)',
  'src/core/org/thread-groups.ts': 'threadCounts, made from threadsForHim',
  'src/web/routes/org-threads-v1.ts': 'shown_count (threadCounts) and each thread\'s counted flag (threadsForHim)',
  'web/src/components/org/org-channels-model.ts': 'the Org row\'s badge and red line: user_status.threads (threadCounts on the server)',
  'web/src/components/org/OrgChannelList.tsx': 'draws the row\'s badge (threadsBadge)',
  'web/src/components/org/OrgNodeDetail.tsx': 'the header\'s "N threads" pill: threadCounts of the live list, else user_status.threads',
  'web/src/components/org/top-thread-model.ts': 'the top of the chat: threadsForHim; its hidden line counts that list',
  'web/src/components/org/TopThread.tsx': 'steps through topThreads; a card that stops waiting on him gives its place to the next by itself',
  'web/src/components/org/OrgTaskRail.tsx': 'the Threads tab\'s number (the header\'s count), titled "for you"',
  'web/src/components/org/useOrgThreads.ts': 'predicts user_status.threads after a write (statusWithThreads, threadCounts)',
  'web/src/hooks/status-prediction.ts': 'statusWithThreads: threadCounts of the list as drawn',
  'ios-native/Walnut/API/WalnutAPIThreads.swift': 'decodes shown_count and each thread\'s counted flag',
  'ios-native/Walnut/Views/Chat/ChatOrgModel.swift': 'the drawer row\'s badge and line: user_status.threads',
  'ios-native/Walnut/Views/Chat/ChatDrawerOrg.swift': 'draws the drawer row\'s badge (threadsBadge)',
  'ios-native/Walnut/Views/Org/OrgNodePage.swift': 'the Threads tab: the listed ones the server counted (counted), else shown_count',
  'ios-native/Walnut/Views/Org/OrgThreadsView.swift': 'compares its list with shown_count / user_status.threads (a read that brought none)',
  'ios-native/Walnut/Views/Org/OrgThreadsStore.swift': 'keeps shown_count from the read',
  'ios-native/Walnut/Views/Org/OrgThreadsCache.swift': 'keeps shown_count with the cached read',
}
const TS_SURFACE = /\b(?:threadCountLabel|threadLine|topThreads|hiddenLine|statusWithThreads)\(|threadsBadge|user_status\??\.threads|threads\?\.shown|shown_count|export function threadCounts\b/
const SWIFT_SURFACE = /threadsBadge|userStatus\?\.threads|shown_count|(?:read|store|entry)\.shownCount\b|let shownCount: Int\?|threadCountLabel\(|threadLine\(/

function walkSwift(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walkSwift(p) : e.name.endsWith('.swift') ? [p] : []
  })
}

describe('source guard: one function counts a node\'s threads', () => {
  it('every surface that shows a count of threads or steps through the counted cards is listed with its source', () => {
    const ts = files.filter((f) => TS_SURFACE.test(fs.readFileSync(f, 'utf8')))
    const swift = walkSwift(path.join(ROOT, 'ios-native/Walnut')).filter((f) => SWIFT_SURFACE.test(fs.readFileSync(f, 'utf8')))
    const found = [...ts, ...swift].map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort()
    expect(found).toEqual(Object.keys(SURFACES).sort())
    // The top of the chat steps through the counted threads only, and its cursor moves on by itself.
    const top = fs.readFileSync(path.join(ROOT, 'web/src/components/org/top-thread-model.ts'), 'utf8')
    expect(top).toMatch(/orderedForHim\(threadsForHim\(threads, now\), \{ needsFirst: true \}\)/)
    expect(top).not.toMatch(/listedForHim/)
    const strip = fs.readFileSync(path.join(ROOT, 'web/src/components/org/TopThread.tsx'), 'utf8')
    expect(strip).toMatch(/const i = topIndex\(list, atId, lastIndex\.current\)/)
  })


  it('every file that calls a thread verdict is classified (a new one fails until it says what it does)', () => {
    expect([...callers.keys()].sort()).toEqual(Object.keys(CALLERS).sort())
  })

  it('only threadCounts or threadsForHim make a number; a list file never counts its verdict', () => {
    // A number made of a verdict: the length of a list, a group, or a filter on a per-thread verdict.
    const COUNTING = /\b(?:listedForHim|threadsForHim|groupThreads)\([^;\n]*\)(?:\.\w+|\[\w+\])*\.length\b|filter\(\([^)]*\)\s*=>\s*!?(?:shownToHim|listedAbove|threadGroupOf)\([^;\n]*\)\)\.length\b/
    for (const [file, used] of callers) {
      const { role } = CALLERS[file] ?? { role: 'list' }
      if (role === 'rule') continue
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(COUNTING.test(src), `${file} counts a verdict itself`).toBe(false)
      if (role === 'count') expect([...used].some((u) => u === 'threadCounts' || u === 'threadsForHim'), file).toBe(true)
      if (role === 'list') expect(used.has('threadCounts'), `${file} is a list, it counts nothing`).toBe(false)
    }
  })

  it('threadCounts and threadsForHim are defined once, in thread-groups.ts', () => {
    const defs = files.filter((f) => /export function (?:threadCounts|threadsForHim)\b/.test(fs.readFileSync(f, 'utf8')))
    expect(defs.map((f) => path.relative(ROOT, f).split(path.sep).join('/'))).toEqual(['src/core/org/thread-groups.ts'])
  })

  it('what goes out as a count reads threadCounts or the counted flag', () => {
    const route = fs.readFileSync(path.join(ROOT, 'src/web/routes/org-threads-v1.ts'), 'utf8')
    for (const line of route.split('\n').filter((l) => /shown_count:/.test(l))) expect(line).toMatch(/threadCounts\(/)
    for (const line of route.split('\n').filter((l) => /\bcounted:/.test(l))) expect(line).toMatch(/forHim|threadsForHim\(/)
    const sync = fs.readFileSync(path.join(ROOT, 'src/core/user-status-sync.ts'), 'utf8')
    const read = sync.slice(sync.indexOf('async function readNodeThreads'), sync.indexOf('export interface ChoiceFact'))
    expect(read).toMatch(/return threadCounts\(/)
    expect(read).not.toMatch(/\.shown\s*[+=]|shown:\s*[^,}]*\.length/)
    // The Org row's badge and red line, the drawer and the phone read user_status.threads (threadCounts).
    const channels = fs.readFileSync(path.join(ROOT, 'web/src/components/org/org-channels-model.ts'), 'utf8')
    expect(channels).toMatch(/threadsBadge: threads\?\.shown \?\? 0/)
    expect(channels).toMatch(/threadsBadge: mainThreads\?\.shown \?\? 0/)
    // The phone's own count of its list is the listed ones the server counted (Swift, not compiled here).
    const page = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/Views/Org/OrgNodePage.swift'), 'utf8')
    expect(page).toMatch(/\.open\.filter \{ \$0\.counted \?\? true \}\.count/)
    const ios = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/Views/Chat/ChatOrgModel.swift'), 'utf8')
    expect(ios).toMatch(/threadsBadge: shown/)
  })
})
