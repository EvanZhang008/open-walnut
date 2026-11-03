/**
 * Approvals in the console (web/src/components/approvals/ApprovalPrompts.tsx), as a person
 * uses them: a script asks (`walnut approve`, here its POST), a card shows up live on the
 * page that is already open, the person clicks, and the asker's wait reads that decision.
 *
 *  - tap: Approve and Deny each reach the asker, used once;
 *  - biometric with no signing device: the card asks for a tap and says why;
 *  - biometric with a device: a browser offers no Approve, says to use Face ID, and Deny works;
 *  - Needs you: a row on Home (counted there) whose click opens the dialog, Deny in the row, and
 *    Main's Needs you on the Org page listing it with Approve in the row.
 *
 * The fixture server marks no test objects, while this automated window has a test-run label,
 * so this also pins that a live card shows there (the window re-reads the server's list).
 * Run on the Mac app's engine: PW_WEBKIT=1 bun x playwright test approvals --project webkit
 */
import { expect, test, type APIRequestContext } from '@playwright/test'
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

async function waitFor(request: APIRequestContext, id: string, token: string) {
  const res = await request.post(`/api/v1/approvals/${id}/wait`, { data: { token, wait_ms: 5_000 } })
  expect(res.status()).toBe(200)
  return await res.json() as { approval: { status: string; answer?: { mode: string; device: { kind: string } } }; used: boolean }
}

test('a tap approval shows up live, and Approve and Deny each reach the asker', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.app-layout, #root').first()).toBeVisible()

  const what = `Deploy web ${stamp()}`
  const made = await ask(request, { what, detail: 'web: 3 files changed\nmigrations: none' })
  const card = page.locator(`[data-testid="approval-card"][data-approval-id="${made.approval.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator('.approval-what')).toHaveText(what)
  await expect(card.locator('.approval-who')).toContainText('release.sh on')
  await expect(card.locator('.approval-clock')).toHaveText(/^\d+:\d\d$/)
  await card.locator('summary', { hasText: 'Detail' }).click()
  await expect(card.locator('.approval-detail pre')).toContainText('migrations: none')
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.locator(`.approval-card-settled[data-approval-id="${made.approval.id}"]`)).toContainText('Approved')
  const got = await waitFor(request, made.approval.id, made.waitToken)
  expect(got).toMatchObject({ used: true, approval: { status: 'approved', answer: { mode: 'tap', device: { kind: 'web' } } } })
  await expect(card).toHaveCount(0, { timeout: 5_000 })

  const deny = await ask(request, { what: `Drop staging table ${stamp()}` })
  const denyCard = page.locator(`[data-testid="approval-card"][data-approval-id="${deny.approval.id}"]`)
  await expect(denyCard).toBeVisible({ timeout: 15_000 })
  await denyCard.getByRole('button', { name: 'Deny' }).click()
  expect((await waitFor(request, deny.approval.id, deny.waitToken)).approval.status).toBe('denied')
})

test('biometric: a tap with a reason when no device signs, then Face ID only once one does', async ({ page, request }) => {
  const keys = await (await request.get('/api/v1/approvals/keys')).json() as { keys: Array<{ status: string }> }
  test.skip(keys.keys.some((k) => k.status === 'active'), 'a signing device is already enrolled on this fixture server')

  await page.goto('/')
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

test('Needs you: an approval is a row on Home, a click opens the request, and Main on the Org page lists it', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.app-layout, #root').first()).toBeVisible()

  // Home: the row sits in Needs you, counted with the tasks there; its click opens the dialog.
  const first = await ask(request, { what: `Release notes ${stamp()}`, detail: 'notes: 4 lines' })
  const row = page.locator(`.status-section-block-needs [data-testid="approval-row"][data-approval-id="${first.approval.id}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.approval-row-who')).toContainText('release.sh on')
  const count = Number(await page.getByTestId('status-section-needs-count').innerText())
  expect(count).toBeGreaterThanOrEqual(1)
  await row.locator('.approval-row-what').click()
  const dialog = page.getByTestId('approval-dialog')
  await expect(dialog.locator('.approval-what')).toContainText('Release notes')
  await expect(dialog.locator('.approval-detail pre')).toContainText('notes: 4 lines')
  // The open request is the dialog's alone: no second card for it at the bottom right.
  await expect(page.locator(`[data-testid="approval-card"][data-approval-id="${first.approval.id}"]`)).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByTestId('approval-dialog-settled')).toContainText('Approved')
  expect((await waitFor(request, first.approval.id, first.waitToken)).approval.status).toBe('approved')
  await expect(row).toHaveCount(0)
  await expect(dialog).toHaveCount(0, { timeout: 5_000 })

  // Deny right in the row, no dialog.
  const second = await ask(request, { what: `Wipe cache ${stamp()}` })
  const row2 = page.locator(`[data-testid="approval-row"][data-approval-id="${second.approval.id}"]`).first()
  await expect(row2).toBeVisible({ timeout: 15_000 })
  await row2.getByRole('button', { name: 'Deny' }).click()
  expect((await waitFor(request, second.approval.id, second.waitToken)).approval.status).toBe('denied')
  await expect(dialog).toHaveCount(0)

  // Org: Main answers for the person, so its Needs you lists the approval, and its row counts it.
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
  const orgRow = page.locator(`[data-testid="org-rail"] [data-testid="approval-row"][data-approval-id="${third.approval.id}"]`)
  await expect(orgRow).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-testid="org-task-tab"][data-tab="needs"] .org-task-tab-count')).not.toHaveText('0')
  await orgRow.getByRole('button', { name: 'Approve', exact: true }).click()
  expect((await waitFor(request, third.approval.id, third.waitToken)).approval.status).toBe('approved')
  await expect(orgRow).toHaveCount(0)
})
