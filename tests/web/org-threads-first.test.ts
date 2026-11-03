/**
 * Main's and a VP's own Threads come first on the Org page, counted one way everywhere (2026-11-03,
 * the user: "I think thread is better than need u, should show the thread, also thread should be
 * the first one in the list"; on a VP header: "remove xx open not needed also show thread and
 * number"). The counts are the server's (user_status.threads, threadCounts); the node's own Needs
 * you from a thread is drawn as its threads, never a second card.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree } from '../../src/core/org/org-tree.js'
import { threadCounts, threadLine } from '../../src/core/org/thread-view.js'
import { deriveUserStatus } from '../../src/core/user-status.js'
import { buildChannels, type AlertProbe } from '../../web/src/components/org/org-channels-model.js'
import { seenOf } from '../../src/core/sessions/status-push.js'
import { briefMark } from '../../src/core/sessions/brief-fresh.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 3, 7, min)).toISOString()
const t = (id: string, project: string, extra: Partial<Task> = {}): Task => ({
  id, title: `${id} title`, project, phase: 'IN_PROGRESS', status: 'todo', priority: 'none', created_at: at(0), updated_at: at(1), ...extra,
} as Task)
const noAlerts: AlertProbe = () => null

const thread = (id: string, state: string, updatedAt: string) => ({
  id, title: `${id} title`, state, updatedAt, messages: [{ id: `${id}-m`, at: updatedAt, text: 'my ask' }],
})

describe('threads come first', () => {
  const counts = threadCounts([thread('th-a', 'needs', at(5)), thread('th-b', 'answered', at(9)), thread('th-c', 'working', at(9))], Date.parse(at(30)))
  const vpStatus = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'running', isLead: true, threads: counts })
  const mainStatus = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', isMain: true, threads: { ...counts, needs: 0 } })
  const tasks = [
    t('main', 'Ask Walnut', { org_role: 'main', user_status: mainStatus }),
    t('vp', 'Walnut', { org_role: 'lead', title: 'Walnut VP', user_status: vpStatus }),
    t('w1', 'Walnut', { user_status: { state: 'needs', source: 'session', ask: 'Approve the spend' } }),
  ]

  it('counts what his view shows, and the ones waiting on him', () => {
    expect(counts).toMatchObject({ shown: 2, needs: 1, title: 'th-a title', id: 'th-a' })
    expect(threadLine(counts)).toBe('2 threads: th-a title')
  })

  it('a VP row leads with its thread, counts it in its badge, and draws no second card for it', () => {
    const { rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    const vp = rows.find((r) => r.contactId === 'vp')!
    expect(vp.latest).toBe('2 threads: th-a title')
    expect(vp.state).toBe('alert')
    expect(vp.alerts.map((a) => a.taskId)).toEqual(['w1'])
    expect(vp.needs).toBe(2)
    expect(vp.threads).toEqual(counts)
  })

  it('the CEO row puts its own threads first, and counts only tasks as Needs you', () => {
    const { main } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    expect(main.latest.split(' · ')[0]).toBe('2 threads')
    // One worker ask: the VP's thread is a thread on its row, not a second Needs you here.
    expect(main.latest).toContain('1 Needs you')
  })

  it('a thread that only shows an answer never hides a task\'s ask on the row', () => {
    const answered = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', isLead: true, threads: { ...counts, needs: 0 } })
    const list = tasks.map((x) => (x.id === 'vp' ? { ...x, user_status: answered } : x))
    const probe: AlertProbe = (x) => (x.id === 'w1' ? { kind: 'needs' } as ReturnType<AlertProbe> : null)
    const vp = buildChannels(buildOrgTree(list), list, probe).rows.find((r) => r.contactId === 'vp')!
    expect(vp.latest).not.toMatch(/thread/)
    expect(vp.needs).toBe(1)
  })

  it('the node header counts threads first and shows no "open" pill', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/components/org/OrgNodeDetail.tsx'), 'utf8')
    const pills = src.slice(src.indexOf('function CountPills'), src.indexOf('function TeamLiveLine'))
    expect(pills).not.toMatch(/\} open</)
    expect(pills.indexOf('org-pill-threads')).toBeGreaterThan(0)
    expect(pills.indexOf('org-pill-threads')).toBeLessThan(pills.indexOf("pill('needs'"))
  })

  it('every web count of threads goes through threadCounts (one predicate, one number)', () => {
    const root = path.join(__dirname, '../../web/src')
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : [])
    // A count is a filter on shownToHim's verdict; only the Threads view itself lists with it.
    const counting = walk(root).filter((f) => /filter\(\([^)]*\) => shownToHim\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f))
    expect(counting.filter((f) => !f.endsWith('OrgThreads.tsx'))).toEqual([])
  })

  it('a move into or out of a thread\'s Needs you is no news above: the push and the Brief let it pass', () => {
    const vp = tasks.find((x) => x.id === 'vp')!
    expect(seenOf(vp).thread).toBe(true)
    expect(briefMark(vp)).toBe('open')
  })
})
