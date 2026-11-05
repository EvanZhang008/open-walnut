/**
 * A short clip for the user, macOS WebKit only (the Mac app's engine): invented letters in the
 * inbox, each led by who it is from, a task letter opened, then a routing rule added in Settings.
 * Run on the Mac with `walnut-dev webkit tests/e2e/browser/letter-origin-demo.spec.ts`; skipped
 * elsewhere. The assertions live in letter-origin-and-routing.spec.ts; this one only paces the flow.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { home } from './inbox-items-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}/api/v1`
const NONCE = Date.now().toString(36).slice(-4)

test.skip(process.platform !== 'darwin', 'a clip of macOS WebKit, the Mac app\'s engine')
test.use({ video: { mode: 'on', size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } })
test.setTimeout(120_000)

const seeded: string[] = []
let ruleTask = ''

test.beforeAll(async () => {
  const { walnutHome } = await discoverBrowserFixture(TEST_PORT)
  const mk = async (title: string, project: string) => ((await (await fetch(`${API}/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, project }),
  })).json()) as { task: { id: string } }).task.id
  const offer = await mk(`Acme Robotics offer review ${NONCE}`, 'Career')
  ruleTask = offer
  const dir = path.join(walnutHome, 'human-inbox')
  await fs.mkdir(path.join(dir, 'bodies'), { recursive: true })
  const idx = path.join(dir, 'index.json')
  const store = await fs.readFile(idx, 'utf8').then(r => JSON.parse(r) as { version: 1; letters: unknown[] }).catch(() => ({ version: 1 as const, letters: [] as unknown[] }))
  const add = async (subject: string, type: string, sender: Record<string, unknown>, ago: number, extra: Record<string, unknown> = {}) => {
    const id = `lt-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
    const md = `## ${subject}\n\nThe recruiter wrote again today: the offer stands until Friday.\n\n- **Accept** and sign by Friday\n- **Ask for one more week** to compare`
    await fs.writeFile(path.join(dir, 'bodies', `${id}.md`), md)
    store.letters.push({ id, subject, type, bodyFormat: 'markdown', textPreview: 'The recruiter wrote again today: the offer stands until Friday.', sender, createdAt: Date.now() - ago, read: false, pinned: false, archived: false, bodyBytes: Buffer.byteLength(md), thread: [], ...extra })
    seeded.push(id)
  }
  await add(`Acme Robotics: accept the offer or ask for more time? ${NONCE}`, 'action_required', { sessionId: 'sess-demo-1', taskId: offer, taskTitle: `Acme Robotics offer review ${NONCE}`, project: 'Career', host: 'local' }, 60_000,
    { actions: [{ id: 'accept', label: 'Accept the offer' }, { id: 'time', label: 'Ask for one more week' }] })
  await add(`3 new mails need you ${NONCE}`, 'review', { sessionId: 'sess-demo-2', taskId: 'task-demo-triage', taskTitle: 'Triage · 09:00 · 3 items', project: 'Ask Inbox Triage', agentId: 'triage', host: 'local' }, 9 * 60_000)
  await add(`Sign in to devbox again ${NONCE}`, 'review', { sessionId: 'external', host: 'local' }, 25 * 60_000)
  await fs.writeFile(idx, JSON.stringify(store, null, 2))
})

test.afterAll(async () => {
  for (const id of seeded) await fetch(`${API}/human-inbox/${id}/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"archived":true}' }).catch(() => {})
  const rules = await fetch(`${API}/triage/routing-rules`).then(r => r.json() as Promise<{ rules: Array<{ id: string; taskId: string }> }>).catch(() => ({ rules: [] }))
  for (const r of rules.rules.filter(r => r.taskId === ruleTask)) await fetch(`${API}/triage/routing-rules/${r.id}`, { method: 'DELETE' }).catch(() => {})
})

test('demo: who a letter is from, then a routing rule', async ({ page }) => {
  const pause = (ms = 1200) => page.waitForTimeout(ms)
  await home(page)
  await pause()
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const panel = page.locator('.notification-panel')
  await panel.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
  await expect(panel.locator('.hib-row').filter({ hasText: NONCE }).first()).toBeVisible()
  await pause(2500)
  await panel.locator('.hib-row').filter({ hasText: 'accept the offer' }).locator('.hib-subject').click()
  await expect(page.locator('.hib-reader [data-testid="letter-origin"]')).toBeVisible()
  await pause(2500)
  await page.keyboard.press('Escape')
  await pause(600)
  await page.keyboard.press('Escape')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await page.getByTestId('settings-nav-triage').click()
  const group = page.getByTestId('triage-routing-rules')
  await group.scrollIntoViewIfNeeded()
  await pause()
  await group.getByTestId('triage-rule-add').click()
  const editor = group.getByTestId('triage-rule-editor')
  await editor.getByTestId('triage-rule-from').pressSequentially('acme-robotics.example', { delay: 40 })
  await editor.getByTestId('triage-rule-task-search').pressSequentially('acme offer', { delay: 60 })
  await pause(800)
  await editor.getByTestId('triage-rule-task-option').first().click()
  await editor.getByTestId('triage-rule-note').pressSequentially('Offer mail from the recruiter', { delay: 30 })
  await pause(600)
  await editor.getByTestId('triage-rule-save').click()
  await expect(group.getByTestId('triage-rule').filter({ hasText: 'acme-robotics.example' })).toBeVisible()
  await pause(2500)
})
