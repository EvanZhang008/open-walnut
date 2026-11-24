/**
 * Approvals in the console (web/src/components/approvals/ApprovalPrompts.tsx), as a person
 * uses them: a script asks (`walnut approve`, here its POST), a card shows up live on the
 * page that is already open, the person clicks, and the asker's wait reads that decision.
 *
 *  - tap: Approve and Deny each reach the asker, used once;
 *  - an older script's Face ID ask (2026-11-21: every approval is a tap on any device the person is
 *    signed in on): one enabled Approve beside Deny, no Face ID words, and a tap reaches the asker;
 *  - Needs you: one line on Home (counted there, no title or buttons of its own) whose click
 *    opens the dialog in the order the requests came, the corner card on every page holding the
 *    buttons and staying until it is answered, and
 *    Main's Needs you on the Org page listing it;
 *  - the stack: a card and a toast share the bottom left corner, beside the rail, one width.
 *
 * The fixture server marks no test objects, while this automated window has a test-run label,
 * so this also pins that a live card shows there (the window re-reads the server's list).
 * Run on the Mac app's engine: PW_WEBKIT=1 bun x playwright test approvals --project webkit
 */
import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from '@playwright/test'
import { holdApprovalsLock } from './approvals-lock'
import { isolateUiPrefsContext } from './status-section-helpers'
import { openSection, openTasksBy, sectionCount, taskSection } from './org-view-helpers'
import { BOTTOM_LEFT, stackPlace, taskbarLift } from './corner-stack-place'

test.use({ video: process.env.APR_VIDEO || process.env.PW_VIDEO ? 'on' : 'off' })
test.describe.configure({ mode: 'serial' })
// It opens the sidebar, a synced layout pref: kept off the shared fixture, so no later spec
// starts with it open (2026-11-06: notice-full-text measured its toast beside an open sidebar).
test.beforeEach(async ({ context }) => { await isolateUiPrefsContext(context) })

function stamp(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** One of Walnut's own asks (the fixture's built-in gate, routes/test-host-fixture.ts): it reads the Approvals switch. */
async function builtin(request: APIRequestContext, what: string) {
  const res = await request.post('/api/test/host-fixture', { data: { action: 'builtin-approval', what } })
  expect(res.status(), await res.text()).toBe(200)
  return await res.json() as { approval: { id: string; status: string; unasked?: string }; waitToken?: string }
}

/** An explicit `walnut approve` (its POST): it always asks, whatever the switch says. */
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
// ends with none, so a failed test leaves no card beside another file's toasts. The clearing runs
// under the approvals lock, so it never denies a request another file is waiting on.
holdApprovalsLock('file', { clear: true })

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
  // The card is three short lines; its title opens the whole request.
  await expect(card.locator('.approval-detail')).toBeHidden()
  await card.locator('.approval-what-open').click()
  const opened = page.getByTestId('approval-dialog')
  // The dialog leads with who asked and where, then the request's sentence; the command and the
  // detail wait in one Details fold, closed (2026-11-12, the user: "I just need to know which task and
  // which path right.. this si confuing"). No title of its own.
  await expect(opened.getByTestId('approval-task')).toContainText('Task')
  await expect(opened.getByTestId('approval-where')).toHaveText(/^Folder\s*\/work\/site \(this computer\)$/)
  await expect(opened.getByTestId('approval-asks')).toContainText(what)
  await expect(opened.locator('.approval-kicker')).toHaveCount(0)
  await expect(opened.getByTestId('approval-command')).toBeHidden()
  await expect(opened.locator('.approval-detail pre')).toBeHidden()
  await opened.locator('.approval-detail summary').click()
  await expect(opened.getByTestId('approval-command')).toHaveText('release.sh')
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

