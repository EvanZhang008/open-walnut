import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'
import { REAL_PANEL, openDraftOnCwd } from './draft-helpers'

const SCREENSHOT_DIR = '/tmp/codex-customer-matrix-gap-final'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const BASE_PROMPT = 'recovery baseline persisted turn'
const BASE_REPLY = `hello from mock-acp (you said: ${BASE_PROMPT})`
const CRASH_PROMPT = 'lifecycle-slow-mobile crash the active worker'
const RECOVERY_PROMPT = 'lifecycle-slow-mobile resume and survive reload'
const CRASH_PARTIAL = 'thinking...'
const RECOVERY_REPLY = 'thinking...still working...done: slow reply'
const CRASH_BOUNDARY = 'Turn interrupted: the session worker crashed. Send a message to continue.'

interface SessionRecord {
  claudeSessionId: string
  acpRuntimeId: string
  acpJournalPath: string
  messageCount: number
  process_status: string
}

interface HistoryMessage {
  role: string
  text: string
}

interface JournalRecord {
  kind?: string
  source?: string
  event?: { type?: string }
  frame?: {
    method?: string
    params?: {
      update?: {
        content?: { text?: string }
      }
    }
  }
}

let fixtureRoot = ''
let walnutHome = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ fixtureRoot, walnutHome } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/**
 * Land on the Homepage and open a Codex draft session column on the fixture repo.
 * "+" grows the draft; the SAME picker (all `.sps-*` selectors) now lives inside
 * it, so ./draft-helpers owns the route in. Returns the draft panel — the first
 * message is composed in ITS composer, which is what launches the session.
 */
async function openCodexQuickStart(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  return openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`, { engine: 'Codex' })
}

async function sessionForTask(page: Page, taskId: string): Promise<SessionRecord> {
  let record: SessionRecord | undefined
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/task/${taskId}`)
    const body = await response.json() as { sessions: SessionRecord[] }
    record = body.sessions.find((session) => session.acpRuntimeId)
    return record?.claudeSessionId ?? ''
  }, { timeout: 15_000 }).not.toBe('')
  return record!
}

async function statusKey(page: Page, sessionId: string): Promise<string> {
  const response = await page.request.get(`/api/sessions/${sessionId}`)
  expect(response.status()).toBe(200)
  const body = await response.json() as { session: SessionRecord }
  return `${body.session.messageCount}:${body.session.process_status}`
}

async function historyFor(page: Page, sessionId: string): Promise<HistoryMessage[]> {
  const response = await page.request.get(`/api/sessions/${sessionId}/history`)
  expect(response.status()).toBe(200)
  return ((await response.json()) as { messages: HistoryMessage[] }).messages
}

async function journalRecords(journalPath: string): Promise<JournalRecord[]> {
  const journal = await fs.readFile(journalPath, 'utf-8')
  return journal.split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalRecord)
}

function workerRegistry(journalPath: string): string {
  return path.join(path.dirname(path.dirname(journalPath)), 'acp-workers.json')
}

async function workerPid(runtimeId: string, journalPath: string): Promise<number> {
  const registry = workerRegistry(journalPath)
  let pid = 0
  await expect.poll(async () => {
    try {
      const pids = JSON.parse(await fs.readFile(registry, 'utf-8')) as Record<string, number>
      pid = pids[runtimeId] ?? 0
      return pid
    } catch {
      return 0
    }
  }, { timeout: 15_000 }).toBeGreaterThan(0)
  return pid
}

async function expectWorkerReaped(runtimeId: string, journalPath: string): Promise<void> {
  const registry = workerRegistry(journalPath)
  await expect.poll(async () => {
    try {
      const pids = JSON.parse(await fs.readFile(registry, 'utf-8')) as Record<string, number>
      return pids[runtimeId] ?? 0
    } catch {
      return 0
    }
  }, { timeout: 15_000 }).toBe(0)
}

function transcript(messages: HistoryMessage[]): string[] {
  return messages.map((message) => `${message.role}:${message.text}`)
}

