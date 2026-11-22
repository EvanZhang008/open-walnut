/**
 * Guard: a surface never writes a shared entity behind its store's back.
 *
 * The class (2026-09-02 the task title, 2026-11-19 the Org thread dot and the status pill):
 * something the user can change is shown on more than one surface; one surface writes it with
 * the plain REST call and keeps its own copy, so the others learn of it from the server, a
 * round-trip and sometimes a derive pass later (20 to 35 s measured). The fix every time was
 * the same: ONE store per entity kind, and every write goes through the store's mutator, which
 * changes every surface in the frame of the click (web/src/AGENTS.md, "One browser, one task
 * store" and the bullets after it).
 *
 * Enumerated from the source: every file in web/src that imports a WRITE of a shared entity
 * straight from its api module. Each one is listed below with why it may: it IS the store, or
 * the call is the fallback for a row the store does not hold (a pop-out has no provider).
 * A new importer fails until it either goes through the store or is listed with its reason;
 * a listed file that no longer imports the write fails too, so the list cannot rot.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const WEB_SRC = join(__dirname, '../../web/src')

/** The writes of each shared entity, by the api module that exports them. */
const WRITES: Record<string, { store: string; names: string[] }> = {
  '@/api/tasks': {
    store: 'the task store (useTasksContext / useTasksContextSafe: update, setPhase, complete, toggleComplete, deleteTask)',
    names: ['updateTask', 'completeTask', 'toggleCompleteTask', 'batchSetPhase', 'deleteTask', 'batchDeleteTasks', 'reorderTasks'],
  },
  '@/api/org-threads': {
    store: "the node threads store (components/org/useOrgThreads.ts: update, split)",
    names: ['fetchOrgThreads', 'patchOrgThread', 'splitOrgThread'],
  },
  '@/api/human-inbox': {
    store: 'the letter store (components/inbox/letter-store.ts: applyLetterChange, patchLetter)',
    names: ['setLetterRead', 'setLetterPinned', 'setLetterArchived', 'answerLetter'],
  },
}

/** The key of a task write made with the generic client (rawTaskWrites). */
const RAW = 'raw:/api/tasks'

const FALLBACK = 'the store call comes first; the plain call is the fallback for a row the store does not hold (a pop-out, a row outside the list)'

/** `module file`: why this file may import the write directly. */
const ALLOWED: Record<string, string> = {
  // ── tasks ──
  '@/api/tasks hooks/useTasks.ts': 'it IS the task store',
  '@/api/tasks undo/TaskUndoContext.tsx': 'the Undo stack: a delete held for its Undo window is sent after the store already removed the row (hideTasks)',
  '@/api/tasks components/tasks/TaskStatusControl.tsx': FALLBACK,
  '@/api/tasks components/tasks/WatchToggle.tsx': FALLBACK,
  '@/api/tasks components/tasks/TaskDetailEdits.tsx': FALLBACK,
  '@/api/tasks components/tasks/TaskDetailPane.tsx': FALLBACK,
  '@/api/tasks components/tasks/PrPill.tsx': FALLBACK,
  '@/api/tasks components/tasks/PhoneTaskDetailHead.tsx': FALLBACK,
  '@/api/tasks components/sessions/TaskQuickActions.tsx': FALLBACK,
  '@/api/tasks components/sessions/SessionPanel.tsx': FALLBACK,
  '@/api/tasks components/sessions/EditableSessionTitle.tsx': FALLBACK,
  '@/api/tasks components/sessions/task-phase-write.ts': FALLBACK,
  '@/api/tasks components/sessions/DraftSessionPanel.tsx': 'a draft column binds a task the list may not hold yet; the task:updated event carries the project to the store',
  '@/api/tasks components/drawing/DrawingAssistant.tsx': 'retitles the drawing\'s own helper task, shown on no board (plugin-only)',
  '@/api/tasks pages/MainPage.tsx': 'the Undo of a task created a moment ago, and its unread mark, before the list holds the row',
  // ── tasks, with the generic client ──
  [`${RAW} components/tasks/PrPill.tsx`]: 'the two switches of a pull request card (pr_wake, pr_auto_complete): fields only this card shows, drawn on the press and written in order',
  [`${RAW} components/sessions/session-threads-model.ts`]: FALLBACK,
  [`${RAW} popout/PopoutExtTasks.tsx`]: 'a pop-out window has no task store provider; the main window follows the task:updated event',
  [`${RAW} components/board/kanban/useKanbanWrites.ts`]: 'a card\'s phase and complete go through the task store\'s setPhase / complete when it holds the row (pinned below); the plain call is the fallback for a card whose task the list does not carry',
  // ── org threads ──
  '@/api/org-threads components/org/useOrgThreads.ts': 'it IS the node threads store',
  // ── letters ──
  '@/api/human-inbox components/inbox/SessionInboxPane.tsx': 'passed to the letter store\'s applyLetterChange as the write it runs after the optimistic patch',
  '@/api/human-inbox components/common/useNotificationLetters.ts': 'passed to the letter store\'s applyLetterChange as the write it runs after the optimistic patch',
  '@/api/human-inbox components/inbox/LetterView.tsx': 'an answer is delivered to a session and can be refused: shown as sending, then patched into the letter store',
  '@/api/human-inbox components/org/OrgInlineAnswer.tsx': 'an answer is delivered to a session and can be refused: the Org row leaves on the click (answers.start, which predicts the status in the task store), then patched into the letter store',
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}

