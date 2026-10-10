/**
 * The page a host server serves while it answers alone, in a real browser
 * (Chromium and WebKit, phone sized): fixture tests/e2e/browser/host-alone-server.ts.
 *
 *   - signed out: the reason, nothing named;
 *   - signed in (the token this browser holds for this address): the sessions
 *     here, a conversation, a message and its reply, a prompt answered, a
 *     stopped session that takes no message;
 *   - the Mac back: the page opens the Mac's console by itself, unless a
 *     message is being written, which stays, with a button to open it.
 */
import { test, expect, type Page } from '@playwright/test'
import { TOKEN, LIVE } from '../../helpers/host-alone-harness.js'

const port = Number(process.env.PW_TEST_PORT ?? 3468)
const control = `http://127.0.0.1:${port + 1}/control`
const SHOTS = '/tmp/host-alone'

async function ctl(method: 'GET' | 'POST', p: string): Promise<any> {
  const r = await fetch(`${control}/${p}`, { method })
  if (!r.ok) throw new Error(`control ${p}: ${r.status} ${await r.text()}`)
  return r.json()
}

async function signIn(page: Page): Promise<void> {
  await page.addInitScript((token) => { localStorage.setItem('walnut.deviceToken', token) }, TOKEN)
}

test.beforeEach(async () => {
  await ctl('POST', 'unlink')
})

test.afterAll(async () => {
  await ctl('POST', 'unlink').catch(() => undefined)
})

test('signed out: the reason, and nothing named', async ({ page }, info) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Walnut on devbox' })).toBeVisible()
  await expect(page.getByText('Your Mac is not answering')).toBeVisible()
  await expect(page.getByText('This browser is not signed in to Walnut here')).toBeVisible()
  await expect(page.getByText('Fix the build')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-signed-out.png` })
})

test('signed in: read, write, answer a prompt', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // A Playwright screenshot in WebKit injects a stylesheet of its own, which this
  // page's CSP refuses; the page's own style is checked below instead.
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Refused to apply a stylesheet')) errors.push(m.text()) })
  await signIn(page)
  await page.goto('/')

  const live = page.locator(`button.session[data-sid="${LIVE}"]`)
  await expect(live).toContainText('Fix the build')
  await expect(live).toContainText('Release: fix the build')
  const stopped = page.locator('button.session', { hasText: 'Old report' })
  await expect(stopped).toContainText('Stopped')
  await expect(page.getByText('Environment lane')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-list.png` })
  // The page's own style and script run under its nonce.
  expect(await page.locator('#composer').evaluate((n) => getComputedStyle(n).position)).toBe('fixed')

  await live.click()
  await expect(page.locator('#open-title')).toHaveText('Fix the build')
  const text = `hello from ${info.project.name}`
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.msg.assistant', { hasText: `echo: ${text}` })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.msg.user', { hasText: text })).toBeVisible()
  await expect(page.getByLabel('Message')).toHaveValue('')
  expect(await ctl('GET', `inbox/${LIVE}`)).toContain(text)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-conversation.png` })

  const answeredBefore = (await ctl('GET', `responses/${LIVE}`)).length
  await page.getByLabel('Message').fill(`ASK: list the docs (${info.project.name})`)
  await page.getByRole('button', { name: 'Send' }).click()
  const prompt = page.locator('#prompt')
  await expect(prompt).toContainText('Bash needs your permission', { timeout: 15_000 })
  await expect(prompt.locator('pre')).toHaveText('ls docs/')
  await expect(page.locator('#list-view')).toBeHidden() // still the conversation, not the list
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-prompt.png` })
  await prompt.getByRole('button', { name: 'Allow' }).click()
  await expect(prompt).toBeHidden({ timeout: 10_000 })
  await expect.poll(async () => (await ctl('GET', `responses/${LIVE}`)).length).toBe(answeredBefore + 1)
  const last = (await ctl('GET', `responses/${LIVE}`)).at(-1)
  expect(last.response.response).toMatchObject({ behavior: 'allow', updatedInput: { command: 'ls docs/' } })

  // Back to the list, and the stopped session takes no message.
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(stopped).toBeVisible()
  await stopped.click()
  await expect(page.getByText('This session is not running')).toBeVisible()
  await expect(page.getByLabel('Message')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled()
  expect(errors).toEqual([])
})

test('the Mac back: the page opens its console, unless a message is being written', async ({ page }, info) => {
  await signIn(page)
  await page.goto('/')
  const live = page.locator(`button.session[data-sid="${LIVE}"]`)
  await expect(live).toBeVisible()

  // A draft: the page stays, says so, and keeps it.
  await live.click()
  await page.getByLabel('Message').fill('a draft that must not be lost')
  await ctl('POST', 'link')
  await expect(page.getByText('Walnut answers again.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Your Mac is not answering')).toBeHidden()
  await expect(page.getByLabel('Message')).toHaveValue('a draft that must not be lost')
  await expect(page.getByTestId('mac-console')).toHaveCount(0)
  // No poll reports the 409 the alone API now answers.
  await page.waitForTimeout(5_000)
  await expect(page.locator('#send-error')).toHaveText('')
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-back-with-draft.png` })
  await page.getByRole('button', { name: 'Open Walnut' }).click()
  await expect(page.getByTestId('mac-console')).toBeVisible({ timeout: 15_000 })

  // Nothing typed: the page opens the console by itself. (The address kept the
  // open session, so the alone page opens on it again.)
  await ctl('POST', 'unlink')
  await page.reload()
  await expect(page.locator('#open-title')).toHaveText('Fix the build')
  await expect(page.getByLabel('Message')).toHaveValue('')
  await ctl('POST', 'link')
  await expect(page.getByTestId('mac-console')).toBeVisible({ timeout: 15_000 })
})
