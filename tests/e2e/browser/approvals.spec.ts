/**
 * Approvals in the console (web/src/components/approvals/ApprovalPrompts.tsx), as a person
 * uses them: a script asks (`walnut approve`, here its POST), a card shows up live on the
 * page that is already open, the person clicks, and the asker's wait reads that decision.
 *
 *  - tap: Approve and Deny each reach the asker, used once;
 *  - biometric with no signing device: the card asks for a tap and says why;
 *  - biometric with a device: a browser offers no Approve, says to use Face ID, and Deny works;
 *  - Needs you: one line on Home (counted there, no title or buttons of its own) whose click
 *    opens the dialog in the order the requests came, the corner card on every page holding the
 *    buttons and staying until it is answered, and
 *    Main's Needs you on the Org page listing it;
 *  - the corner: a card and a toast share the bottom left, right of the sidebar.
 *
 * The fixture server marks no test objects, while this automated window has a test-run label,
 * so this also pins that a live card shows there (the window re-reads the server's list).
 * Run on the Mac app's engine: PW_WEBKIT=1 bun x playwright test approvals --project webkit
 */
import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from '@playwright/test'
import crypto from 'node:crypto'

test.use({ video: process.env.APR_VIDEO ? 'on' : 'off' })
test.describe.configure({ mode: 'serial' })

function stamp(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

async function ask(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post('/api/v1/approvals', { data: { cwd: '/work/site', command: 'release.sh', ...body } })
  expect(res.status(), await res.text()).toBe(200)
  return await res.json() as { approval: { id: string; mode: string; downgraded?: string }; waitToken: string }
}

/** Off Home, where no Needs you rows are listed: the corner card is the only place of a request. */
async function offHome(page: Page) {
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page).toHaveURL(/\/settings/)
}

// The fixture server is shared: a request another file or an earlier run left waiting would take
// the corner (it shows the first) and the Home summary line, so each test starts with none, and
// ends with none, so a failed test leaves no card beside another file's toasts.
async function denyAllWaiting(request: APIRequestContext) {
  const res = await request.get('/api/v1/approvals')
  if (!res.ok()) return
  const { approvals } = await res.json() as { approvals: { id: string }[] }
  for (const a of approvals) await request.post(`/api/v1/approvals/${a.id}/answer`, { data: { decision: 'deny' } })
}
test.beforeEach(async ({ request }) => { await denyAllWaiting(request) })
test.afterEach(async ({ request }) => { await denyAllWaiting(request) })

async function waitFor(request: APIRequestContext, id: string, token: string) {
  const res = await request.post(`/api/v1/approvals/${id}/wait`, { data: { token, wait_ms: 5_000 } })
  expect(res.status()).toBe(200)
  return await res.json() as { approval: { status: string; answer?: { mode: string; device: { kind: string } } }; used: boolean }
}

