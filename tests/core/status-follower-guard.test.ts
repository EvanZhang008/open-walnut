/**
 * Status moves go one level at a time (2026-10-31, the user: worker to its leader, top-level task to
 * its VP, VP to Main), so no node hears the same change twice (src/core/sessions/status-push.ts).
 * Guard: every task shape has at most one follower (the first open node with a session in an ordered
 * chain, so a worker whose leader completed is still heard), the chain up ends at Main without a loop, and
 * the push adds a follower in exactly one place (a second fan-out path fails here).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { statusFollowerOf, statusFollowersOf } from '../../src/core/sessions/status-push.js'
import type { Task } from '../../src/core/types.js'

const t = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, phase: 'IN_PROGRESS', status: 'in_progress', project: 'Acme', ...extra }) as Task
const main = t('main', { org_role: 'main', project: 'Org' })
const vp = t('vp', { org_role: 'lead', project: 'Acme' })
const all = [
  main, vp,
  t('top'), // a top-level task of a project with a VP
  t('loose', { project: 'Nobody' }), // a project no VP leads
  t('inbox', { project: '' }),
  t('leader', {}),
  t('worker', { parent_task_id: 'leader' }),
  t('deep', { parent_task_id: 'worker' }),
  t('vp-own', { parent_task_id: 'vp' }),
  t('main-own', { parent_task_id: 'main', project: 'Other' }),
]
const byId = new Map(all.map((x) => [x.id, x] as const))
const vpOf = (task: Task) => (task.project === 'Acme' && task.id !== 'vp' ? vp : undefined)
const up = (task: Task) => statusFollowerOf(task, byId, vpOf, main)

describe('one level at a time', () => {
  it('names the one node right above each task', () => {
    expect(Object.fromEntries(all.map((x) => [x.id, up(x)?.id ?? null]))).toEqual({
      main: null, vp: 'main', top: 'vp', loose: 'main', inbox: 'main', leader: 'vp',
      worker: 'leader', deep: 'worker', 'vp-own': 'vp', 'main-own': 'main',
    })
  })

  it('the chain up from any task reaches Main once, through each node once', () => {
    for (const start of all) {
      const seen = new Set<string>()
      for (let cur: Task | undefined = start; cur; cur = up(cur)) {
        expect(seen.has(cur.id), `loop at ${cur.id} from ${start.id}`).toBe(false)
        seen.add(cur.id)
      }
      expect(seen.has('main'), start.id).toBe(true)
    }
  })

  it('names who hears it when the one above cannot: the chain up, each node once, ending at Main', () => {
    const chain = (task: Task, map = byId) => statusFollowersOf(task, map, vpOf, main).map((x) => x.id)
    expect(chain(byId.get('deep')!)).toEqual(['worker', 'leader', 'vp', 'main'])
    expect(chain(byId.get('vp-own')!)).toEqual(['vp', 'main'])
    expect(chain(byId.get('main-own')!)).toEqual(['main'])
    expect(chain(byId.get('loose')!)).toEqual(['main'])
    // A parent loop ends instead of spinning, and never names the task itself.
    const a = t('a', { parent_task_id: 'b' }), b = t('b', { parent_task_id: 'a' })
    const looped = new Map([...byId, ['a', a], ['b', b]] as const)
    expect(chain(a, looped)).toEqual(['b', 'vp', 'main'])
  })

  it('the push skips one that is closed or has no session and stops at the first that hears', () => {
    const src = readFileSync(join(process.cwd(), 'src/core/sessions/status-push.ts'), 'utf8')
    const loop = src.slice(src.indexOf('for (const f of statusFollowersOf('), src.indexOf('for (const f of statusFollowersOf(') + 500)
    expect(loop).toMatch(/if \(!openTask\(f\)\) continue;/)
    expect(loop).toMatch(/if \(!rec\) continue;/)
    expect(loop).toMatch(/break;\n\s*\}/)
  })

  it('the push adds a follower in one place only', () => {
    const src = readFileSync(join(process.cwd(), 'src/core/sessions/status-push.ts'), 'utf8')
    // add(sid, rec, taskId, line, asker, at): asker=true is a session waiting on a reply; false, a follower.
    expect(src.match(/\badd\([^)]*,\s*false,\s*c\.at\)/g) ?? []).toHaveLength(1)
    expect(src).not.toMatch(/\[parent, vpOf\(task\), main\]/)
  })
})