const IMPORT_RE = /import\s+(type\s+)?(?:\*\s+as\s+(\w+)|\{([^}]*)\})\s+from\s+'([^']+)'/g

/** The writes `src` imports as values from the api modules above: `module name` pairs. */
export function importedWrites(src: string): { module: string; name: string }[] {
  const out: { module: string; name: string }[] = []
  for (const m of src.matchAll(IMPORT_RE)) {
    const [, typeOnly, star, braces, module] = m
    // A relative path to the same module ('../../api/tasks') is the same import.
    const named = module!.replace(/^(?:\.\.?\/)+(?:.*\/)?api\//, '@/api/')
    const rule = WRITES[named]
    if (!rule || typeOnly) continue
    if (star) {
      for (const name of rule.names) if (new RegExp(`\\b${star}\\.${name}\\b`).test(src)) out.push({ module: named, name })
      continue
    }
    for (const part of braces!.split(',')) {
      const spec = part.trim()
      if (!spec || spec.startsWith('type ')) continue
      const name = spec.split(/\s+as\s+/)[0]!.trim()
      if (rule.names.includes(name)) out.push({ module: named, name })
    }
  }
  return out
}

/**
 * The same write made with the generic client instead of the api module: a PATCH of a task, or
 * its complete / toggle-complete POST (`/api/tasks/<id>` and `/api/v1/tasks/<id>`).
 */
const RAW_TASK_WRITE = /api(?:Patch|Put)(?:<[^>]*>)?\(\s*`\/api\/(?:v1\/)?tasks\/\$\{[^}]*\}`|apiPost(?:<[^>]*>)?\(\s*`\/api\/(?:v1\/)?tasks\/\$\{[^}]*\}\/(?:toggle-)?complete`/g

export function rawTaskWrites(src: string): number {
  return [...src.matchAll(RAW_TASK_WRITE)].length
}

function importers(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of sourceFiles(WEB_SRC)) {
    const rel = relative(WEB_SRC, file).split('\\').join('/')
    const src = readFileSync(file, 'utf8')
    if (!rel.startsWith('api/') && rawTaskWrites(src) > 0) found.set(`${RAW} ${rel}`, ['a task write with the generic client'])
    for (const w of importedWrites(src)) {
      const key = `${w.module} ${rel}`
      found.set(key, [...(found.get(key) ?? []), w.name])
    }
  }
  return found
}

describe('shared entity writes go through their store', () => {
  const found = importers()

  it('the scan sees the stores themselves (a broken matcher must not pass empty)', () => {
    expect(found.get('@/api/tasks hooks/useTasks.ts')).toEqual(expect.arrayContaining(['updateTask', 'batchSetPhase']))
    expect(found.get('@/api/org-threads components/org/useOrgThreads.ts')).toEqual(expect.arrayContaining(['patchOrgThread']))
    expect(found.size).toBeGreaterThan(10)
  })

  it('no new surface writes a shared entity with the plain api call', () => {
    const unlisted = [...found.keys()].filter((k) => !(k in ALLOWED)).sort()
    const say = unlisted.map((k) => {
      const [module, file] = k.split(' ')
      return `${file} imports ${found.get(k)!.join(', ')} from ${module}. Write through ${(WRITES[module!] ?? WRITES['@/api/tasks'])!.store} so every surface changes on the click, or list it in ALLOWED with the reason the store cannot carry it.`
    })
    expect(say, say.join('\n')).toEqual([])
  })

  it('the allowed list names only files that still import a write', () => {
    const gone = Object.keys(ALLOWED).filter((k) => !found.has(k)).sort()
    expect(gone, `no longer import a shared write; remove from ALLOWED:\n${gone.join('\n')}`).toEqual([])
  })

  it('the matcher reads the import forms the code uses', () => {
    expect(importedWrites("import { updateTask, fetchTask } from '@/api/tasks'")).toEqual([{ module: '@/api/tasks', name: 'updateTask' }])
    expect(importedWrites("import { updateTask as apiUpdateTask } from '@/api/tasks'")).toEqual([{ module: '@/api/tasks', name: 'updateTask' }])
    expect(importedWrites("import type { UpdateTaskInput } from '@/api/tasks'")).toEqual([])
    expect(importedWrites("import { updateTask } from '../../api/tasks'")).toEqual([{ module: '@/api/tasks', name: 'updateTask' }])
    expect(rawTaskWrites('await apiPatch(`/api/tasks/${encodeURIComponent(id)}`, { phase })')).toBe(1)
    expect(rawTaskWrites('apiPost<X>(`/api/v1/tasks/${id}/complete`, {})')).toBe(1)
    expect(rawTaskWrites('apiPost(`/api/tasks/${id}/changes/refresh`, {})')).toBe(0)
    expect(importedWrites("import { type OrgThread, patchOrgThread } from '@/api/org-threads'")).toEqual([{ module: '@/api/org-threads', name: 'patchOrgThread' }])
    expect(importedWrites("import * as tasksApi from '@/api/tasks'\ntasksApi.deleteTask(id)")).toEqual([{ module: '@/api/tasks', name: 'deleteTask' }])
    expect(importedWrites("import { fetchTask } from '@/api/tasks'")).toEqual([])
  })
})

/**
 * A private copy of a task row is the read side of the same class: a component that reads a task
 * with fetchTask and draws it from its own state shows what the server said once, while every
 * other surface follows the store (2026-11-19: a search answer's rows kept the phase they were
 * read with; a session header's kebab took the raw event over the store's prediction). Every
 * importer of a task READ outside the store is listed with why its copy is not drawn over a store
 * row: the store's row wins where it holds one, or the copy carries fields the list omits, or it is
 * read for a step and never drawn.
 */
const READS = ['fetchTask', 'fetchTasksBulk', 'fetchTasksByIds']
const READ_FALLBACK = 'the store\'s row is drawn when it holds one; the read is the fallback for a task the list does not carry'
const ALLOWED_READS: Record<string, string> = {
  'hooks/useTasks.ts': 'it IS the task store',
  'contexts/TasksContext.tsx': 'the store\'s label lookup for ids the list does not hold (pill titles and their status)',
  'apps/mail/MailRouteLine.tsx': 'reads the task once on a click to find its Org node; nothing is drawn from it',
  'components/board/kanban/KanbanDetailTask.tsx': 'the description and note only (the list omits them); the task itself is useStoreTask',
  'components/org/AgentMemoryPanel.tsx': 'the node\'s instructions only, a field the list omits, edited in this panel',
  'components/org/OrgSidePanel.tsx': READ_FALLBACK,
  'components/sessions/DraftSessionPanel.tsx': 'the bound task\'s project, once, for a draft column whose task the list may not hold yet',
  'components/sessions/SessionPanel.tsx': `${READ_FALLBACK} (panelTaskCopy: the store's row, the read's ext only)`,
  'components/sessions/TaskQuickActions.tsx': `${READ_FALLBACK}; its events never write over the store's row`,
  'components/sessions/SearchAnswerCard.tsx': 'resolves the ids a search answered (prefixes, gone ones); AgentSearchResultRows draws the store\'s phase and status over it',
  'components/tasks/QuickSortReply.tsx': 'the last start of a task, read for one step, never drawn',
  'components/tasks/TaskDetailPane.tsx': 'the fields the list omits (description, notes); the row itself is the store\'s',
  'components/tasks/useRecentOpenedTasks.ts': 'only the opened tasks the list does not carry',
  'components/transfer/TransferLinks.tsx': 'a title for a link, read once',
  'components/workspaces/WorkspacePreparingPanel.tsx': READ_FALLBACK,
  'pages/MainPage.tsx': 'a task the list does not hold yet (a lead made a moment ago, a located id, a description to launch with)',
}

function readers(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of sourceFiles(WEB_SRC)) {
    const rel = relative(WEB_SRC, file).split('\\').join('/')
    if (rel.startsWith('api/')) continue
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(IMPORT_RE)) {
      const [, typeOnly, star, braces, module] = m
      if (typeOnly || module!.replace(/^(?:\.\.?\/)+(?:.*\/)?api\//, '@/api/') !== '@/api/tasks') continue
      const names = star
        ? READS.filter((n) => new RegExp(`\\b${star}\\.${n}\\b`).test(src))
        : braces!.split(',').map((p) => p.trim().split(/\s+as\s+/)[0]!.trim()).filter((n) => READS.includes(n))
      if (names.length) found.set(rel, [...(found.get(rel) ?? []), ...names])
    }
  }
  return found
}

describe('a task read outside the store is never drawn over the store\'s row', () => {
  const found = readers()

  it('the scan sees the store\'s own reads', () => {
    expect(found.get('hooks/useTasks.ts')).toEqual(expect.arrayContaining(['fetchTasksByIds']))
  })

  it('no new surface keeps a private copy of a task', () => {
    const unlisted = [...found.keys()].filter((k) => !(k in ALLOWED_READS)).sort()
    expect(unlisted, `${unlisted.join(', ')} read a task (${unlisted.map((k) => found.get(k)!.join('/')).join('; ')}) outside the store. Draw the store's row (useStoreTask / useTasksContextSafe), reading only what the list omits, or list it in ALLOWED_READS with why its copy is never drawn over the store's row.`).toEqual([])
  })

  it('the allowed list names only files that still read a task', () => {
    const gone = Object.keys(ALLOWED_READS).filter((k) => !found.has(k)).sort()
    expect(gone, `no longer read a task; remove from ALLOWED_READS:\n${gone.join('\n')}`).toEqual([])
  })

  it('the search answer rows and the session kebab put the store\'s row first', () => {
    const rows = readFileSync(join(WEB_SRC, 'components/tasks/AgentSearchResultRows.tsx'), 'utf8')
    expect(rows).toMatch(/const row = live \? \{ \.\.\.given, phase: live\.phase/)
    const kebab = readFileSync(join(WEB_SRC, 'components/sessions/TaskQuickActions.tsx'), 'utf8')
    expect(kebab).toMatch(/if \(!followsStore && d\.task/)
  })
})

/** The Board writes a card's task through the task store when it holds the row. */
describe('the Board\'s phase and complete go through the task store', () => {
  const src = readFileSync(join(WEB_SRC, 'components/board/kanban/useKanbanWrites.ts'), 'utf8')
  it('setPhase and complete call the store first', () => {
    expect(src).toMatch(/store \? storeRequest\(\(onError\) => store\.setPhase\(taskId, phase, \{ onError \}\)\)/)
    expect(src).toMatch(/store \? storeRequest\(\(onError\) => store\.complete\(taskId, \{ onError \}\)\)/)
  })
})

/**
 * The second half of the class: a badge that reads a status the SERVER derives. The derive
 * must be on the fast lane for a change a hand made, or the badge waits a pass (the incident).
 * Pinned on the source, so moving a hand's event back to the debounced lane fails here.
 */
describe('a hand\'s change is derived on the fast lane', () => {
  const sync = readFileSync(join(__dirname, '../../src/core/user-status-sync.ts'), 'utf8')

  it('a thread change and an API task write are marked on the fast lane', () => {
    expect(sync).toMatch(/case EventNames\.ORG_THREADS_CHANGED:[\s\S]{0,400}markNow\(d\.taskId\)/)
    expect(sync).toMatch(/FAST_SOURCES[^\n]*new Set\(\[[^\]]*'api'[^\]]*'org-threads'/)
    expect(sync).toMatch(/const lane = event\.source && FAST_SOURCES\.has\(event\.source\) \? markNow : mark/)
  })

  it('a session event that moves its task now is marked on the fast lane', () => {
    expect(sync).toMatch(/const lane = sessionMovesNow\(event\.name, d\) \? markNow : mark;\s+if \(d\.taskId\) lane\(d\.taskId\); else markSession\(d\.sessionId, lane\)/)
  })

  it('the fast lane does not wait the debounce', () => {
    const fast = Number(/const FAST_MS = ([\d_]+)/.exec(sync)?.[1]?.replace(/_/g, ''))
    expect(fast).toBeGreaterThan(0)
    expect(fast).toBeLessThanOrEqual(100)
  })
})
