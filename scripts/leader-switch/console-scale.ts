/**
 * The console rehearsal at a real home's density (console-rehearsal.ts `seedHome`): A's home is
 * written before A boots, by a fixed generator (neutral names, no randomness) into the stores the
 * way Walnut writes them (task-db, session-db, the notes vault), as tests/e2e/replica-scale-e2e.test.ts
 * does; the switch then carries it to B. `measureLoads` opens `/` and a task's session page five
 * times each, at the console (A's address, through this machine's replica) and at the leader's
 * own address, and reports the worst full load of each.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { REPO } from './world.js'
import type { ConsoleWorld } from './console-world.js'

export const SCALE = { tasks: 5_000, sessions: 1_000, notes: 1_000 } as const

const SEED = (src: string, root: string, n: typeof SCALE) => `
process.umask(0o077)
const c = await import(${JSON.stringify(path.join(src, 'constants.ts'))})
if (!c.WALNUT_HOME.startsWith(${JSON.stringify(root + path.sep)})) { process.stderr.write('REFUSING: not a rehearsal home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const taskDb = await import(${JSON.stringify(path.join(src, 'core/task-db.ts'))})
const sessionDb = await import(${JSON.stringify(path.join(src, 'core/session-db.ts'))})
const fs = await import('node:fs')
const path = await import('node:path')
const put = (db, table, row) => { const cols = Object.keys(row).filter((k) => row[k] !== undefined); db.prepare('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map((x) => '@' + x).join(',') + ')').run(Object.fromEntries(cols.map((x) => [x, row[x]]))) }
const now = Date.UTC(2026, 9, 10, 8, 0, 0)
const t = taskDb.getDb()
t.transaction(() => { for (let i = 0; i < ${n.tasks}; i++) put(t, 'tasks', taskDb.taskToRow({ id: 'task-marina-' + i, title: 'Marina task ' + i, status: 'todo', phase: i % 5 === 0 ? 'COMPLETE' : 'TODO', priority: 'none', project: 'marina-' + (i % 40), source: 'local', created_at: new Date(now - i * 60000).toISOString(), updated_at: new Date(now - i * 30000).toISOString(), description: 'Marina notes for the drill. '.repeat(8), tags: [] })) })()
const s = sessionDb.getDb()
s.transaction(() => { for (let i = 0; i < ${n.sessions}; i++) put(s, 'sessions', sessionDb.sessionToRow({ claudeSessionId: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'), taskId: 'task-marina-' + (i % ${n.tasks}), project: 'marina-' + (i % 40), process_status: 'stopped', mode: 'default', startedAt: new Date(now - i * 90000).toISOString(), lastActiveAt: new Date(now - i * 45000).toISOString(), messageCount: i % 50, cwd: '/home/marina/work', title: 'Marina session ' + i })) })()
taskDb.closeDb(); sessionDb.closeDb()
for (let i = 0; i < ${n.notes}; i++) {
  const file = path.join(c.NOTES_DIR, 'Marina ' + (i % 30), 'Note ' + i + '.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '# Note ' + i + '\\n\\nThe drill checklist, part ' + i + '. \\u00e9t\\u00e9\\n' + 'Line of the note. '.repeat(10) + '\\n')
}
process.stdout.write('SEEDED\\n')
`

/** Writes the large home (before A boots). */
export async function seedLargeHome(home: string, env: Record<string, string>, root: string, n: typeof SCALE = SCALE): Promise<void> {
  const file = path.join(root, 'seed.mts')
  fs.writeFileSync(file, SEED(path.join(REPO, 'src'), path.resolve(root), n))
  fs.mkdirSync(home, { recursive: true })
  const out = execFileSync(process.execPath, [file], { env: { ...process.env, ...env, OPEN_WALNUT_HOME: home }, encoding: 'utf8', timeout: 600_000 })
  if (!out.includes('SEEDED')) throw new Error(`the seed did not finish: ${out.slice(-500)}`)
}

export interface LoadTimes { where: string; page: string; ms: number[]; worst: number; error?: string }

/**
 * `/` until the task list shows a row; `/tasks/<id>` until that task's session shows its first
 * answer. A fresh page each time (no cache), Chromium, 1280 x 800.
 */
export async function measureLoads(cw: ConsoleWorld, task: { id: string; answer: string }, shots: string, times = 5): Promise<LoadTimes[]> {
  const browser = await chromium.launch({ headless: true })
  const out: LoadTimes[] = []
  fs.mkdirSync(shots, { recursive: true })
  try {
    for (const [where, port] of [['console (A\'s address, the replica)', cw.a.port], ['leader (B\'s own address)', cw.b.port]] as const) {
      for (const [page, url, ready] of [
        // The task list with its count in (a home this size opens with its Projects folded).
        ['/', '/', '.todo-panel .todo-tasks-header .navigation-heading-count'],
        ['a task\'s session page', `/tasks/${task.id}`, `.session-panel :text("${task.answer}")`],
      ] as const) {
        const ms: number[] = []
        let error: string | undefined
        for (let i = 0; i < times && !error; i++) {
          const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
          const p = await context.newPage()
          const t0 = Date.now()
          try {
            await p.goto(`http://localhost:${port}${url}`, { waitUntil: 'load', timeout: 120_000 })
            await p.locator(ready).first().waitFor({ state: 'visible', timeout: 120_000 })
            ms.push(Date.now() - t0)
          } catch (err) {
            const file = path.join(shots, `load-failed-${port}-${page.replace(/[^a-z]+/gi, '-')}.png`)
            await p.screenshot({ path: file }).catch(() => {})
            error = `${err instanceof Error ? err.message.split('\n')[0] : String(err)} (${file})`
          }
          await context.close()
        }
        out.push({ where, page, ms, worst: ms.length ? Math.max(...ms) : NaN, ...(error ? { error } : {}) })
      }
    }
  } finally {
    await browser.close()
  }
  return out
}