// The card's "stop asking" turns approvals off at once, with no approval of its own.
test('stop asking from the card, see it in Settings, and turn it back on there', async ({ page, request }) => {
  const setAskMe = (v: boolean) => request.put('/api/config', { data: { approvals: { ask_me: v } } })
  expect((await setAskMe(true)).ok()).toBe(true)
  try {
    await page.goto('/')
    await expect(page.locator('.app-layout, #root').first()).toBeVisible()
    await offHome(page)

    const askMeNow = async () => ((await (await request.get('/api/v1/approvals')).json()) as { askMe: boolean }).askMe
    const note = page.getByTestId('approval-stopped-asking')

    // Stop asking, then Undo: approvals are on again, the one approved stays approved.
    const first = await builtin(request, `Post the release notes ${stamp()}`)
    const firstCard = page.locator(`[data-testid="approval-card"][data-approval-id="${first.approval.id}"]`)
    await expect(firstCard).toBeVisible({ timeout: 15_000 })
    await firstCard.getByTestId('approval-stop-asking').click()
    await expect.poll(async () => (await (await request.get(`/api/v1/approvals/${first.approval.id}`)).json()).approval.status).toBe('approved')
    await expect(note).toContainText('From now on agents go ahead without asking you')
    await expect.poll(askMeNow).toBe(false)
    await note.getByTestId('approval-stopped-undo').click()
    await expect(note).toContainText('Agents ask you first again')
    await expect.poll(askMeNow).toBe(true)

    // Stop asking again, and keep it. Another request that was already waiting still waits, and the
    // note says so (the corner shows the first one that came).
    const made = await builtin(request, `Post the weekly update ${stamp()}`)
    const earlier = await builtin(request, `Publish the preview site ${stamp()}`)
    const card = page.locator(`[data-testid="approval-card"][data-approval-id="${made.approval.id}"]`)
    await expect(card).toBeVisible({ timeout: 15_000 })
    await card.getByTestId('approval-stop-asking').click()
    await expect.poll(async () => (await (await request.get(`/api/v1/approvals/${made.approval.id}`)).json()).approval.status).toBe('approved')
    await expect(note).toContainText('From now on agents go ahead without asking you')
    await expect(note.getByTestId('approval-stopped-still')).toContainText('1 other request still waits for you')
    expect((await request.post(`/api/v1/approvals/${earlier.approval.id}/answer`, { data: { decision: 'deny' } })).ok()).toBe(true)

    // Off: Walnut's own next ask goes ahead at once, with no card.
    const quietWhat = `Post the changelog ${stamp()}`
    const quiet = await builtin(request, quietWhat)
    expect(quiet.approval).toMatchObject({ status: 'approved', unasked: 'browserOutward' })
    // An upload's long source path, to read whole in the record below.
    const pathDir = `~/.local/state/garden/tasks/${stamp()}/promo/clips/summer-bakery-tour/`
    expect((await builtin(request, `Upload ${pathDir}demo.mp4 from this computer into example.org`)).approval).toMatchObject({ status: 'approved' })
    await page.waitForTimeout(1500)
    await expect(page.locator(`[data-testid="approval-card"][data-approval-id="${quiet.approval.id}"]`)).toHaveCount(0)

    // An explicit walnut approve still asks, and its card offers no "stop asking me".
    const explicit = await ask(request, { what: `Push the release tag ${stamp()}` })
    expect(explicit.approval).toMatchObject({ status: 'pending' })
    const explicitCard = page.locator(`[data-testid="approval-card"][data-approval-id="${explicit.approval.id}"]`)
    await expect(explicitCard).toBeVisible({ timeout: 15_000 })
    await expect(explicitCard.getByTestId('approval-stop-asking')).toHaveCount(0)
    if (process.env.APR_SHOTS) await explicitCard.screenshot({ path: `${process.env.APR_SHOTS}/explicit-asks-while-off.png` })
    await explicitCard.getByRole('button', { name: 'Approve', exact: true }).click()
    expect((await waitFor(request, explicit.approval.id, explicit.waitToken)).approval.status).toBe('approved')

    // The note's link opens Settings, General: the row reads off, with what went ahead under it.
    await note.getByTestId('approval-stopped-settings').click()
    const toggle = page.locator('#settings-approvals-ask-me')
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 })
    await expect(page.getByTestId('settings-approvals-unasked')).toContainText(quietWhat, { timeout: 20_000 })
    // A row opens to what it was: the command and who asked.
    const row = page.getByTestId('settings-approvals-unasked-item').filter({ hasText: quietWhat })
    // One scannable row: what happened first, its time in its own column at the right edge, the task
    // under it (2026-11-22 audit: long paths and faint times in one block).
    const cells = await row.locator('summary').evaluate((el) => {
      const box = (q: string) => el.querySelector(q)!.getBoundingClientRect()
      const meta = el.querySelector('.approvals-unasked-meta')
      return { row: el.getBoundingClientRect(), what: box('.approvals-unasked-what'), when: box('.approvals-unasked-when'),
        metaWrap: meta ? getComputedStyle(meta).whiteSpace : 'normal' }
    })
    expect(Math.abs(cells.when.right - cells.row.right)).toBeLessThanOrEqual(1)
    expect(cells.when.left).toBeGreaterThanOrEqual(cells.what.right)
    expect(Math.abs(cells.when.top - cells.what.top)).toBeLessThanOrEqual(3)
    expect(cells.metaWrap).toBe('normal')
    // The upload's row names the file; its folders sit under it whole, quiet, wrapping after a "/"
    // and never cut (the audit's third look: cut to one line, they were only a hover away).
    const upload = page.getByTestId('settings-approvals-unasked-item').filter({ hasText: 'Upload demo.mp4 from this computer' })
    const uploadMeta = upload.getByTestId('settings-approvals-unasked-meta')
    await expect(uploadMeta).toContainText(pathDir)
    expect(await uploadMeta.evaluate((el) => ({
      cut: getComputedStyle(el).textOverflow === 'ellipsis' || el.scrollWidth > el.clientWidth + 1,
      breaks: el.querySelectorAll('wbr').length,
    }))).toMatchObject({ cut: false })
    expect(await uploadMeta.evaluate((el) => el.querySelectorAll('wbr').length)).toBeGreaterThan(5)
    await row.locator('summary').click()
    await expect(row).toContainText('this computer')
    // The row says a walnut approve in the person's own script always asks.
    // One short help line that says what Off lets through; the rest, the script's own approve
    // included, is the row's hover.
    await expect(page.getByTestId('settings-approvals-ask-me-row')).toContainText('Off: posts, mail, uploads, browser steps, saved passwords and first remote commands go ahead; payments may still ask.')
    await expect(page.getByTestId('settings-approvals-ask-me-row')).toHaveAttribute('title', /A walnut approve in your own script always asks you/)
    if (process.env.APR_SHOTS) await page.getByTestId('settings-approvals-ask-me-row').screenshot({ path: `${process.env.APR_SHOTS}/settings-switch-off.png` })

    // On again from Settings: the next ask waits for the person.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    // The record stays once something went ahead, said to be from while approvals were off.
    await expect(page.getByTestId('settings-approvals-unasked')).toContainText('While approvals were off')
    await expect.poll(askMeNow).toBe(true)
    const asked = await builtin(request, `Post the roadmap ${stamp()}`)
    await expect(page.locator(`[data-testid="approval-card"][data-approval-id="${asked.approval.id}"]`)).toBeVisible({ timeout: 15_000 })
    await request.post(`/api/v1/approvals/${asked.approval.id}/answer`, { data: { decision: 'deny' } })
  } finally {
    await setAskMe(true)
  }
})

