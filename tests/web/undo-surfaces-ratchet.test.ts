/**
 * Every surface that completes or deletes a task does it through the Undo stack
 * (web/src/undo/TaskUndoContext.tsx: useTaskUndo / useUndoableTaskActions), so each gets its
 * toast and mod+z. A review found the task details popup, the task pages and the calendar
 * completing and deleting straight through the task store: no Undo, and a "cannot be undone"
 * confirm beside a row menu whose delete could be undone.
 *
 * A file that takes toggleComplete / deleteTask from the task store fails here, and so does a
 * store call of them in a file that has no Undo path at all.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
/** The store itself, its REST calls and the Undo layer that wraps them. */
const HOMES = ['web/src/undo/', 'web/src/contexts/TasksContext.tsx', 'web/src/hooks/useTasks.ts', 'web/src/api/']

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return files(file)
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [file] : []
  })
}

describe('task completes and deletes go through the Undo stack', () => {
  const sources = files(path.join(root, 'web/src'))
    .map((file) => ({ rel: path.relative(root, file).split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') }))
    .filter(({ rel }) => !HOMES.some((home) => rel.startsWith(home)))

  /** Takes them from the store only as the fallback of handlers that call the Undo layer first. */
  const FALLBACK_ONLY: Record<string, string> = {
    'web/src/pages/MainPage.tsx': 'handleToggleComplete / handleDeleteTask: taskUndo first, the store with no Undo layer',
  }

  it('no surface takes toggleComplete or deleteTask from the task store', () => {
    const offenders = sources.filter(({ rel }) => !(rel in FALLBACK_ONLY)).flatMap(({ rel, text }) =>
      [...text.matchAll(/\{([^{}]*)\}\s*=\s*useTasksContext(?:Safe)?\(\)/g)]
        .filter((m) => /\b(toggleComplete|deleteTask)\b/.test(m[1]))
        .map(() => rel))
    expect(offenders).toEqual([])
  })

  it('a store call of them sits beside an Undo path, as its fallback', () => {
    const offenders = sources
      .filter(({ text }) => /\b\w+!?\??\.(toggleComplete|deleteTask)\(/.test(text.replace(/\b(taskUndo|undo)\??\.(toggleComplete|deleteTask)\(/g, '')))
      .filter(({ text }) => !/\buseTaskUndo\(|\buseUndoableTaskActions\(/.test(text))
      .map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })

  it('each fallback-only file still calls the Undo layer first', () => {
    for (const rel of Object.keys(FALLBACK_ONLY)) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8')
      expect(text, rel).toMatch(/if \(taskUndo\) taskUndo\.toggleComplete\(/)
      expect(text, rel).toMatch(/if \(taskUndo\) taskUndo\.deleteTask\(/)
    }
  })

  it('the details popup completes and deletes through it', () => {
    const text = fs.readFileSync(path.join(root, 'web/src/components/tasks/TaskDetailEdits.tsx'), 'utf8')
    expect(text).toMatch(/undo\.toggleComplete\(task\.id\)/)
    expect(text).toMatch(/undo\.deleteTask\(task\.id\)/)
  })
})