test('ACP worker death cold-resumes without replay and converges across a mid-stream reload', async ({ page }) => {
  test.setTimeout(60_000)
  const audit = await installBrowserAudit(page, walnutHome)

  const draft = await openCodexQuickStart(page)
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const quickInput = draft.locator('.chat-input-textarea')
  await quickInput.fill(BASE_PROMPT)
  await quickInput.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  const { taskId } = await quickStart.json() as { taskId: string }

  const panel = page.locator(REAL_PANEL)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByText(BASE_REPLY, { exact: true })).toHaveCount(1, { timeout: 20_000 })

  const session = await sessionForTask(page, taskId)
  await expect.poll(() => statusKey(page, session.claudeSessionId), { timeout: 15_000 })
    .toBe('1:idle')
  expect(transcript(await historyFor(page, session.claudeSessionId))).toEqual([
    `user:${BASE_PROMPT}`,
    `assistant:${BASE_REPLY}`,
  ])

  const input = panel.locator('.chat-input-textarea')
  await input.fill(CRASH_PROMPT)
  await input.press('Enter')
  await expect(panel.locator('.session-streaming-panel').getByText(CRASH_PARTIAL, { exact: true }))
    .toHaveCount(1, { timeout: 15_000 })

  const killedPid = await workerPid(session.acpRuntimeId, session.acpJournalPath)
  process.kill(killedPid, 'SIGKILL')
  await expectWorkerReaped(session.acpRuntimeId, session.acpJournalPath)

  await expect(panel.getByText(CRASH_BOUNDARY, { exact: true }))
    .toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => statusKey(page, session.claudeSessionId), { timeout: 15_000 })
    .toBe('2:idle')
  await expect(panel.locator('.session-panel-badge', { hasText: 'Idle' })).toHaveCount(1)
  expect(transcript(await historyFor(page, session.claudeSessionId))).toEqual([
    `user:${BASE_PROMPT}`,
    `assistant:${BASE_REPLY}`,
    `user:${CRASH_PROMPT}`,
    `assistant:${CRASH_PARTIAL}`,
    `system:${CRASH_BOUNDARY}`,
  ])
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/recovery-worker-death.png`,
    fullPage: true,
  })

  expect((await journalRecords(session.acpJournalPath))
    .filter((record) => record.event?.type === 'session-loaded')).toHaveLength(0)

  await input.fill(RECOVERY_PROMPT)
  await input.press('Enter')
  await expect(panel.locator('.session-streaming-panel')).toContainText(CRASH_PARTIAL, {
    timeout: 15_000,
  })
  await expect.poll(() => statusKey(page, session.claudeSessionId), { timeout: 15_000 })
    .toBe('3:running')

  const replacementPid = await workerPid(session.acpRuntimeId, session.acpJournalPath)
  expect(replacementPid).not.toBe(killedPid)
  await expect.poll(async () =>
    (await journalRecords(session.acpJournalPath))
      .filter((record) => record.event?.type === 'session-loaded').length,
  { timeout: 15_000 }).toBe(1)

  const recoveryJournal = await journalRecords(session.acpJournalPath)
  expect(recoveryJournal.filter((record) =>
    record.source === 'provider-replay'
      && record.frame?.params?.update?.content?.text === 'replayed: earlier reply',
  )).toHaveLength(1)

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/recovery-mid-stream-before-reload.png`,
    fullPage: true,
  })
  await page.reload()

  const reloadedPanel = page.locator(REAL_PANEL)
  await expect(reloadedPanel).toBeVisible({ timeout: 15_000 })
  await expect(reloadedPanel.locator('.session-panel-badge', { hasText: 'Running' }))
    .toHaveCount(1)
  await expect(reloadedPanel.getByText(BASE_PROMPT, { exact: true })).toHaveCount(1)
  await expect(reloadedPanel.getByText(BASE_REPLY, { exact: true })).toHaveCount(1)
  await expect(reloadedPanel.getByText(CRASH_PROMPT, { exact: true })).toHaveCount(1)
  await expect(reloadedPanel.getByText(CRASH_BOUNDARY, { exact: true })).toHaveCount(1)
  await expect(reloadedPanel.getByText(RECOVERY_PROMPT, { exact: true })).toHaveCount(1)
  await expect(reloadedPanel.locator('.session-streaming-panel')).toContainText(CRASH_PARTIAL)
  await expect(reloadedPanel).not.toContainText('replayed: earlier reply')
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/recovery-mid-stream-after-reload.png`,
    fullPage: true,
  })

  await expect(reloadedPanel.getByText(RECOVERY_REPLY, { exact: true }))
    .toHaveCount(1, { timeout: 20_000 })
  await expect.poll(() => statusKey(page, session.claudeSessionId), { timeout: 15_000 })
    .toBe('3:idle')

  await page.reload()
  const finalPanel = page.locator(REAL_PANEL)
  await expect(finalPanel).toBeVisible({ timeout: 15_000 })
  await expect(finalPanel.locator('.session-panel-badge', { hasText: 'Idle' })).toHaveCount(1)

  const exactTranscript = [
    `user:${BASE_PROMPT}`,
    `assistant:${BASE_REPLY}`,
    `user:${CRASH_PROMPT}`,
    `assistant:${CRASH_PARTIAL}`,
    `system:${CRASH_BOUNDARY}`,
    `user:${RECOVERY_PROMPT}`,
    `assistant:${RECOVERY_REPLY}`,
  ]
  await expect.poll(async () =>
    transcript(await historyFor(page, session.claudeSessionId)),
  { timeout: 15_000 }).toEqual(exactTranscript)

  const renderedMessages = finalPanel.locator('.session-history [data-msg-index]')
  await expect(renderedMessages).toHaveCount(exactTranscript.length)
  const renderedText = await renderedMessages.allInnerTexts()
  for (const [index, entry] of exactTranscript.entries()) {
    expect(renderedText[index]).toContain(entry.slice(entry.indexOf(':') + 1))
  }
  await expect(finalPanel.locator('.session-streaming-panel')).toHaveCount(0)
  await expect(finalPanel.getByText(BASE_PROMPT, { exact: true })).toHaveCount(1)
  await expect(finalPanel.getByText(BASE_REPLY, { exact: true })).toHaveCount(1)
  await expect(finalPanel.getByText(CRASH_PROMPT, { exact: true })).toHaveCount(1)
  await expect(finalPanel.getByText(CRASH_BOUNDARY, { exact: true })).toHaveCount(1)
  await expect(finalPanel.getByText(RECOVERY_PROMPT, { exact: true })).toHaveCount(1)
  await expect(finalPanel.getByText(RECOVERY_REPLY, { exact: true })).toHaveCount(1)
  await expect(finalPanel).not.toContainText('replayed: earlier reply')

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/recovery-final-converged.png`,
    fullPage: true,
  })

  await audit.assertClean({
    requestFailure: (failure) => {
      const url = new URL(failure.url)
      return failure.method === 'PUT'
        && failure.errorText === 'net::ERR_ABORTED'
        && url.pathname === '/api/ui-prefs'
    },
  })
})
