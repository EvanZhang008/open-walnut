/**
 * E2E: task lifecycle → overview maintainer wiring.
 *
 * What's real: Express server, REST task creation/completion, event bus,
 * overview-maintainer gating, and the maintainer's own writes (real files under
 * the temp WALNUT_HOME).
 * What's mocked: constants.js (temp dir) and the model call — the stub plays the
 * model's part by answering with the JSON object the maintainer asks for, so the
 * full REST → bus → hook → write path is exercised without the network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

/**
 * Every prompt the MAINTAINER sent, in order. Filtered by its system prompt:
 * a live server has other one-shot model callers (project summaries, titling,
 * auto-organize) and an unfiltered spy counts those as maintainer runs.
 */
const prompts: string[] = []
const MAINTAINER_MARKER = 'overview maintainer'

type SendOpts = { system?: string; tools?: unknown }
/** The maintainer's own calls, in order. */
function maintainerCalls(): SendOpts[] {
  return sendMessage.mock.calls
    .map((c) => c[0] as SendOpts)
    .filter((o) => String(o.system ?? '').includes(MAINTAINER_MARKER))
}

const { sendMessage } = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}))

// Only the send is stubbed: everything else in the model module (context-window
// helpers, DEFAULT_MODEL) is used by unrelated server code in this same process.
vi.mock('../../../src/model/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/model/model.js')>()),
  sendMessage,
}))

import type { Server as HttpServer } from 'node:http'
import { WALNUT_HOME, GLOBAL_SKILLS_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { resetMaintainerState } from '../../../src/core/overview-maintainer.js'
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

describe('task lifecycle → overview maintainer (full server)', () => {
  beforeEach(async () => {
    prompts.length = 0
    sendMessage.mockReset()
    sendMessage.mockImplementation(async (opts: { system?: string; messages: Array<{ content: unknown }> }) => {
      const userMessage = String(opts.messages[0]?.content ?? '')
      const isMaintainer = String(opts.system ?? '').includes(MAINTAINER_MARKER)
      if (isMaintainer) prompts.push(userMessage)
      return {
        content: [{
          type: 'text',
          // Anything that is not the maintainer gets an answer it will reject
          // and drop; only the maintainer's own call gets a usable one.
          text: isMaintainer ? JSON.stringify({ log: `Hook entry for: ${userMessage.slice(0, 60)}` }) : '',
        }],
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      }
    })
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

    await waitFor(() => prompts.length === 1)
    expect(prompts[0]).toContain('[Task created]')
    expect(prompts[0]).toContain('Wire the task hook')
    // One JSON answer, no tools: the maintainer can only write through this module.
    expect(prompts[0]).toContain('"log"')
    expect(maintainerCalls()).toHaveLength(1)
    expect(maintainerCalls()[0].tools).toBeUndefined()

    // The stub model's answer landed in the real file.
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
    expect(prompts).toHaveLength(0)
  })

  it('does not fire for an Inbox task (no project)', async () => {
    const res = await post('/api/tasks', { title: 'Loose capture' })
    expect(res.status).toBe(201)
    await new Promise((r) => setTimeout(r, 400))
    expect(prompts).toHaveLength(0)
  })

  it('completing a task fires the maintainer with [Task completed]', async () => {
    const createRes = await post('/api/tasks', { title: 'Finish me', project: PROJECT })
    expect(createRes.status).toBe(201)
    const { task } = await createRes.json() as { task: { id: string } }
    await waitFor(() => prompts.length === 1)

    const completeRes = await post(`/api/tasks/${task.id}/complete`, {})
    expect(completeRes.status).toBe(200)

    await waitFor(() => prompts.length === 2)
    expect(prompts[1]).toContain('[Task completed]')
    expect(prompts[1]).toContain('Finish me')
  })
})
