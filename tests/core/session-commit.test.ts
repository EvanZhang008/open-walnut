/**
 * The server half of session commit (src/core/session-commit.ts): the plan
 * relay, the job runner that starts a daemon job and polls it while every
 * change goes out as a `git-commit:job` event, and the Suggest prompt. The
 * daemon, the session store and the model are fakes; nothing here touches git.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  __setSessionCommitDepsForTesting,
  cleanSuggestedMessage,
  getSessionCommitJob,
  getSessionCommitPlan,
  startSessionCommitJob,
  suggestSessionCommitMessage,
  type ServerCommitJob,
  type SessionCommitDeps,
} from '../../src/core/session-commit.js'

interface FakeDaemon {
  caps: string[]
  calls: Array<{ cmd: string; params: Record<string, unknown> }>
  answer: (cmd: string, params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
}

function setup(daemon: FakeDaemon, extra: Partial<SessionCommitDeps> = {}) {
  const published: ServerCommitJob[] = []
  let clock = 1_000
  __setSessionCommitDepsForTesting({
    sessionById: async (sid) => (sid === 'sess-1' ? { cwd: '/work/repo', host: undefined, title: 'Fix the parser', taskId: 'task-1' } : null),
    connection: async () => ({
      hasCapability: (c: string) => daemon.caps.includes(c),
      send: async (cmd: string, params: Record<string, unknown>) => { daemon.calls.push({ cmd, params }); return daemon.answer(cmd, params) },
    }),
    repoRootsFor: async () => ['/work/repo'],
    publish: (job) => { published.push(job) },
    now: () => (clock += 10),
    sleep: async () => { /* no real waiting */ },
    taskTitle: async () => 'Parser task',
    ...extra,
  })
  return { published }
}

async function settle(sessionId: string, jobId: string): Promise<ServerCommitJob> {
  for (let i = 0; i < 200; i++) {
    const j = getSessionCommitJob(sessionId, jobId)
    if (j && j.state !== 'running') return j
    await new Promise((r) => setImmediate(r))
  }
  throw new Error('job never finished')
}

afterEach(() => { __setSessionCommitDepsForTesting(null) })

describe('getSessionCommitPlan', () => {
  it('relays the daemon plan; repo roots come from the server only without changes-v1', async () => {
    const daemon: FakeDaemon = { caps: ['git-commit-v1', 'changes-v1'], calls: [], answer: () => ({ ok: true, attributed: true, repos: [{ repoRoot: '/work/repo' }] }) }
    setup(daemon)
    expect(await getSessionCommitPlan('sess-1')).toMatchObject({ attributed: true, repos: [{ repoRoot: '/work/repo' }] })
    expect(daemon.calls[0]).toMatchObject({ cmd: 'git.commitPlan', params: { sid: 'sess-1', cwd: '/work/repo', repoRoots: [] } })
    daemon.caps = ['git-commit-v1']
    await getSessionCommitPlan('sess-1')
    expect(daemon.calls[1].params.repoRoots).toEqual(['/work/repo'])
  })

  it('maps a missing session to 404 and a daemon error to 502', async () => {
    setup({ caps: ['git-commit-v1'], calls: [], answer: () => ({ ok: false, error: 'git.commitPlan failed: boom' }) })
    await expect(getSessionCommitPlan('nope')).rejects.toMatchObject({ status: 404 })
    await expect(getSessionCommitPlan('sess-1')).rejects.toMatchObject({ status: 502, message: 'boom' })
  })
})

