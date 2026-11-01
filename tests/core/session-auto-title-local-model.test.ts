/**
 * An ACP session whose Walnut runs on a model server the user hosts is titled by
 * Walnut's own model call first (src/core/session-hooks/builtins.ts askAndApplyTitle).
 * 2026-11-01: an 8B model on OpenCode never got an AI title: asking the session meant a
 * whole-thread turn on the same Ollama, queued behind the turn-end report, and the model
 * answered status questions with tools. A cloud setup still asks the session first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-auto-title-local'))

const backendTitle = vi.fn(async () => 'Word count fix' as string | null)
vi.mock('../../src/core/session-title-backend.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/session-title-backend.js')>()),
  backendTitleAvailable: () => true,
  titleViaBackendModel: (...args: unknown[]) => backendTitle(...(args as [])),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask, getTask, updateTask, _resetForTesting as resetTaskManager } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { sessionAutoTitleHook, __resetAutoTitleState } from '../../src/core/session-hooks/builtins.js'
import { defaultSessionTaskTitle } from '../../src/core/sessions/quick-start.js'

const CWD = '/tmp/demo-project'
const PLACEHOLDER = defaultSessionTaskTitle(CWD)
let n = 0

async function acpTask() {
  const sid = `auto-title-local-${++n}`
  const { task } = await addTask({ title: PLACEHOLDER })
  await updateTask(task.id, { cwd: CWD }, { source: 'test' })
  await createSessionRecord(sid, task.id, 'Quick Start', CWD, { title: PLACEHOLDER })
  const fake = { sessionId: sid, runtimeId: `rt-${sid}`, activity: 'idle', requestTurnCompleteSelfReport: vi.fn(async () => 'Session title') }
  ;(sessionRunner as unknown as { acpSessions: Map<string, unknown> }).acpSessions.set(sid, fake)
  const run = () => sessionAutoTitleHook.handler({
    sessionId: sid, taskId: task.id, task: taskRef(task.id), timestamp: new Date().toISOString(), traceId: 't',
    message: 'count.py counts words wrong, fix it', isResume: false, source: 'ui',
  } as never)
  return { sid, taskId: task.id, fake, run }
}
const taskRef = (id: string) => ({ id, title: PLACEHOLDER, cwd: CWD })

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetTaskManager()
  __resetAutoTitleState(10)
  backendTitle.mockClear()
})

afterEach(async () => {
  const map = (sessionRunner as unknown as { acpSessions: Map<string, unknown> }).acpSessions
  for (const key of [...map.keys()]) if (String(key).startsWith('auto-title-local-')) map.delete(key)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('ACP session title on a local model', () => {
  it('Walnut\'s own model call titles it, and the session is never asked', async () => {
    await updateConfig({
      providers: { ollama: { api: 'ollama', base_url: 'http://127.0.0.1:9' } },
      agent: { main_provider: 'ollama', main_model: 'qwen3:8b' },
    } as never)
    const { taskId, fake, run } = await acpTask()
    await run()
    expect(backendTitle).toHaveBeenCalledTimes(1)
    expect(fake.requestTurnCompleteSelfReport).not.toHaveBeenCalled()
    expect((await getTask(taskId)).title).toBe('Word count fix')
  })

  it('the session is still asked when Walnut\'s model call gives nothing', async () => {
    await updateConfig({
      providers: { ollama: { api: 'ollama', base_url: 'http://127.0.0.1:9' } },
      agent: { main_provider: 'ollama', main_model: 'qwen3:8b' },
    } as never)
    backendTitle.mockResolvedValueOnce(null)
    const { taskId, fake, run } = await acpTask()
    await run()
    expect(fake.requestTurnCompleteSelfReport).toHaveBeenCalledTimes(1)
    expect((await getTask(taskId)).title).toBe('Session title')
  })

  it('a cloud setup asks the session first, as before', async () => {
    const { taskId, fake, run } = await acpTask()
    await run()
    expect(fake.requestTurnCompleteSelfReport).toHaveBeenCalledTimes(1)
    expect(backendTitle).not.toHaveBeenCalled()
    expect((await getTask(taskId)).title).toBe('Session title')
  })
})
