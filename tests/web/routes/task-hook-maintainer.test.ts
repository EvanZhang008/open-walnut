/**
 * E2E: task lifecycle → overview maintainer wiring.
 *
 * What's real: Express server, REST task creation/completion, event bus,
 * overview-maintainer gating, the maintainer TOOL SET (wrapped skill_manage
 * writing real files under the temp WALNUT_HOME).
 * What's mocked: constants.js (temp dir) and runAgentLoop — the mock plays the
 * model's part by invoking the maintainer's own tools (log_append), so the
 * full REST → bus → hook → tool → file path is exercised without the network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

interface LoopCall {
  userMessage: string
  options?: {
    system?: string
    source?: string
    tools?: Array<{ name: string; execute: (p: Record<string, unknown>) => Promise<unknown> }>
  }
}
const loopCalls: LoopCall[] = []

vi.mock('../../../src/agent/loop.js', () => ({
  runAgentLoop: vi.fn(async (
    userMessage: string | unknown[],
    _history: unknown[],
    _callbacks?: unknown,
    options?: LoopCall['options'],
  ) => {
    loopCalls.push({ userMessage: String(userMessage), options })
    // Play the model: the maintainer's ALWAYS action is one log_append.
    if (options?.source === 'task-hook') {
      const skillManage = options.tools?.find((t) => t.name === 'skill_manage')
      await skillManage?.execute({ action: 'log_append', content: `Hook entry for: ${String(userMessage).slice(0, 60)}` })
    }
    return {
      messages: [], newMessages: [], response: 'Appended one entry.', aborted: false,
    }
  }),
}))

import type { Server as HttpServer } from 'node:http'
import { WALNUT_HOME, GLOBAL_SKILLS_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { resetMaintainerState } from '../../../src/agent/overview-maintainer.js'
import { skillHistoryDir } from '../../../src/core/overview-log.js'
import { clearSkillsCache } from '../../../src/core/skill-loader.js'

let server: HttpServer
let port: number

/** Skill grouping directory (NOT a task category — that concept is gone). */
const SKILL_CAT = 'hookgroup'
/** Task project name; also the skill dir name the maintainer resolves it to. */
const PROJECT = 'hookproj'

async function seedProjectSkill(name = PROJECT, skillCategory = SKILL_CAT): Promise<void> {
  const dir = path.join(GLOBAL_SKILLS_DIR, skillCategory, name)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: '${name} project skill'\ntype: knowledge\n---\n\n# ${name}\n`,
  )
}

async function post(pathname: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const hookCalls = () => loopCalls.filter((c) => c.options?.source === 'task-hook')

describe('task lifecycle → overview maintainer (full server)', () => {
  beforeEach(async () => {
    loopCalls.length = 0
    resetMaintainerState()
    clearSkillsCache()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
    await fsp.mkdir(WALNUT_HOME, { recursive: true })
    await seedProjectSkill()
    server = await startServer({ port: 0, dev: true })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  })

  afterEach(async () => {
    await stopServer()
    await new Promise((r) => setTimeout(r, 100))
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })

  it("REST task create fires the maintainer, which appends to the project skill's log", async () => {
    const res = await post('/api/tasks', {
      title: 'Wire the task hook',
      project: PROJECT,
    })
    expect(res.status).toBe(201)

    await waitFor(() => hookCalls().length === 1)
    const call = hookCalls()[0]
    expect(call.userMessage).toContain('[Task created]')
    expect(call.userMessage).toContain('Wire the task hook')
    expect(call.options?.system).toContain('overview maintainer')
    // Restricted tool set: wrapped skill_manage + read-only skill_view, nothing else.
    expect(call.options?.tools?.map((t) => t.name)).toEqual(['skill_manage', 'skill_view'])

    // The mock model's log_append landed in the real file.
    const logFile = path.join(skillHistoryDir(SKILL_CAT, PROJECT), 'log.md')
    await waitFor(() => fs.existsSync(logFile))
    const raw = fs.readFileSync(logFile, 'utf-8')
    expect(raw).toContain('Hook entry for:')
    expect(raw).toContain('task-hook')
  })

  it('does not fire for a project without a skill', async () => {
    const res = await post('/api/tasks', {
      title: 'Task in a skill-less project',
      project: 'plain',
    })
    expect(res.status).toBe(201)
    await new Promise((r) => setTimeout(r, 400))
    expect(hookCalls()).toHaveLength(0)
  })

  it('does not fire for an Inbox task (no project)', async () => {
    const res = await post('/api/tasks', { title: 'Loose capture' })
    expect(res.status).toBe(201)
    await new Promise((r) => setTimeout(r, 400))
    expect(hookCalls()).toHaveLength(0)
  })

  it('completing a task fires the maintainer with [Task completed]', async () => {
    const createRes = await post('/api/tasks', { title: 'Finish me', project: PROJECT })
    expect(createRes.status).toBe(201)
    const { task } = await createRes.json() as { task: { id: string } }
    await waitFor(() => hookCalls().length === 1)

    const completeRes = await post(`/api/tasks/${task.id}/complete`, {})
    expect(completeRes.status).toBe(200)

    await waitFor(() => hookCalls().length === 2)
    expect(hookCalls()[1].userMessage).toContain('[Task completed]')
    expect(hookCalls()[1].userMessage).toContain('Finish me')
  })
})
