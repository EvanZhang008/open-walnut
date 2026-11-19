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
  [`${RAW} components/board/kanban/useKanbanWrites.ts`]: 'KNOWN GAP: a Board draws its own payload and patches it on the click, so the Board itself is instant, and the task store follows the event; moving it onto the store is open work',
  // ── org threads ──
  '@/api/org-threads components/org/useOrgThreads.ts': 'it IS the node threads store',
  // ── letters ──
  '@/api/human-inbox components/inbox/SessionInboxPane.tsx': 'passed to the letter store\'s applyLetterChange as the write it runs after the optimistic patch',
  '@/api/human-inbox components/common/NotificationPanel.tsx': 'passed to the letter store\'s applyLetterChange as the write it runs after the optimistic patch',
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

  it('the fast lane does not wait the debounce', () => {
    const fast = Number(/const FAST_MS = ([\d_]+)/.exec(sync)?.[1]?.replace(/_/g, ''))
    expect(fast).toBeGreaterThan(0)
    expect(fast).toBeLessThanOrEqual(100)
  })
})
