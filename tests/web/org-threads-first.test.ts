/**
 * Main's and a VP's own Threads come first on the Org page, counted one way everywhere (2026-11-03,
 * the user: "I think thread is better than need u, should show the thread, also thread should be
 * the first one in the list"; on a VP header: "remove xx open not needed also show thread and
 * number"). The counts are the server's (user_status.threads, threadCounts); a thread waiting on him
 * is drawn as the node's threads, and the node itself never reads a task's Needs you for it
 * (2026-11-03, the user: "All replaced to Need Action which is the same as the task status").
 * The red on the CEO's and a VP's own row, header and avatar is its threads, "0 threads" in grey
 * when none (2026-11-03, the user: "the little red should be thread instead of need u, also, even
 * if no thread, show 0 thread"); its tasks' asks are in its Tasks.
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

  it('a VP row leads with its threads, and they are its badge and its red', () => {
    const { rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    const vp = rows.find((r) => r.contactId === 'vp')!
    expect(vp.latest).toBe('2 threads: th-a title')
    expect(vp.state).toBe('alert')
    expect(vp.threadsBadge).toBe(2)
    expect(vp.alerts.map((a) => a.taskId)).toEqual(['w1'])
    expect(vp.threads).toEqual(counts)
  })

  it('the CEO row puts its own threads first, and no Needs you of its teams', () => {
    const { main } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    expect(main.latest.split(' · ')[0]).toBe('2 threads: th-a title')
    expect(main.threadsBadge).toBe(2)
    expect(main.state).toBe('alert')
    expect(main.latest).not.toMatch(/Needs you/)
  })

  it('with no thread for him: "0 threads", and a task\'s ask makes no red on the node', () => {
    const none = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', isLead: true })
    const noMain = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', isMain: true })
    const list = tasks.map((x) => (x.id === 'vp' ? { ...x, user_status: none } : x.id === 'main' ? { ...x, user_status: noMain } : x))
    const probe: AlertProbe = (x) => (x.id === 'w1' ? { kind: 'needs' } as ReturnType<AlertProbe> : null)
    const { main, rows } = buildChannels(buildOrgTree(list), list, probe)
    const vp = rows.find((r) => r.contactId === 'vp')!
    expect(vp.threadsBadge).toBe(0)
    expect(vp.state).not.toBe('alert')
    expect(vp.alerts.map((a) => a.taskId)).toEqual(['w1'])
    expect(main.threadsBadge).toBe(0)
    expect(main.latest.split(' · ')[0]).toBe('0 threads')
    expect(main.state).not.toBe('alert')
  })

  it('the list badge and the chart badges of a node are its threads, grey at 0', () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, '../../web/src/components/org', f), 'utf8')
    const list = read('OrgChannelList.tsx')
    expect(list).toMatch(/row\.threadsBadge !== undefined[\s\S]{0,200}is-alert' : 'is-none'/)
    const chart = read('OrgChartSheet.tsx')
    expect(chart).toMatch(/org-chart-ceo-threads/)
    expect(chart).toMatch(/org-chart-vp-threads/)
  })

  it('the node header counts threads first, always, with no Needs you of its own and no "open" pill', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/components/org/OrgNodeDetail.tsx'), 'utf8')
    const pills = src.slice(src.indexOf('function CountPills'), src.indexOf('function TeamLiveLine'))
    expect(pills).not.toMatch(/\} open</)
    expect(pills).toMatch(/\{keepsThreads && \(/)
    expect(pills).toMatch(/!keepsThreads && tabs\.needs/)
    expect(pills.indexOf('org-pill-threads')).toBeGreaterThan(0)
    expect(pills.indexOf('org-pill-threads')).toBeLessThan(pills.indexOf("pill('working'"))
  })

  it('every web count of threads goes through threadCounts (one predicate, one number)', () => {
    const root = path.join(__dirname, '../../web/src')
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : [])
    // A count is a filter on shownToHim's verdict; only the Threads view itself lists with it.
    const counting = walk(root).filter((f) => /filter\(\([^)]*\) => shownToHim\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f))
    expect(counting.filter((f) => !f.endsWith('OrgThreads.tsx'))).toEqual([])
  })

  it('the VP itself is no Needs you, and a thread coming or going is no status move above', () => {
    const vp = tasks.find((x) => x.id === 'vp')!
    expect(vp.user_status?.state).not.toBe('needs')
    const idle = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', isLead: true, threads: counts })
    const none = deriveUserStatus({ phase: 'IN_PROGRESS', hasSession: true, processStatus: 'idle', isLead: true })
    const withThread = { ...vp, user_status: idle }
    const without = { ...vp, user_status: none }
    expect(seenOf(withThread).key).toBe(seenOf(without).key)
    expect(briefMark(withThread)).toBe(briefMark(without))
  })
})
