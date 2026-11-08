/**
 * Every read under /tasks and /focus is answered by whoever holds its data (2026-11-06, the
 * user on his phone: "it clearly shows 4 threads, but when I tap in there are none"). The
 * companion's task copy kept every GET under /tasks, so a VP's Threads, read from a store only
 * the Mac keeps, came back empty from the companion.
 *
 * This file lists every GET route under /tasks and /focus found in src/web/routes, with who
 * answers it through the companion and why. A new route fails here until it is listed: one the
 * task record alone answers may join TASK_COPY_READS; every other goes to the Mac (the default).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { companionAnswers, TASK_COPY_READS } from '../../../src/web/v1-forward/policy.js'

const ROUTES_DIR = path.resolve(__dirname, '../../../src/web/routes')

/** Who answers each read through the companion: 'copy' (its task copy) or 'mac'. */
const EXPECTED: Record<string, { by: 'copy' | 'mac'; why: string }> = {
  '/focus/tasks': { by: 'copy', why: 'the focus tiers are fields of the task records' },
  '/focus/tiers': { by: 'copy', why: 'the focus tiers are fields of the task records' },
  '/tasks': { by: 'copy', why: 'the task list is the task store' },
  '/tasks/:id': { by: 'copy', why: 'one task record' },
  '/tasks/enriched': { by: 'copy', why: 'task records with their own fields' },
  '/tasks/groups': { by: 'copy', why: 'folders live in the task store' },
  '/tasks/meta/sprints': { by: 'copy', why: 'read from the task records' },
  '/tasks/meta/tag-display': { by: 'copy', why: 'read from the task records' },
  '/tasks/meta/tags': { by: 'copy', why: 'read from the task records' },
  '/tasks/:id/agent-memory': { by: 'copy', why: 'task.agent_memory, a field of the record' },
  '/tasks/:id/brief': { by: 'copy', why: 'task.brief and the task list' },
  '/tasks/:id/watch': { by: 'copy', why: 'task.watch, a field of the record' },
  '/tasks/:id/agent-skills': { by: 'mac', why: 'the agent-skills store, kept only on the primary' },
  '/tasks/:id/agent-skills/:name': { by: 'mac', why: 'the agent-skills store, kept only on the primary' },
  '/tasks/:id/board': { by: 'mac', why: 'the boards store, which the copy does not keep' },
  '/tasks/:id/board/open-choice': { by: 'mac', why: 'the boards store' },
  '/tasks/:id/board/owner': { by: 'mac', why: 'the boards store' },
  '/tasks/:id/sessions': { by: 'mac', why: 'the session records' },
  '/tasks/:id/threads': { by: 'mac', why: 'an Org node\'s Threads, kept only on the primary' },
  '/tasks/:id/threads/:thread': { by: 'mac', why: 'an Org node\'s Threads, kept only on the primary' },
  '/tasks/:id/transfer-options': { by: 'mac', why: 'the hosts and their profiles' },
  '/tasks/:id/wake-sources': { by: 'mac', why: 'the routines and triggers' },
}

function getRoutes(): string[] {
  const out = new Set<string>()
  for (const f of fs.readdirSync(ROUTES_DIR)) {
    if (!f.endsWith('.ts')) continue
    const src = fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8')
    for (const m of src.matchAll(/\.get\(\s*'(\/(?:tasks|focus)[^']*)'/g)) out.add(m[1])
  }
  return [...out].sort()
}

/** A concrete path for a route pattern: `:id` as a task id, any other `:param` as a value. */
const concrete = (route: string) => route.replace(':id', 't1').replace(/:[a-z]+/g, 'x1')

describe('reads under /tasks go to whoever holds their data', () => {
  const routes = getRoutes()

  it('finds the routes it guards', () => {
    expect(routes.length).toBeGreaterThan(15)
    expect(routes).toContain('/tasks/:id/threads')
  })

  it('every GET route under /tasks and /focus is listed here', () => {
    expect(routes.filter((r) => !EXPECTED[r])).toEqual([])
  })

  it.each(Object.entries(EXPECTED))('%s is answered by the %s', (route, { by }) => {
    expect(companionAnswers('GET', concrete(route))).toBe(by === 'copy' ? 'task-copy' : null)
  })

  it('the copy answers a read under one task only from the task record', () => {
    const copyReads = Object.entries(EXPECTED)
      .filter(([r, e]) => e.by === 'copy' && r.startsWith('/tasks/:id/'))
      .map(([r]) => r.slice('/tasks/:id/'.length))
    expect(copyReads.sort()).toEqual([...TASK_COPY_READS].sort())
  })
})
