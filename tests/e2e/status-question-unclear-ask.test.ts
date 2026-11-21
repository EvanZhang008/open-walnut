/**
 * A task's turn-end ask the user could not read on its own is asked once more, with the reason, on a
 * real server with only the CLI faked (src/core/sessions/status-question.ts, org/ask-clarity.ts;
 * 2026-11-21, the user: "I think you write it well, but the ones below do not": the workers' asks
 * reach him through these lines, and no check read them).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-status-question-unclear-ask'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { askStatus, settleStatusQuestion } from '../../src/core/sessions/status-question.js'
import { __resetUnclearAsk, setAskJudgeOverride } from '../../src/core/sessions/unclear-ask.js'

const SID = 'unclear-ask-session'
let taskId = ''

function fakeSession(answers: string[]) {
  let i = 0
  const fake = { sessionId: SID, askSideQuestion: vi.fn(async () => answers[Math.min(i++, answers.length - 1)]), detach: () => {}, kill: () => {}, get active() { return false } }
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.set(SID, fake)
  return fake
}

const lines = (ask: string, more = '', options = '') => [
  'FOR_USER_STATE: needs-you',
  `FOR_USER_ASK: ${ask}`,
  'FOR_USER_ASK_OWN: user_own: he decides what his daily screen shows',
  ...(options ? ['FOR_USER_ASK_KIND: single', `FOR_USER_ASK_OPTIONS: ${options}`] : []),
  ...(more ? [`FOR_USER_ASK_MORE: ${more}`] : []),
].join('\n')

// The worker's card the user could not read, word for word (as test data, escaped).
const UNCLEAR = lines('\u653e\u8fd9\u4e2a\u4f4d\u7f6e\u884c\u5417\uff1f', '', '\u653e\u8fd9\u91cc\uff0c\u4e0a\u7ebf | Keep it in Settings only')
const CLEAR_ASK = 'Show the Wi-Fi sign-in entry (opens the hotel login page) as a row under All devices?'
const CLEAR = lines(CLEAR_ASK, 'Mockup: /home/user/.local/state/walnut/tasks/t1/wifi.png Reviewed: sol, function 8/10, experience 8/10, interface 7/10', 'Show it under All devices (recommended) | Keep it in Settings only')

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  expect((server.address() as AddressInfo).port).toBeGreaterThan(0)
  taskId = (await addTask({ title: 'Wi-Fi sign-in entry', project: 'Walnut' })).task.id
  await updateTaskRaw(taskId, { phase: 'IN_PROGRESS', session_id: SID }, { source: 'test' })
})

afterAll(async () => {
  await settleStatusQuestion(SID, 10_000)
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.delete(SID)
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a turn-end ask that does not read on its own', () => {
  beforeEach(() => __resetUnclearAsk())
  it('is asked again once with the reason, and the rewrite is what the user gets', async () => {
    const fake = fakeSession([UNCLEAR, CLEAR])
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    expect(fake.askSideQuestion).toHaveBeenCalledTimes(2)
    const retry = fake.askSideQuestion.mock.calls[1][0] as string
    expect(retry).toMatch(/Your FOR_USER_ASK was not shown to the user\. Not sent to the user: the question points at a place only you can see/)
    const report = (await getTask(taskId)).status_report!
    expect(report).toMatchObject({ state: 'needs', ask: CLEAR_ASK })
    expect(report.ask_options?.[0]).toMatchObject({ label: 'Show it under All devices', recommended: true })
  })

  it('a clear ask is asked once: no second question, no cost', async () => {
    const fake = fakeSession([CLEAR])
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    expect(fake.askSideQuestion).toHaveBeenCalledTimes(1)
  })

  it('a second miss still reaches the user, never dropped, and is not asked again at the next turn end', async () => {
    const fake = fakeSession([UNCLEAR, UNCLEAR])
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    expect(fake.askSideQuestion).toHaveBeenCalledTimes(2)
    const next = fakeSession([UNCLEAR])
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    expect(next.askSideQuestion).toHaveBeenCalledTimes(1)
    expect((await getTask(taskId)).status_report).toMatchObject({ state: 'needs', ask: '\u653e\u8fd9\u4e2a\u4f4d\u7f6e\u884c\u5417\uff1f' })
  })

  it('an ask the words let through, that the fast model finds unreadable, is asked again with its fixes', async () => {
    const JARGON = 'Approve the ZQX high-side pairing for the 7 accounts? Reply with the number or click the link.'
    const FIXED = 'Approve 7 hours of read-only access to the 7 production alert accounts (ticket https://example.com/t/1)?'
    setAskJudgeOverride(async (card) => (card.includes('ZQX') ? '- Say what ZQX and the high side are\n- Give the number and the link' : 'PASS'))
    try {
      const fake = fakeSession([lines(JARGON), lines(FIXED, '', 'Approve the access (recommended) | Do not approve')])
      expect(await askStatus(taskId, SID, Date.now())).toBe(true)
      expect(fake.askSideQuestion).toHaveBeenCalledTimes(2)
      const retry = fake.askSideQuestion.mock.calls[1][0] as string
      expect(retry).toMatch(/could not answer it from the card\. Fix: - Say what ZQX and the high side are - Give the number and the link/)
      // The session reads back what it wrote: the side question keeps no memory of the first answer.
      expect(retry).toContain(`Your answer was:\nFOR_USER_STATE: needs-you\nFOR_USER_ASK: ${JARGON}`)
      expect((await getTask(taskId)).status_report).toMatchObject({ state: 'needs', ask: FIXED })
      // The same ask at the next turn end is not judged or asked again.
      const quiet = fakeSession([lines(FIXED, '', 'Approve the access (recommended) | Do not approve')])
      expect(await askStatus(taskId, SID, Date.now())).toBe(true)
      expect(quiet.askSideQuestion).toHaveBeenCalledTimes(1)
    } finally { setAskJudgeOverride(null) }
  })

  it('a retry that answers nothing keeps the first answer', async () => {
    fakeSession([UNCLEAR, 'I cannot answer that now.'])
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    expect((await getTask(taskId)).status_report?.state).toBe('needs')
  })
})
