/**
 * A task does not close itself while its own work has not ended (src/core/sessions/own-work-open.ts).
 * 2026-11-24 and 11-25, the Walnut VP: tasks completed with a land still running, a production check
 * still to come, or a deploy watch still armed, and the VP reopened each by force.
 *
 * The real shapes: fd717c01 at 01:10:48 started its land in the background ("The land is still
 * running... I won't mark the task complete until I've checked production"); 2a6ec4cb closed at 21:08
 * with its deploy watch (live-trigger.sh, watches own) still armed; a result promising a check of
 * production once the change is live.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { admitOwnWorkEnded, pendingLines, type OwnWorkDeps } from '../../../src/core/sessions/own-work-open.js'

const quiet: OwnWorkDeps = { outliving: async () => [], openSubtasks: async () => [], armedTriggers: async () => [] }
const task = { id: 'task-own-work' }

describe('pendingLines: words that say the work is not over', () => {
  it.each([
    'The land is still running; I will check production after it is live.',
    'Tests are still running in the background.',
    "I'll verify on production once the deploy finishes.",
    'Once it is live I will take the short look at the change.',
    'Not live yet: the Mac takes it within a few minutes.',
    // Chinese as escapes: "check production again after it goes live", "the land is still running",
    // "wait for it to go live, then verify", "not yet deployed".
    '上线后再核对生产',
    'land 还在跑',
    '等它上线了再验证',
    '还没部署',
    // 713c0d39, 2026-11-26 05:5x Z, its own words when it closed with its review still open.
    'Commit e1b20d7bf1 is done and the review task mwx3sskd-d3d4 is running; I land once its findings come back',
    'I will land it after the review comes back.',
    // "Waiting for the review to come back before landing", "the review is still running".
    '等评审回来再 land',
    '评审还在跑',
  ])('%s', (line) => {
    expect(pendingLines([line]).length).toBeGreaterThan(0)
  })

  it.each([
    'Landed c0805e63e3 and it is live; I checked production: the new label shows.',
    'After it went live I looked at production and the list starts folded.',
    'Shipped and verified on production; the deep test judges it later.',
    // A real-use watch that runs past the close is how a shipped task is meant to end.
    'trigger_list watch uw-2b0aae55-758 is judged at 11-26 14:06Z',
    // "Went live, checked on production", "deployed".
    '已上线，我在线上确认了',
    '已部署',
    // How code behaves, never a run of its own (review of 2026-11-26).
    'Fixed: a session whose CLI is still running keeps its slot across a restart.',
    'land.sh now deploys only after the main is green.',
    'The banner hides once the task is merged into main.',
    'Root cause: the trigger kept firing when it is deployed twice.',
    // "Fixed deploy hanging (the deploy would hang), live already"; "changed A, B and so on, deployed".
    '修好了部署会卡住的问题，已上线',
    '改了 A、B 等，已部署',
    'land.sh deploys only after the tests are green.',
    'Fixed: the board refreshes once the task lands.',
    'The review came back clean; landed and live, checked on production.',
  ])('not: %s', (line) => {
    expect(pendingLines([line])).toEqual([])
  })
})

describe('admitOwnWorkEnded', () => {
  it('lets a close through when nothing of its own runs, waits or is promised', async () => {
    expect(await admitOwnWorkEnded(task, 'sid', { fields: { result: 'Live on production and checked there.' } }, quiet)).toBeNull()
  })

  it('refuses while its own background command runs (a land, a test run)', async () => {
    const r = await admitOwnWorkEnded(task, 'sid', { fields: { result: 'Fixed.' } }, { ...quiet, outliving: async () => ['a background command or subagent it started'] })
    expect(r).toMatchObject({ ok: false, code: 'own_work_open', items: [{ source: 'background' }] })
    expect(r!.message).toMatch(/Wait for it to end/)
  })

  it('refuses while a subtask of its own is still open (713c0d39: its review task still running)', async () => {
    const r = await admitOwnWorkEnded(task, 'sid', { fields: { result: 'Commit is done.' } }, { ...quiet, openSubtasks: async () => ['"Review: thread folds" (mwx3sskd-d3d4)'] })
    expect(r?.items).toEqual([{ source: 'subtask', text: '"Review: thread folds" (mwx3sskd-d3d4)' }])
    expect(r!.message).toMatch(/read its findings/)
  })

  it('refuses while a trigger still delivers into it (the deploy watch of its land)', async () => {
    const r = await admitOwnWorkEnded(task, 'sid', { fields: { result: 'Landed.' } }, { ...quiet, armedTriggers: async () => [{ id: 'mwwlwq7z-1a06', name: 'watches 1c9c6fa70b going live' }] })
    expect(r?.items).toEqual([{ source: 'trigger', text: 'trigger mwwlwq7z-1a06 (watches 1c9c6fa70b going live)' }])
    expect(r!.message).toMatch(/trigger_delete/)
  })

  it('refuses when its own result or not_done says a check comes after it goes live', async () => {
    const r = await admitOwnWorkEnded(task, 'sid', { fields: { result: 'Landed; deploying now.', not_done: ['I will check production after it is live'] } }, quiet)
    expect(r?.items.map((i) => i.source)).toEqual(['said'])
  })

  it('a close with no words of its own reads nothing; a not_done item of the user\'s is the owed gate\'s', async () => {
    expect(await admitOwnWorkEnded(task, 'sid', {}, quiet)).toBeNull()
    expect(await admitOwnWorkEnded(task, 'sid', { fields: { result: 'Fixed.', not_done: ['Waiting for the user to decide whether to deploy it'] } }, quiet)).toBeNull()
  })

  it('force with a reason closes past it; force without one is refused and says why', async () => {
    const deps = { ...quiet, outliving: async () => ['its agent team'] }
    expect(await admitOwnWorkEnded(task, 'sid', { force: true, reason: 'The team runs another task\'s review, not this one' }, deps)).toBeNull()
    const r = await admitOwnWorkEnded(task, 'sid', { force: true, reason: 'ok' }, deps)
    expect(r!.message).toMatch(/force needs a reason of 10\+ characters/)
  })

  it('a host that cannot say holds nothing', async () => {
    expect(await admitOwnWorkEnded(task, 'sid', {}, { ...quiet, outliving: async () => null })).toBeNull()
  })
})

describe('the close gate asks it for every close a task makes of itself', () => {
  it('admitSessionClose runs admitOwnWorkEnded in its own-close branch, after the held requests', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../../src/core/sessions/owed-to-user.ts'), 'utf-8')
    const own = src.slice(src.indexOf('if (closer.taskId === task.id && !opts.replayed) {'))
    const branch = own.slice(0, own.indexOf('\n  }\n'))
    expect(branch).toMatch(/admitHeldRequests\(/)
    expect(branch).toMatch(/admitOwnWorkEnded\(task, closer\.sessionId \?\? callerSid, opts\)/)
  })
})