test('a tap approval shows up live, and Approve and Deny each reach the asker', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.app-layout, #root').first()).toBeVisible()
  await offHome(page)

  const what = `Deploy web ${stamp()}`
  const made = await ask(request, { what, detail: 'web: 3 files changed\nmigrations: none' })
  const card = page.locator(`[data-testid="approval-card"][data-approval-id="${made.approval.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator('.approval-what')).toHaveText(what)
  await expect(card.locator('.approval-who')).toContainText('release.sh on')
  await expect(card.locator('.approval-clock')).toHaveText(/^\d+:\d\d left$/)
  // The card is three short lines; its title opens the whole request, the detail with it.
  await expect(card.locator('.approval-detail')).toBeHidden()
  await card.locator('.approval-what-open').click()
  const opened = page.getByTestId('approval-dialog')
  await expect(opened.locator('.approval-detail pre')).toContainText('migrations: none')
  await opened.locator('.approval-dialog-close').click()
  await expect(opened).toHaveCount(0)
  await expect(card).toBeVisible()
  // A second request waits behind it: the answer is laid over the next card, already in its place.
  const deny = await ask(request, { what: `Drop staging table ${stamp()}` })
  const denyCard = page.locator(`[data-testid="approval-card"][data-approval-id="${deny.approval.id}"]`)
  await expect(card.getByTestId('approval-count')).toHaveText(/^2 waiting/, { timeout: 15_000 })
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.locator(`.approval-card-settled[data-approval-id="${made.approval.id}"]`)).toContainText('Approved')
  await expect(denyCard).toBeVisible()
  const got = await waitFor(request, made.approval.id, made.waitToken)
  expect(got).toMatchObject({ used: true, approval: { status: 'approved', answer: { mode: 'tap', device: { kind: 'web' } } } })
  await expect(card).toHaveCount(0, { timeout: 5_000 })
  await expect(page.locator(`.approval-card-settled[data-approval-id="${made.approval.id}"]`)).toHaveCount(0, { timeout: 5_000 })
  await denyCard.getByRole('button', { name: 'Deny' }).click()
  expect((await waitFor(request, deny.approval.id, deny.waitToken)).approval.status).toBe('denied')
})

test('biometric: a tap with a reason when no device signs, then Face ID only once one does', async ({ page, request }) => {
  const keys = await (await request.get('/api/v1/approvals/keys')).json() as { keys: Array<{ status: string }> }
  test.skip(keys.keys.some((k) => k.status === 'active'), 'a signing device is already enrolled on this fixture server')

  await page.goto('/')
  await offHome(page)
  const tap = await ask(request, { what: `Publish v1 ${stamp()}`, mode: 'biometric' })
  expect(tap.approval.mode).toBe('tap')
  const tapCard = page.locator(`[data-testid="approval-card"][data-approval-id="${tap.approval.id}"]`)
  await expect(tapCard).toBeVisible({ timeout: 15_000 })
  await expect(tapCard.locator('.approval-note')).toContainText('No device signs approvals yet')
  await tapCard.getByRole('button', { name: 'Approve', exact: true }).click()
  expect((await waitFor(request, tap.approval.id, tap.waitToken)).approval.status).toBe('approved')

  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  // The first signing device is the paired iPhone app, so the key rides a device token.
  const paired = await request.post('/api/devices', { data: { name: `approvals-spec-${stamp()}` } })
  expect(paired.status()).toBe(201)
  const token = (await paired.json() as { token: string }).token
  const enrolled = await request.post('/api/v1/approvals/keys', {
    data: { publicKey: spki, name: 'Spec iPhone', kind: 'iphone' }, headers: { authorization: `Bearer ${token}` },
  })
  expect(enrolled.status()).toBe(200)

  const bio = await ask(request, { what: `Rotate signing key ${stamp()}`, mode: 'biometric' })
  expect(bio.approval.mode).toBe('biometric')
  const bioCard = page.locator(`[data-testid="approval-card"][data-approval-id="${bio.approval.id}"]`)
  await expect(bioCard).toBeVisible({ timeout: 15_000 })
  await expect(bioCard.locator('.approval-kicker')).toContainText('Face ID')
  await expect(bioCard.locator('.approval-note')).toContainText('Approve it on your iPhone with Face ID')
  await expect(bioCard.getByRole('button', { name: /Approve/ })).toHaveCount(0)
  await bioCard.getByRole('button', { name: 'Deny' }).click()
  expect((await waitFor(request, bio.approval.id, bio.waitToken)).approval.status).toBe('denied')
})

test('Needs you: approvals are one line on Home, a click opens the request, and Main on the Org page lists them', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.app-layout, #root').first()).toBeVisible()
  const summary = page.locator('.status-section-block-needs [data-testid="approval-summary"]')
  const dialog = page.getByTestId('approval-dialog')

  // Home: one line in Needs you, counted with the tasks there; its click opens the dialog. The
  // corner's card pops up here too, as on every page: the line is a row of Home's list.
  const first = await ask(request, { what: `Release notes ${stamp()}`, detail: 'notes: 4 lines' })
  await expect(summary).toHaveText(/1 approval waiting/, { timeout: 15_000 })
  await expect(summary).not.toContainText('Release notes')
  expect(Number(await page.getByTestId('status-section-needs-count').innerText())).toBeGreaterThanOrEqual(1)
  expect((await summary.boundingBox())!.height).toBeLessThanOrEqual(40)
  const homeCard = page.locator(`[data-testid="corner-stack"] [data-testid="approval-card"][data-approval-id="${first.approval.id}"]`)
  await expect(homeCard).toBeVisible()
  // The line in sight lists it already: the card keeps its short form, so it never shows twice at full size.
  await expect(homeCard).toHaveClass(/approval-card-line/)
  await summary.click()
  await expect(dialog.locator('.approval-what')).toContainText('Release notes')
  await expect(dialog.locator('.approval-detail pre')).toContainText('notes: 4 lines')
  // The open request is the dialog's alone: the whole corner steps aside while it is open.
  await expect(page.locator('[data-testid="corner-stack"] [data-testid="approval-card"]')).toBeHidden()
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByTestId('approval-dialog-settled')).toContainText('Approved')
  expect((await waitFor(request, first.approval.id, first.waitToken)).approval.status).toBe('approved')
  await expect(summary).toHaveCount(0)
  await expect(dialog).toHaveCount(0, { timeout: 5_000 })

  // The corner card is the same on Home and off it; back on Home a Deny in the dialog takes the line with it.
  const second = await ask(request, { what: `Wipe cache ${stamp()}` })
  await expect(summary).toBeVisible({ timeout: 15_000 })
  const card2 = page.locator(`[data-testid="corner-stack"] [data-testid="approval-card"][data-approval-id="${second.approval.id}"]`)
  await expect(card2).toBeVisible()
  await offHome(page)
  await expect(card2).toBeVisible()
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(summary).toBeVisible()
  await expect(card2).toBeVisible()
  await summary.click()
  await dialog.getByRole('button', { name: 'Deny' }).click()
  await page.keyboard.press('Escape')
  expect((await waitFor(request, second.approval.id, second.waitToken)).approval.status).toBe('denied')
  await expect(summary).toHaveCount(0)
  await expect(dialog).toHaveCount(0)

  // A folded Needs you still shows the line (its tasks stay folded). The section is drawn only
  // while something is in it, so the approval comes first, then the fold.
  const folded = await ask(request, { what: `Folded ${stamp()}` })
  await expect(summary).toBeVisible({ timeout: 15_000 })
  const heading = page.getByTestId('status-section-needs').locator('button.navigation-heading-open')
  if ((await heading.getAttribute('aria-expanded')) === 'true') await heading.click()
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await expect(summary).toBeVisible()
  await expect(page.getByTestId('status-section-needs-rows')).toHaveCount(0)
  await summary.click()
  await dialog.getByRole('button', { name: 'Deny' }).click()
  await page.keyboard.press('Escape')
  expect((await waitFor(request, folded.approval.id, folded.waitToken)).approval.status).toBe('denied')
  // Put the fold back for the person's next view (the section may be gone once it is empty: read
  // it only after the line has left, so it cannot go between the look and the click).
  await expect(summary).toHaveCount(0)
  await expect(dialog).toHaveCount(0)
  if ((await heading.count()) > 0 && (await heading.getAttribute('aria-expanded')) === 'false') await heading.click()

  // Several: still one line, which opens the first (the corner's card), in the order they came.
  const many = [await ask(request, { what: `Batch A ${stamp()}` }), await ask(request, { what: `Batch B ${stamp()}` })]
  await expect(summary).toHaveText(/2 approvals waiting/, { timeout: 15_000 })
  await summary.click()
  await expect(dialog.getByTestId('approval-dialog-list').locator('[aria-current="true"]')).toContainText('Batch A')
  await expect(dialog.locator('.approval-what')).toContainText('Batch A')
  for (const m of many) await request.post(`/api/v1/approvals/${m.approval.id}/answer`, { data: { decision: 'deny' } })
  await page.keyboard.press('Escape')
  await expect(summary).toHaveCount(0)

  // Org: Main answers for the person, so its Needs you lists the approval, and its line counts it.
  const third = await ask(request, { what: `Rotate keys ${stamp()}` })
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-channel-main').click()
  await expect(page.getByTestId('org-channel-main').getByTestId('org-channel-badge')).toBeVisible()
  // The node's side bar as the person last left it: open it, on Tasks, by status.
  const toggle = page.getByTestId('org-rail-toggle')
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await page.getByTestId('org-top-task').click()
  await page.getByTestId('org-task-mode-status').click()
  await page.locator('[data-testid="org-task-tab"][data-tab="needs"]').click()
  const orgLine = page.locator('[data-testid="org-rail"] [data-testid="approval-summary"]')
  await expect(orgLine).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-testid="org-task-tab"][data-tab="needs"] .org-task-tab-count')).not.toHaveText('0')
  await orgLine.click()
  await expect(dialog.locator('.approval-what')).toContainText('Rotate keys')
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  expect((await waitFor(request, third.approval.id, third.waitToken)).approval.status).toBe('approved')
  await expect(orgLine).toHaveCount(0)
})

async function routeSocket(page: Page): Promise<() => WebSocketRoute | null> {
  let socket: WebSocketRoute | null = null
  await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => { socket = route; route.connectToServer() })
  return () => socket
}

/** A refused agent turn toasts (phone-shell.spec.ts uses the same event). */
function agentErrorEvent(agentId: string, error: string): string {
  return JSON.stringify({ type: 'event', name: 'agent:error', data: { agentId, error }, seq: -1 })
}

type Box = { x: number; y: number; width: number; height: number }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('the corner: a toast and an approval card share the bottom left, right of the sidebar', async ({ page, request }) => {
  // 2026-11-04, the user: "all notificaiton is bottom left" (common/corner-stack.tsx;
  // the source half is tests/web/corner-stack-guard.test.ts).
  await page.setViewportSize({ width: 1280, height: 800 })
  const sock = await routeSocket(page)
  await page.goto('/')
  await expect(page.locator('.app-shell > .sidebar')).toBeVisible()
  await expect.poll(() => sock() !== null).toBe(true)
  await offHome(page)

  const what = `Deploy web ${Date.now().toString(36)}`
  const res = await request.post('/api/v1/approvals', { data: { cwd: '/work/site', command: 'release.sh', what } })
  expect(res.status(), await res.text()).toBe(200)
  const { approval } = await res.json() as { approval: { id: string } }
  const card = page.locator(`[data-testid="approval-card"][data-approval-id="${approval.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })

  sock()!.send(agentErrorEvent('agent-corner', '401 unauthorized (corner test notice)'))
  const toast = page.locator('.notification-toast', { hasText: 'corner test notice' })
  await expect(toast).toBeVisible({ timeout: 10_000 })
  // Measured once both entrances have settled.
  await expect.poll(() => toast.evaluate((el) => el.getAnimations().length)).toBe(0)

  // Both are in the one stack (other approvals of this file may be there too).
  const stack = page.getByTestId('corner-stack')
  await expect(stack.locator(`[data-testid="approval-card"][data-approval-id="${approval.id}"]`)).toHaveCount(1)
  await expect(stack.locator('.notification-toast', { hasText: 'corner test notice' })).toHaveCount(1)

  const vp = page.viewportSize()!
  const sidebar = (await page.locator('.app-shell > .sidebar').boundingBox())!
  // Settings has its own left column (its nav) beside the sidebar: the stack sits right of it.
  const nav = (await page.locator('.settings-nav').boundingBox())!
  const c = (await card.boundingBox())!
  const t = (await toast.boundingBox())!
  await page.screenshot({ path: test.info().outputPath('corner.png') })

  for (const [name, b] of [['card', c], ['toast', t]] as const) {
    expect(b.x, `${name} starts right of the page's left column`).toBe(Math.round(nav.x + nav.width) + 16)
    expect(b.x, `${name} is on the left`).toBeLessThan(vp.width / 2)
    expect(overlaps(b, sidebar), `${name} covers no part of the sidebar`).toBe(false)
    expect(overlaps(b, nav), `${name} covers no part of the page's left column`).toBe(false)
  }
  expect(vp.height - (c.y + c.height), 'the card sits at the bottom').toBeLessThanOrEqual(20)
  expect(c.y, 'the approval is nearest the corner, the toast above it').toBeGreaterThanOrEqual(t.y + t.height - 1)
  expect(overlaps(c, t)).toBe(false)
  expect(Math.abs(c.x - t.x), 'one column').toBeLessThanOrEqual(1)

  // Collapsing the sidebar moves the stack with it.
  await page.locator('.sidebar-collapse-btn').first().click()
  await expect.poll(async () => Math.round((await page.locator('.app-shell > .sidebar').boundingBox())!.width)).not.toBe(Math.round(sidebar.width))
  await expect.poll(async () => {
    const n = (await page.locator('.settings-nav').boundingBox())!
    const b = (await card.boundingBox())!
    return Math.round(b.x - (n.x + n.width))
  }).toBe(16)
  await page.locator('.sidebar-collapse-btn').first().click()
  // A narrow window with the sidebar open: still right of the page's left column, narrower.
  await page.setViewportSize({ width: 800, height: 600 })
  await expect.poll(async () => {
    const n = (await page.locator('.settings-nav').boundingBox())!
    const b = (await card.boundingBox())!
    return Math.round(b.x - (n.x + n.width)) === 16 && b.x + b.width <= 800 && b.width >= 240
  }).toBe(true)
  await page.setViewportSize(vp)

  // The notification center open: it lists the approval (and the toast) itself, so the corner's
  // card and toast step aside; the stack moves just right of it for anything else.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('notification:open-center')))
  const center = page.locator('.notification-panel')
  await expect(center).toBeVisible()
  await expect(center.getByTestId('approval-summary')).toBeVisible()
  await expect(card).toBeHidden()
  await expect(stack.locator('.notification-toast', { hasText: 'corner test notice' })).toBeHidden()
  await expect.poll(async () => {
    const p = (await center.boundingBox())!
    const left = await stack.evaluate((el) => parseFloat(getComputedStyle(el).left))
    return left >= p.x + p.width + 8
  }).toBe(true)
  // Its line opens the request over it; Escape closes that top layer alone, then the center.
  await center.getByTestId('approval-summary').click()
  await expect(page.getByTestId('approval-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('approval-dialog')).toHaveCount(0)
  await expect(center).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(center).toBeHidden()
  await expect(card).toBeVisible()

  // A second request: the corner keeps the card it shows (it stays until it is answered), which
  // now says how many wait ("2 waiting", the count Needs you gives) and opens the list of them.
  const res2 = await request.post('/api/v1/approvals', { data: { cwd: '/work/site', command: 'release.sh', what: `Rotate keys ${Date.now().toString(36)}` } })
  const second = (await res2.json() as { approval: { id: string; what: string } }).approval
  const card2 = page.locator(`[data-testid="approval-card"][data-approval-id="${second.id}"]`)
  const count = card.getByTestId('approval-count')
  await expect(count).toHaveText(/^2 waiting/, { timeout: 15_000 })
  await expect(card2).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('corner-two.png') })
  await count.click()
  const dialog = page.getByTestId('approval-dialog')
  await expect(dialog.locator('.approval-what')).toHaveText(what)
  // Every request waiting is listed by its title, the one shown marked; a click shows another.
  const list = dialog.getByTestId('approval-dialog-list')
  await expect(list).toContainText('2 waiting')
  await expect(list.locator('li')).toHaveCount(2)
  await expect(list.locator('[aria-current="true"]')).toContainText(what)
  await list.getByRole('button', { name: new RegExp(second.what) }).click()
  await expect(dialog.locator('.approval-what')).toHaveText(second.what)
  await expect(list.locator('[aria-current="true"]')).toContainText(second.what)
  await list.getByRole('button', { name: new RegExp(what) }).click()
  await expect(dialog.locator('.approval-what')).toHaveText(what)
  await dialog.getByRole('button', { name: 'Deny' }).click()
  await expect(page.getByTestId('approval-dialog-settled')).toContainText('Denied')
  // The next request is one click away from the answer.
  await expect(dialog.getByTestId('approval-dialog-next')).toBeVisible()
  await dialog.locator('.approval-dialog-close').click()
  // The next one takes the corner, alone now.
  await expect(card2).toBeVisible()
  await expect(card2.getByTestId('approval-count')).toHaveCount(0)
  await card2.getByRole('button', { name: 'Deny' }).click()
  await expect(card2).toHaveCount(0, { timeout: 10_000 })
  // The answer shows in the card's place a moment before anything else takes it.
  await expect(stack.locator(`[data-testid="approval-settled"][data-approval-id="${second.id}"]`)).toContainText('Denied')

  // The phone has no free corner: the request is one line at the bottom, a tap opens it.
  const res3 = await request.post('/api/v1/approvals', { data: { cwd: '/work/site', command: 'release.sh', what: `Phone line ${Date.now().toString(36)}` } })
  const { approval: third, waitToken: thirdToken } = await res3.json() as { approval: { id: string }; waitToken: string }
  const card3 = page.locator(`[data-testid="corner-stack"] [data-testid="approval-card"][data-approval-id="${third.id}"]`)
  // On a computer the card can be put down to the same one line, which a newer request undoes.
  await expect(card3).toBeVisible({ timeout: 15_000 })
  await card3.getByTestId('approval-minimize').click()
  await expect(card3).toHaveClass(/approval-card-line/)
  await expect.poll(async () => Math.round((await card3.boundingBox())!.height)).toBeLessThanOrEqual(64)
  // Its "+" shows the whole card again; "–" puts it down once more.
  await card3.getByTestId('approval-expand').click()
  await expect(card3).not.toHaveClass(/approval-card-line/)
  await card3.getByTestId('approval-minimize').click()
  await expect(card3).toHaveClass(/approval-card-line/)
  // Another request comes: the card opens full again, so the new one is not missed.
  const res4 = await request.post('/api/v1/approvals', { data: { cwd: '/work/site', command: 'release.sh', what: `Fourth ${Date.now().toString(36)}` } })
  const fourth = (await res4.json() as { approval: { id: string } }).approval
  await expect(card3).not.toHaveClass(/approval-card-line/, { timeout: 15_000 })
  await expect(card3.getByTestId('approval-count')).toHaveText(/^2 waiting/)
  await request.post(`/api/v1/approvals/${fourth.id}/answer`, { data: { decision: 'deny' } })
  await expect(card3.getByTestId('approval-count')).toHaveCount(0, { timeout: 15_000 })
  await card3.getByTestId('approval-minimize').click()
  await expect(card3).toHaveClass(/approval-card-line/)
  // The one line keeps its buttons on a computer.
  await expect(card3.getByRole('button', { name: 'Deny' })).toBeVisible()
  // A short window with two kinds in the corner: every notice takes its shortest form (a toast its
  // title, one line of why and its buttons), so the corner never stands over a third of the page.
  await page.setViewportSize({ width: 1280, height: 640 })
  sock()!.send(agentErrorEvent('agent-short', '401 unauthorized (short window notice)'))
  const shortToast = stack.locator('.notification-toast').first()
  await expect(shortToast).toBeVisible()
  await expect(stack).toHaveClass(/is-compact/)
  await expect(shortToast.locator('.notification-toast-body')).toBeVisible()
  expect((await shortToast.locator('.notification-toast-body').boundingBox())!.height).toBeLessThanOrEqual(22)
  // In its short form the card can be put aside to one small pill, which opens the request; a newer
  // request brings the card back.
  await card3.getByTestId('approval-put-aside').click()
  const pill = stack.getByTestId('approval-aside')
  await expect(pill).toContainText('1 approval waiting')
  await expect(card3).toHaveCount(0)
  expect((await pill.boundingBox())!.height).toBeLessThanOrEqual(40)
  const res5 = await request.post('/api/v1/approvals', { data: { cwd: '/work/site', command: 'release.sh', what: `Fifth ${Date.now().toString(36)}` } })
  const fifth = (await res5.json() as { approval: { id: string } }).approval
  await expect(card3).toBeVisible({ timeout: 15_000 })
  await expect(pill).toHaveCount(0)
  await request.post(`/api/v1/approvals/${fifth.id}/answer`, { data: { decision: 'deny' } })
  await expect(card3.getByTestId('approval-count')).toHaveCount(0, { timeout: 15_000 })
  await page.setViewportSize({ width: 390, height: 844 })
  // On the phone: two short lines that open the request (its buttons are in the dialog).
  await expect.poll(async () => Math.round((await card3.boundingBox())!.height)).toBeLessThanOrEqual(64)
  await expect(card3.getByRole('button', { name: 'Deny' })).toHaveCount(0)
  await expect(card3.getByText('Approve?')).toBeVisible()
  // It sits at the bottom of the screen, as on a computer: the bar's search and buttons stay clear.
  await expect.poll(async () => {
    const line = (await card3.boundingBox())!
    return line.y > 844 / 2 && line.y + line.height <= 844
  }).toBe(true)
  // A toast on the phone is one row above it for its few seconds (a tap opens the center), and the
  // page under the bar does not move.
  const areaTop = (await page.locator('.main-content > .app-content-area').boundingBox())!.y
  sock()!.send(agentErrorEvent('agent-phone', '401 unauthorized (phone notice)'))
  const phoneToast = stack.locator('.notification-toast').first()
  await expect(phoneToast).toBeVisible()
  await expect.poll(async () => Math.round((await phoneToast.boundingBox())!.height)).toBeLessThanOrEqual(48)
  expect((await phoneToast.boundingBox())!.y).toBeGreaterThan(844 / 2)
  expect((await page.locator('.main-content > .app-content-area').boundingBox())!.y).toBe(areaTop)
  await card3.locator('.approval-line-open').click()
  await dialog.getByRole('button', { name: 'Deny' }).click()
  expect((await waitFor(request, third.id, thirdToken)).approval.status).toBe('denied')
})