test('an older script\'s Face ID ask is a tap here: Approve beside Deny, enabled, and it reaches the asker', async ({ page, request }) => {
  await page.goto('/')
  await offHome(page)
  // What an older script sends: Face ID, pinned to two devices. Walnut takes both and asks for a tap.
  const old = await ask(request, { what: `Publish v1 ${stamp()}`, mode: 'biometric', signing_key_ids: ['ak-dcb776df2641b2ff', 'ak-e71d5e306b094f97'] })
  expect(old.approval.mode).toBe('tap')
  const card = page.locator(`[data-testid="approval-card"][data-approval-id="${old.approval.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).not.toContainText(/Face ID|Touch ID|No device signs|another device/)
  await expect(card.getByTestId('approval-approve-elsewhere')).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Deny', exact: true })).toBeEnabled()
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
  if (process.env.APR_SHOTS) await card.screenshot({ path: `${process.env.APR_SHOTS}/older-face-id-ask-is-a-tap.png` })
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  const got = await waitFor(request, old.approval.id, old.waitToken)
  expect(got).toMatchObject({ used: true, approval: { status: 'approved', answer: { mode: 'tap', device: { kind: 'web' } } } })
})

test('Needs you: approvals are one line on Home, a click opens the request, and Main on the Org page lists them', async ({ page, request }) => {
  // Home, a batch and the Org page in one walk: over a minute on a loaded runner.
  test.setTimeout(180_000)
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
  await expect(dialog.getByTestId('approval-asks')).toContainText('Release notes')
  await dialog.locator('.approval-detail summary').click()
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
  await expect(dialog.getByTestId('approval-asks')).toContainText('Batch A')
  for (const m of many) await request.post(`/api/v1/approvals/${m.approval.id}/answer`, { data: { decision: 'deny' } })
  await page.keyboard.press('Escape')
  await expect(summary).toHaveCount(0)

  // Org: Main answers for the person, so its Needs you lists the approval, and its line counts it.
  const third = await ask(request, { what: `Rotate keys ${stamp()}` })
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-channel-main').click()
  // The page may open on another node (the one left last): its side bar is not the CEO's, so
  // the walk goes on once the CEO is the node shown (else its Tasks click lands on that node's).
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', 'main')
  // The CEO's row says its threads in its hover (it draws only its name and, above 0, a red dot).
  await expect(page.getByTestId('org-channel-main')).toHaveAttribute('title', /(^|\n|: )\d+ threads?\b/)
  // The node's side bar as the person last left it: open it, on Tasks, All tasks, its Needs you open.
  await openTasksBy(page, 'all')
  await openSection(page, 'needs')
  const orgLine = taskSection(page.getByTestId('org-rail'), 'needs').getByTestId('approval-summary')
  await expect(orgLine).toBeVisible({ timeout: 15_000 })
  await expect(sectionCount(page, 'needs')).not.toHaveText('0')
  await orgLine.click()
  await expect(dialog.getByTestId('approval-asks')).toContainText('Rotate keys')
  const approve = dialog.getByRole('button', { name: 'Approve', exact: true })
  await expect(approve, 'the dialog stays open over the Org page').toBeVisible({ timeout: 10_000 })
  await approve.click({ timeout: 20_000 })
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

test('the stack: a toast and an approval card share the bottom left corner, one width', async ({ page, request }) => {
  // 2026-11-16, the user: "in notificaiton side pannel and as notificaiton on bot let", then "I said
  // this notification is bottom left, bottom left, and you put it on top again" (translated)
  // (common/corner-stack.tsx; the source half is tests/web/corner-stack-guard.test.ts).
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
  const c = (await card.boundingBox())!
  const t = (await toast.boundingBox())!
  await page.screenshot({ path: test.info().outputPath('corner.png') })

  await expect.poll(() => stackPlace(page)).toBe(BOTTOM_LEFT)
  for (const [name, b] of [['card', c], ['toast', t]] as const) {
    expect(Math.round(b.width), `${name} has the stack's one width`).toBe(440)
    expect(Math.round(b.x - (sidebar.x + sidebar.width)), `${name} sits 16px right of the sidebar rail`).toBe(16)
    expect(overlaps(b, sidebar), `${name} covers no part of the sidebar`).toBe(false)
  }
  expect(Math.round(vp.height - (c.y + c.height)), 'the card sits 16px above the bottom edge (or the session taskbar)').toBe(16 + await taskbarLift(page))
  expect(t.y + t.height, 'the approval is nearest the bottom corner, the toast above it').toBeLessThanOrEqual(c.y + 1)
  expect(overlaps(c, t)).toBe(false)
  expect(Math.abs(c.x - t.x), 'one column').toBeLessThanOrEqual(1)

  // Collapsing the sidebar moves the stack with the rail's edge, its width unchanged.
  await page.locator('.sidebar-collapse-btn').first().click()
  await expect.poll(async () => Math.round((await page.locator('.app-shell > .sidebar').boundingBox())!.width)).not.toBe(Math.round(sidebar.width))
  await expect.poll(() => stackPlace(page)).toBe(BOTTOM_LEFT)
  await page.locator('.sidebar-collapse-btn').first().click()
  // A narrow window with the sidebar open: still at the bottom left, inside the window.
  await page.setViewportSize({ width: 800, height: 600 })
  await expect.poll(() => stackPlace(page)).toBe(BOTTOM_LEFT)
  const narrow = (await card.boundingBox())!
  expect(narrow.x + narrow.width, 'the card stays inside a narrow window').toBeLessThanOrEqual(800)
  await page.setViewportSize(vp)

  // The notification center open: it lists the approval (and the toast) itself, so the stack's
  // card and toast step aside; the stack sits 16px right of the center for anything else.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('notification:open-center')))
  const center = page.locator('.notification-panel')
  await expect(center).toBeVisible()
  await expect(center.getByTestId('approval-summary')).toBeVisible()
  await expect(card).toBeHidden()
  await expect(stack.locator('.notification-toast', { hasText: 'corner test notice' })).toBeHidden()
  await expect.poll(() => stackPlace(page)).toBe(BOTTOM_LEFT)
  const p = (await center.boundingBox())!
  expect(await stack.evaluate((el) => Math.round(el.getBoundingClientRect().left)), 'right of the open center').toBe(Math.round(p.x + p.width) + 16)
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
  await expect(dialog.getByTestId('approval-asks')).toHaveText(what)
  // Every request waiting is listed by its title, the one shown marked; a click shows another.
  const list = dialog.getByTestId('approval-dialog-list')
  await expect(list).toContainText('2 waiting')
  await expect(list.locator('li')).toHaveCount(2)
  await expect(list.locator('[aria-current="true"]')).toContainText(what)
  await list.getByRole('button', { name: new RegExp(second.what) }).click()
  await expect(dialog.getByTestId('approval-asks')).toHaveText(second.what)
  await expect(list.locator('[aria-current="true"]')).toContainText(second.what)
  await list.getByRole('button', { name: new RegExp(what) }).click()
  await expect(dialog.getByTestId('approval-asks')).toHaveText(what)
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

  // The phone keeps the request to one line at the top, a tap opens it.
  const res3 = await request.post('/api/v1/approvals', { data: { cwd: '/work/site', command: 'release.sh', what: `Phone line ${Date.now().toString(36)}` } })
  const { approval: third, waitToken: thirdToken } = await res3.json() as { approval: { id: string }; waitToken: string }
  const card3 = page.locator(`[data-testid="corner-stack"] [data-testid="approval-card"][data-approval-id="${third.id}"]`)
  // On a computer the card can be put down to the same one line, which a newer request undoes.
  await expect(card3).toBeVisible({ timeout: 15_000 })
  await card3.getByTestId('approval-minimize').click()
  await expect(card3).toHaveClass(/approval-card-line/)
  // Two lines where they fit; in this narrow column (Settings' nav) the buttons take a third line
  // rather than sit over the time (2026-11-06: "9:56 le" cut under Deny in the Org list), and the
  // sentence takes two lines where it needs them (2026-11-12 review: "Post th…" beside Approve).
  await expect.poll(async () => Math.round((await card3.boundingBox())!.height)).toBeLessThanOrEqual(110)
  expect(await card3.evaluate((el) => {
    const c = el.querySelector('.approval-clock')!.getBoundingClientRect()
    return [...el.querySelectorAll('.approval-actions .approval-btn')].every((b) => {
      const r = b.getBoundingClientRect()
      return r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom
    })
  })).toBe(true)
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
  // Two lines where they fit; in this narrow column (Settings' nav) the buttons take a third line
  // rather than sit over the time (2026-11-06: "9:56 le" cut under Deny in the Org list).
  await expect.poll(async () => Math.round((await card3.boundingBox())!.height)).toBeLessThanOrEqual(90)
  expect(await card3.evaluate((el) => {
    const c = el.querySelector('.approval-clock')!.getBoundingClientRect()
    return [...el.querySelectorAll('.approval-actions .approval-btn')].every((b) => {
      const r = b.getBoundingClientRect()
      return r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom
    })
  })).toBe(true)
  await expect(card3.getByRole('button', { name: 'Deny' })).toHaveCount(0)
  await expect(card3.getByText('Approve?')).toBeVisible()
  // On the phone it sits at the top of the screen (a computer keeps it at the bottom left), across
  // it with 8px each side, over the bar.
  await expect.poll(async () => {
    const line = (await card3.boundingBox())!
    return line.y >= 0 && line.y <= 24 && Math.round(line.x) === 8 && Math.round(line.width) === 390 - 16
  }).toBe(true)
  // A toast on the phone is two short rows under it for its few seconds (a tap opens the center), and the
  // page under the bar does not move.
  const areaTop = (await page.locator('.main-content-row > .app-content-area').boundingBox())!.y
  sock()!.send(agentErrorEvent('agent-phone', '401 unauthorized (phone notice)'))
  const phoneToast = stack.locator('.notification-toast').first()
  await expect(phoneToast).toBeVisible()
  // Two short rows (the card's who and status, then its first line), never its whole text.
  await expect.poll(async () => Math.round((await phoneToast.boundingBox())!.height)).toBeLessThanOrEqual(56)
  expect((await phoneToast.boundingBox())!.y).toBeLessThan(844 / 2)
  expect((await page.locator('.main-content-row > .app-content-area').boundingBox())!.y).toBe(areaTop)
  await card3.locator('.approval-line-open').click()
  await dialog.getByRole('button', { name: 'Deny' }).click()
  expect((await waitFor(request, third.id, thirdToken)).approval.status).toBe('denied')
})