describe('startSessionCommitJob', () => {
  it('answers at once, then follows the daemon job to its end and publishes each change', async () => {
    let polls = 0
    const daemon: FakeDaemon = {
      caps: ['git-commit-v1'], calls: [],
      answer: (cmd) => {
        if (cmd === 'git.commitStart') return { ok: true, job: { id: 'gc-1', state: 'running', step: 'checking', output: '' } }
        polls++
        if (polls === 1) return { ok: true, job: { id: 'gc-1', state: 'running', step: 'pre-commit', output: 'lint ok\n' } }
        if (polls === 2) return { ok: true, job: { id: 'gc-1', state: 'running', step: 'pre-commit', output: 'lint ok\n' } }
        return { ok: true, job: { id: 'gc-1', state: 'succeeded', step: 'updating-index', output: 'lint ok\n', result: { sha: 'abc1234def' } } }
      },
    }
    const { published } = setup(daemon)
    const job = await startSessionCommitJob('sess-1', {
      action: 'commit', repoRoot: '/work/repo', branch: 'main', expectedHead: 'h1', message: 'Fix it', selections: [{ path: 'a.ts', mode: 'whole' }], extra: 'dropped',
    })
    expect(job).toMatchObject({ state: 'running', action: 'commit', sessionId: 'sess-1' })
    const done = await settle('sess-1', job.id)
    expect(done).toMatchObject({ state: 'succeeded', result: { sha: 'abc1234def' }, output: 'lint ok\n' })
    const start = daemon.calls.find((c) => c.cmd === 'git.commitStart')!
    expect(start.params).toEqual({ action: 'commit', repoRoot: '/work/repo', branch: 'main', message: 'Fix it', selections: [{ path: 'a.ts', mode: 'whole' }], expectedHead: 'h1' })
    expect(daemon.calls.filter((c) => c.cmd === 'git.commitJob').every((c) => c.params.jobId === 'gc-1')).toBe(true)
    // One event per change, not per poll: the unchanged second poll published nothing.
    expect(published.map((p) => p.step)).toEqual(['checking', 'pre-commit', 'updating-index'])
    expect(published.at(-1)!.state).toBe('succeeded')
  })

  it('refuses bad input before reaching the daemon, and a second job in the same repo', async () => {
    const daemon: FakeDaemon = { caps: ['git-commit-v1'], calls: [], answer: (cmd) => (cmd === 'git.commitStart' ? { ok: true, job: { id: 'gc-2', state: 'running', step: 'x', output: '' } } : new Promise<Record<string, unknown>>(() => { /* never answers */ })) }
    setup(daemon)
    await expect(startSessionCommitJob('sess-1', { action: 'commit', repoRoot: '/r', message: ' ', selections: [{}] })).rejects.toMatchObject({ code: 'empty-message' })
    await expect(startSessionCommitJob('sess-1', { action: 'commit', repoRoot: '/r', message: 'm', selections: [] })).rejects.toMatchObject({ code: 'nothing-selected' })
    await expect(startSessionCommitJob('sess-1', { action: 'rebase', repoRoot: '/r' })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(startSessionCommitJob('sess-1', { action: 'pr', repoRoot: '/r', title: '' })).rejects.toMatchObject({ code: 'bad-request' })
    expect(daemon.calls).toHaveLength(0)
    await startSessionCommitJob('sess-1', { action: 'push', repoRoot: '/r' })
    await expect(startSessionCommitJob('sess-1', { action: 'push', repoRoot: '/r' })).rejects.toMatchObject({ status: 409, code: 'busy' })
  })

  it('a daemon refusal and a daemon that forgot the job both end the job as failed', async () => {
    const refusing: FakeDaemon = { caps: ['git-commit-v1'], calls: [], answer: () => ({ ok: false, error: 'git.commitStart failed: Another commit or push is running in this repository.', code: 'busy' }) }
    setup(refusing)
    const a = await startSessionCommitJob('sess-1', { action: 'push', repoRoot: '/r1' })
    expect(await settle('sess-1', a.id)).toMatchObject({ state: 'failed', error: { code: 'busy', message: 'Another commit or push is running in this repository.' } })

    const forgetful: FakeDaemon = { caps: ['git-commit-v1'], calls: [], answer: (cmd) => (cmd === 'git.commitStart' ? { ok: true, job: { id: 'gc-3', state: 'running', step: 'pushing', output: '' } } : { ok: true, job: null }) }
    setup(forgetful)
    const b = await startSessionCommitJob('sess-1', { action: 'push', repoRoot: '/r2' })
    const lost = await settle('sess-1', b.id)
    expect(lost.state).toBe('failed')
    expect(lost.error?.code).toBe('lost')
    expect(lost.error?.message).toMatch(/may or may not have happened/)
  })

  it('a job of another session is not readable', async () => {
    setup({ caps: ['git-commit-v1'], calls: [], answer: () => ({ ok: true, job: { id: 'gc-4', state: 'succeeded', step: 'x', output: '' } }) })
    const j = await startSessionCommitJob('sess-1', { action: 'push', repoRoot: '/r3' })
    expect(getSessionCommitJob('sess-2', j.id)).toBeNull()
  })
})

describe('Suggest', () => {
  it('sends the diff, files and titles to the fast model and cleans the answer', async () => {
    let prompt = ''
    setup({ caps: [], calls: [], answer: () => ({}) }, {
      askModel: async (_system, p) => { prompt = p; return '```\nCommit message: "Fix the tokenizer for CRLF input"\n\nKeeps line endings intact.\n```' },
    })
    const res = await suggestSessionCommitMessage('sess-1', { diff: '--- a/x\n+++ b/x\n+fixed', files: ['x'] })
    expect(res.message).toBe('Fix the tokenizer for CRLF input\n\nKeeps line endings intact.')
    expect(prompt).toContain('Task: Parser task')
    expect(prompt).toContain('Session: Fix the parser')
    expect(prompt).toContain('Files: x')
    expect(prompt).toContain('+fixed')
  })

  it('answers 503 when the model gives nothing, and 400 without a diff', async () => {
    setup({ caps: [], calls: [], answer: () => ({}) }, { askModel: async () => null })
    await expect(suggestSessionCommitMessage('sess-1', { diff: 'x' })).rejects.toMatchObject({ status: 503 })
    await expect(suggestSessionCommitMessage('sess-1', { diff: '  ' })).rejects.toMatchObject({ status: 400 })
  })

  it('cleanSuggestedMessage keeps a subject and a short body', () => {
    expect(cleanSuggestedMessage('Add retry to the uploader')).toBe('Add retry to the uploader')
    expect(cleanSuggestedMessage('"Add retry"')).toBe('Add retry')
    expect(cleanSuggestedMessage('## Add retry\n\n\nBecause uploads fail.')).toBe('Add retry\n\nBecause uploads fail.')
    expect(cleanSuggestedMessage('   ')).toBeNull()
  })
})