test('a narrow corner (a page\'s left column): the card reads the whole action and who asks, the buttons on their own row', async ({ page, request }) => {
  // Review 2026-11-06: over the Passwords page's left rail (~190px) the card read "Let a Walnut
  // agent cli…" and "A..". Its title is whole at every width.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await expect(page.locator('.app-layout, #root').first()).toBeVisible()
  await offHome(page)
  const what = `Place an order on shop.example.test (${stamp()})`
  const made = await ask(request, { what })
  const card = page.locator(`[data-testid="corner-stack"] [data-testid="approval-card"][data-approval-id="${made.approval.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  const text = card.locator('.approval-what-text')
  await expect(text).toHaveText(what)
  // A corner with room (Settings keeps the corner over its own nav, so it is set here): the title
  // whole there too, never cut to an ellipsis (round 3: it hid the site and why it waits).
  const width = (px: number) => page.evaluate((w) => {
    let el = document.getElementById('pw-corner-width')
    if (!el) { el = document.createElement('style'); el.id = 'pw-corner-width'; document.head.append(el) }
    el.textContent = `.corner-stack { width: ${w}px !important; }`
  }, px)
  await width(440)
  await expect.poll(() => text.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe('normal')
  expect(await text.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)

  await width(190)
  await expect.poll(() => text.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe('normal')
  // The whole action, on more than one line, and who asks in full.
  expect(await text.evaluate((e) => e.scrollHeight <= e.clientHeight + 1 && e.scrollWidth <= e.clientWidth + 1)).toBe(true)
  expect((await text.boundingBox())!.height).toBeGreaterThan(24)
  const who = card.locator('.approval-who')
  expect(await who.evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1)).toBe(true)
  // Deny and Approve on their own row, under who asks, inside the card.
  const whoBox = (await who.boundingBox())!
  const cardBox = (await card.boundingBox())!
  for (const name of ['Deny', 'Approve']) {
    const b = (await card.getByRole('button', { name, exact: true }).boundingBox())!
    expect(b.y, `${name} under who asks`).toBeGreaterThanOrEqual(whoBox.y + whoBox.height - 1)
    expect(b.x + b.width, `${name} inside the card`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1)
  }
  if (process.env.APR_SHOTS) await card.screenshot({ path: `${process.env.APR_SHOTS}/approval-narrow-card.png` })

  // Made smaller by the person, it stays short: its two lines, and in a corner this narrow the
  // buttons on a row of their own under them (approvals.css .approval-line-meta: the time is never
  // cut to "9:56 le" to make room), buttons kept.
  await card.getByTestId('approval-minimize').click()
  await expect(card).toHaveClass(/approval-card-line/)
  // The sentence may take a second line here (approvals.css .approval-line-what).
  await expect.poll(async () => Math.round((await card.boundingBox())!.height)).toBeLessThanOrEqual(112)
  const clock = card.locator('.approval-clock').first()
  expect(await clock.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
  await expect(card.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
  const res = await request.post(`/api/v1/approvals/${made.approval.id}/answer`, { data: { decision: 'deny' } })
  expect(res.ok()).toBe(true)
})

test('an agent\'s browser step on the corner card reads whole, the site and why it waits, wide or narrow (review round 3)', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await expect(page.locator('.app-layout, #root').first()).toBeVisible()
  await offHome(page)
  // What outward-asks.ts writes for a held "Place order", with this run's stamp.
  const what = `Let a Walnut agent click button "Place order" on shop.example.test:3650 ($42.10)? (${stamp()}) It buys or pays.`
  const made = await ask(request, { what })
  const card = page.locator(`[data-testid="corner-stack"] [data-testid="approval-card"][data-approval-id="${made.approval.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  const text = card.locator('.approval-what-text')
  await expect(text).toHaveText(what)
  const width = (px: number) => page.evaluate((w) => {
    let el = document.getElementById('pw-corner-width')
    if (!el) { el = document.createElement('style'); el.id = 'pw-corner-width'; document.head.append(el) }
    el.textContent = `.corner-stack { width: ${w}px !important; }`
  }, px)
  for (const px of [380, 190]) {
    await width(px)
    // Nothing cut: it wraps to as many lines as it needs, the reason at its end on screen.
    await expect.poll(() => text.evaluate((e) => e.scrollHeight <= e.clientHeight + 1 && e.scrollWidth <= e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis')).toBe(true)
    expect((await text.boundingBox())!.height, `${px}px: more than one line`).toBeGreaterThan(24)
    if (process.env.APR_SHOTS) await card.screenshot({ path: `${process.env.APR_SHOTS}/approval-whole-${px}.png` })
  }
  const res = await request.post(`/api/v1/approvals/${made.approval.id}/answer`, { data: { decision: 'deny' } })
  expect(res.ok()).toBe(true)
})

// The one Approvals switch (src/core/approvals/ask-me.ts; 2026-11-12, the user: "I want it to be off
// by default don't need my approval for anything"): the card's "Approve, and stop asking me" approves
// it and turns the switch off, Settings shows it off, a new ask goes ahead with no card, and turning
// it back on in Settings brings the cards back. The fixture starts asking (test setup default), and
// the test leaves it on for the other files.

// A Git push from the Git gate (2026-11-12, the user on its dialog: "I just need to know which task
// and which path right.. this si confuing"): the request's line on top until Walnut's summary
// arrives, then two lines, Task (a link) and Repo (path, branch, machine); the command and the
// exact JSON it is bound to are in Details, closed.
test('a Git push approval reads as Task and Repo, with the command and the exact detail folded', async ({ page, request }, info) => {
  await page.goto('/')
  await expect(page.locator('.app-layout, #root').first()).toBeVisible()
  await offHome(page)
  const res = await request.post('/api/test/host-fixture', { data: {
    action: 'git-push-approval', host: 'clouddev', taskTitle: 'Orchid Platform Lead',
    repository: '/local/home/dev/.local/state/open-walnut/tasks/t-8252/meta-fresh', branch: 'mainline',
  } })
  expect(res.status(), await res.text()).toBe(200)
  const made = await res.json() as { approval: { id: string } }
  const card = page.locator(`[data-testid="approval-card"][data-approval-id="${made.approval.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.getByTestId('approval-what').click()
  const dialog = page.getByTestId('approval-dialog')
  await expect(dialog.getByTestId('approval-task')).toHaveText(/^Task\s*Orchid Platform Lead/)
  await expect(dialog.getByTestId('approval-task-link')).toBeVisible()
  await expect(dialog.getByTestId('approval-where')).toHaveText(/^Repo\s*~\/\.local\/state\/open-walnut\/tasks\/t-8252\/meta-fresh → mainline \(.+\)$/)
  // Until a summary is written the request's own line is on top; no command, no JSON above the fold.
  await expect(dialog.getByTestId('approval-asks')).toHaveText('Push commit da21d9c to origin mainline in meta-fresh')
  await expect(dialog.getByTestId('approval-ai-summary')).toHaveCount(0)
  await expect(dialog.locator('.approval-what')).toHaveCount(0)
  await expect(dialog.getByTestId('approval-command')).toBeHidden()
  await expect(dialog.locator('.approval-detail-text')).toBeHidden()
  await expect(dialog.locator('details')).toHaveCount(1)
  await expect(dialog.locator('.approval-clock')).toHaveText(/^\d+:\d\d left$/)
  await expect(dialog.getByRole('button', { name: 'Deny' })).toBeVisible()
  if (process.env.APR_SHOTS) await page.locator('.approval-dialog').screenshot({ path: `${process.env.APR_SHOTS}/${info.project.name}-git-closed.png` })
  // Details opens the command and the exact detail, and closes again.
  await dialog.locator('.approval-detail summary').click()
  await expect(dialog.getByTestId('approval-command')).toBeVisible()
  await expect(dialog.getByTestId('approval-command')).toContainText('meta-fresh')
  await expect(dialog.locator('.approval-detail-text')).toContainText('"remoteRef": "refs/heads/mainline"')
  await expect(dialog.locator('.approval-details')).toContainText('Exact detail (used once)')
  if (process.env.APR_SHOTS) await page.locator('.approval-dialog').screenshot({ path: `${process.env.APR_SHOTS}/${info.project.name}-git-open.png` })
  await dialog.locator('.approval-detail summary').click()
  await expect(dialog.getByTestId('approval-command')).toBeHidden()
  // The dialog never scrolls sideways on a long path.
  expect(await page.locator('.approval-dialog').evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true)
  await dialog.getByRole('button', { name: 'Deny' }).click()
  await expect.poll(async () => (await (await request.get(`/api/v1/approvals/${made.approval.id}`)).json()).approval.status).toBe('denied')
})

// The summary Walnut writes (2026-11-14, the user: "Broi..... I need the summary AI write"): it
// arrives after the dialog opens and takes the top in full (never cut, never folded), says who wrote
// it, and the request's line that repeats the Repo line leaves; Task and Repo stay right under it.
test('a Git push approval shows the summary Walnut wrote on top, in full, once it arrives', async ({ page, request }, info) => {
  const summary = 'Pushes the two progress-table commits to the shared repo, so the team reads today\'s numbers before the 3pm review. '
    + 'Both commits are only on this machine; nothing else in the repo changes.'
  await page.goto('/')
  await expect(page.locator('.app-layout, #root').first()).toBeVisible()
  await offHome(page)
  const res = await request.post('/api/test/host-fixture', { data: {
    action: 'git-push-approval', host: 'clouddev', taskTitle: 'Orchid Platform Lead', summary, summaryAfterMs: 6_000,
    repository: '/local/home/dev/.local/state/open-walnut/tasks/t-8252/meta-fresh', branch: 'mainline',
  } })
  expect(res.status(), await res.text()).toBe(200)
  const made = await res.json() as { approval: { id: string } }
  const card = page.locator(`[data-testid="approval-card"][data-approval-id="${made.approval.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.getByTestId('approval-what').click()
  const dialog = page.getByTestId('approval-dialog')
  // First the request's own line, then the summary replaces it live.
  await expect(dialog.getByTestId('approval-asks')).toHaveText('Push commit da21d9c to origin mainline in meta-fresh')
  await expect(dialog.getByTestId('approval-ai-summary')).toHaveText(summary, { timeout: 15_000 })
  await expect(dialog.getByTestId('approval-asks')).toHaveCount(0)
  await expect(dialog.getByTestId('approval-dialog-summary')).toContainText('Walnut’s summary of the task’s session: the lines below are what you approve')
  // Shown whole: no clamp, no ellipsis, nothing hidden inside its box.
  expect(await dialog.getByTestId('approval-ai-summary').evaluate((n) => n.scrollHeight <= n.clientHeight + 1 && getComputedStyle(n).webkitLineClamp !== '2')).toBe(true)
  // The summary comes first, then Task and Repo.
  const order = await dialog.locator('[data-testid="approval-ai-summary"], [data-testid="approval-task"], [data-testid="approval-where"]').evaluateAll((ns) => ns.map((n) => n.getAttribute('data-testid')))
  expect(order).toEqual(['approval-ai-summary', 'approval-task', 'approval-where'])
  await expect(dialog.getByTestId('approval-where')).toHaveText(/^Repo\s*~\/\.local\/state\/open-walnut\/tasks\/t-8252\/meta-fresh → mainline \(.+\)$/)
  await expect(dialog.getByTestId('approval-command')).toBeHidden()
  if (process.env.APR_SHOTS) await page.locator('.approval-dialog').screenshot({ path: `${process.env.APR_SHOTS}/${info.project.name}-git-summary.png` })
  // The task link still opens the task that asked.
  await expect(dialog.getByTestId('approval-task-link')).toBeVisible()
  await dialog.locator('.approval-detail summary').click()
  await expect(dialog.getByTestId('approval-command')).toContainText('meta-fresh')
  await page.waitForTimeout(600)
  await dialog.locator('.approval-detail summary').click()
  await page.waitForTimeout(600)
  await dialog.getByRole('button', { name: 'Deny' }).click()
  await expect.poll(async () => (await (await request.get(`/api/v1/approvals/${made.approval.id}`)).json()).approval.status).toBe('denied')
})

// The summary is always read whole, with no click; Details holds only the technical part
// (2026-11-14, the user: "summayr一直都显示不需要点detail detail只是xommend detail啥的"). Three kinds
// side by side: one of Walnut's own asks (its explanation in words), a Git push with the summary
// Walnut wrote, and a script that said why.
test('every kind of approval shows its summary whole, with Details holding only the technical part', async ({ page, request }, info) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await expect(page.locator('.app-layout, #root').first()).toBeVisible()
  await offHome(page)
  const s = stamp()
  const steps = 'The task "Notes" wants to click "Send" in your browser, which would send something in your name (a reply to the club).\n'
    + 'Page: https://mail.example.test/inbox\nMessage it sends: Thanks for the invite, I will bring the projector on Friday.\n'
    + 'Approve to let it take this one step; deny and it stops there.'
  const own = await (await request.post('/api/test/host-fixture', { data: { action: 'builtin-approval', what: `Let "Notes" click "Send" on mail.example.test? (${s})`, detail: steps } })).json() as { approval: { id: string } }
  const summary = 'Pushes the two progress-table commits to the shared repo, so the team reads today\'s numbers before the review.'
  const git = await (await request.post('/api/test/host-fixture', { data: {
    action: 'git-push-approval', host: 'clouddev', taskTitle: 'Orchid Platform Lead', summary,
    repository: '/local/home/dev/.local/state/open-walnut/tasks/t-8252/meta-fresh', branch: 'mainline',
  } })).json() as { approval: { id: string } }
  const why = 'The launch post links to these notes at noon, so they must be on the site first.'
  const script = await ask(request, { what: `Publish the release notes? (${s})`, why, detail: 'site/notes.md | 42 +++++\n1 file changed' })
  // Each: what the dialog reads with no click, its technical part, and what the corner card leads with.
  const cases: Array<[string, string[], string | null, string[]]> = [
    [own.approval.id, ['Message it sends: Thanks for the invite, I will bring the projector on Friday.', 'Approve to let it take this one step'], null, [`Let "Notes" click "Send" on mail.example.test? (${s})`]],
    [git.approval.id, [summary, 'Walnut’s summary of the task’s session: the lines below are what you approve'], 'git -C', [summary, 'Push commit']],
    [script.approval.id, [why], 'site/notes.md', [`Publish the release notes? (${s})`, why]],
  ]
  // The corner shows the oldest first; each Deny brings the next one up.
  for (const [id, mustRead, technical, cardReads] of cases) {
    const card = page.locator(`[data-testid="approval-card"][data-approval-id="${id}"]`)
    await expect(card).toBeVisible({ timeout: 15_000 })
    // The corner card leads with the summary too, whole (its title first, then the line under it).
    await expect(card.locator('.approval-what-text')).toHaveText(cardReads[0]!, { timeout: 15_000 })
    for (const words of cardReads.slice(1)) await expect(card.getByText(words, { exact: false }).first()).toBeVisible()
    // Its kicker takes at most two lines in a narrow corner, never a word a line beside the count and the clock.
    const kicker = card.locator('.approval-kicker').first()
    expect(await kicker.evaluate((e) => e.getBoundingClientRect().height)).toBeLessThanOrEqual(40)
    await page.waitForTimeout(500)
    await card.getByTestId('approval-what').click()
    const dialog = page.locator(`.approval-dialog[data-approval-id="${id}"]`)
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    for (const words of mustRead) {
      // Read without a click: on screen now, and not inside the Details fold.
      await expect(dialog.getByText(words, { exact: false }).first()).toBeVisible({ timeout: 15_000 })
      await expect(dialog.locator('details').filter({ hasText: words })).toHaveCount(0)
    }
    if (technical) {
      await expect(dialog.locator('details').filter({ hasText: technical })).toHaveCount(1)
      await expect(dialog.getByText(technical).first()).toBeHidden()
    } else {
      // Nothing technical: no Details fold at all.
      await expect(dialog.locator('details')).toHaveCount(0)
    }
    if (process.env.APR_SHOTS) await page.locator('.approval-dialog').screenshot({ path: `${process.env.APR_SHOTS}/${info.project.name}-whole-${cases.findIndex((c) => c[0] === id)}.png` })
    await page.waitForTimeout(1_500)
    await dialog.getByRole('button', { name: 'Deny' }).click()
    await expect.poll(async () => (await (await request.get(`/api/v1/approvals/${id}`)).json()).approval.status).toBe('denied')
    await page.getByTestId('approval-dialog').locator('.approval-dialog-close').click({ timeout: 3_000 }).catch(() => {})
    await page.waitForTimeout(600)
  }
})
