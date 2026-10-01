/**
 * Settings > Mail rules (spec 12), reached by SPA clicks from the sidebar, on the `PW_MAIL_GROUPS`
 * fixture. The rules file is read and written through the helpers (its path comes from the fixture
 * server's own `GET /rules`), so every claim is checked against the bytes on disk:
 *
 * - C31 C75 C88: the real path, Copy path, the Triage cross-links both ways, Create rules file.
 * - C32: add, edit, disable and delete a rule, each written to the file and applied to the groups.
 * - C63: two quick moves are one write (or two chained ones), focus follows the moved row, `.bak` is
 *   the pre-edit file.
 * - C33 C65: a hand edit is picked up; a broken one keeps the last rules and says which line.
 * - C34: an edit open while the file changes on disk is never silently written over it.
 * - C67: a pattern that could hang is refused before any preview is sent.
 * - C92: a file that vanishes briefly changes nothing; one that stays gone can be restored.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import {
  ALL_INBOXES, FERRY, MARINA, ROW, api, fileHash, getGroups, groupOfMessage, readRulesFile, rulesPath, startGroupsFixture,
  waitLabeled, waitSorted, writeRulesFile,
} from './mail-grouping-helpers'
import { openMail, shoot, smartRow, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

const SHOTS = '/tmp/mail-grouping/shots/v2/chromium'
const PANEL = '#mail-rules'
const RISKY = 'This pattern could take too long to run. Remove the repeated group.'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

let server: MailFixtureServer
let fixture: MailFixture
test.beforeAll(async () => {
  test.setTimeout(240_000)
  ;({ server, fixture } = await startGroupsFixture())
  await waitLabeled(fixture, ALL_INBOXES, 120_000)
})
test.afterAll(async () => { await server?.stop() })

async function expandSidebar(page: Page): Promise<void> {
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

/** The first load goes through Mail (the one page.goto); Settings is then reached by clicks only. */
async function openRules(page: Page, loaded = false): Promise<void> {
  if (!loaded) await openMail(page, fixture.port)
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await page.getByTestId('settings-nav-mail-rules').click()
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('mail-rules-path')).toBeVisible({ timeout: 30_000 })
}

async function fileDoc(): Promise<{ groups?: string[]; rules?: any[] } | null> {
  const text = await readRulesFile(fixture)
  if (text === null) return null
  const yaml = await import('js-yaml')
  return yaml.load(text) as { groups?: string[]; rules?: any[] }
}

function ruleRows(page: Page) {
  return page.locator(PANEL).getByTestId('mail-rule-row')
}

async function waitRulesCount(count: number): Promise<void> {
  await expect.poll(async () => (await api(fixture, '/rules')).body.rules.length, { timeout: 15_000 }).toBe(count)
}

async function groupOf(messageId: string, accountId = MARINA): Promise<string | null> {
  await waitSorted(fixture)
  return groupOfMessage(fixture, accountId, messageId)
}

test('C31 C75 C88: the real path, Copy path, Create rules file, Open in Walnut, and the Triage cross-links', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const path = await rulesPath(fixture)
  expect(await readRulesFile(fixture)).toBeNull()
  await openRules(page)
  await page.evaluate(() => { (window as unknown as { __spaMarker?: number }).__spaMarker = 42 })
  await expect(page.getByTestId('mail-rules-path')).toHaveText(path)
  await expect(page.locator(PANEL)).toContainText('Sorts your inbox into Important and groups with rules you control.')
  if (browserName === 'chromium') {
    await page.getByTestId('mail-rules-copy-path').click()
    await expect(page.getByTestId('mail-rules-copy-path')).toHaveText('Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(path)
  }
  await expect(page.locator(PANEL)).toContainText('No rules file yet. Walnut creates it the first time you save a rule.')
  await expect(page.getByTestId('mail-rules-empty')).toHaveText('No rules yet. Use "Important\u2026" or "Not important\u2026" on a mail in Mail to teach Walnut, or add one here.')
  await expect(page.getByTestId('mail-rules-builtin')).toHaveCount((await api(fixture, '/rules')).body.builtins.length)
  await page.getByTestId('mail-rules-create').click()
  // Scoped: the grouped Mail list has its own `mail-rules-open` (its error strip's Open Mail rules).
  await expect(page.locator(PANEL).getByTestId('mail-rules-open')).toBeVisible()
  const created = await readRulesFile(fixture)
  expect(created).toContain('#')
  expect((await api(fixture, '/rules')).body).toMatchObject({ exists: true, rules: [] })
  const again = await api(fixture, '/rules/init', { body: {} })
  expect(again.status).toBe(409)
  expect(await readRulesFile(fixture)).toBe(created)
  await page.locator(PANEL).getByTestId('mail-rules-open').click()
  await expect(page.locator('.file-viewer-overlay')).toBeVisible()
  await expect(page.locator('.file-viewer-overlay')).toContainText('sort-rules.yaml')
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  // The two panels link to each other, by SPA navigation.
  await page.getByTestId('mail-rules-triage-link').getByRole('link', { name: 'Open Inbox Triage' }).click()
  await expect(page).toHaveURL(/#triage$/)
  await page.getByTestId('triage-mail-rules-link').getByRole('link', { name: 'Open Mail rules' }).click()
  await expect(page).toHaveURL(/#mail-rules$/)
  expect(await page.evaluate(() => (window as unknown as { __spaMarker?: number }).__spaMarker)).toBe(42)
  await expect(page.locator(PANEL)).toContainText('Mail that Inbox Triage marks read is not part of group Undo.')
  // Not the Triage tray: the nav tile draws its own glyph.
  const navHtml = await page.getByTestId('settings-nav-mail-rules').innerHTML()
  const trayHtml = await page.getByTestId('settings-nav-triage').innerHTML()
  expect(navHtml).not.toBe(trayHtml)
  await shoot(page, SHOTS, 'c31-settings')
})

const THREE_RULES = [
  'version: 1', 'groups: []', 'rules:',
  '  - id: r-aaaa01', '    when: { from: "issues@*" }', '    then: Important', '    source: user',
  '  - id: r-aaaa02', '    when: { from: "no-reply@review.example.invalid" }', '    then: Important', '    source: user',
  '  - id: r-aaaa03', '    when: { from: "notifications@code.example.invalid" }', '    then: Group mail', '    source: learned',
  '    note: "code host mail"', '    created: 2026-09-28', '',
].join('\n')

test('C63: two quick moves never 409, focus follows the moved row, and .bak is the pre-edit file', async ({ page }) => {
  await writeRulesFile(fixture, THREE_RULES)
  await waitRulesCount(3)
  // Let the save that made `.bak` fall outside the 60 s edit session: the moves below start a new one.
  const path = await rulesPath(fixture)
  await openRules(page)
  await expect(ruleRows(page)).toHaveCount(3)
  const puts: Array<{ baseRev: string; status: number }> = []
  page.on('requestfinished', async (request) => {
    if (request.method() !== 'PUT' || !request.url().endsWith('/api/plugins/mail/rules')) return
    const body = JSON.parse(request.postData() ?? '{}') as { baseRev: string }
    puts.push({ baseRev: body.baseRev, status: (await request.response())?.status() ?? 0 })
  })
  const beforeFile = await readRulesFile(fixture)
  const first = ruleRows(page).nth(0)
  await first.getByRole('button', { name: /^Move down / }).click()
  const moved = page.locator(PANEL).locator('[data-rule-id="r-aaaa01"]')
  await expect(moved.getByRole('button', { name: /^Move down / })).toBeFocused()
  await expect(moved.getByTestId('mail-rules-moved')).toHaveText('Moved')
  await page.keyboard.press('Enter')
  await expect(moved.getByRole('button', { name: /^Move up / })).toBeFocused()
  await expect.poll(async () => (await fileDoc())!.rules!.map((one) => one.id), { timeout: 10_000 })
    .toEqual(['r-aaaa02', 'r-aaaa03', 'r-aaaa01'])
  await expect.poll(() => puts.length, { timeout: 5_000 }).toBeGreaterThan(0)
  expect(puts.every((one) => one.status === 200), JSON.stringify(puts)).toBe(true)
  expect(puts.length).toBeLessThanOrEqual(2)
  await expect(page.locator(PANEL).getByTestId('mail-rules-save-error')).toHaveCount(0)
  const bak = await fs.readFile(`${path}.bak`, 'utf8').catch(() => null)
  expect(bak).toBe(beforeFile)
  // The provenance lines read off the file.
  await expect(moved.getByTestId('mail-rule-provenance')).toHaveText('Added by you')
  await expect(page.locator(PANEL).locator('[data-rule-id="r-aaaa03"]').getByTestId('mail-rule-provenance'))
    .toHaveText('Learned Sep 28 \u00b7 "code host mail"')
})

test('C33 C65: a hand edit applies; a broken file keeps the last rules and names the line; fixed, the error goes', async ({ page }) => {
  await writeRulesFile(fixture, THREE_RULES)
  await waitRulesCount(3)
  await openRules(page)
  // A valid hand edit: one more rule, picked up within 7 s.
  await writeRulesFile(fixture, THREE_RULES.replace('rules:\n', 'rules:\n  - id: r-aaaa00\n    when: { from: "payroll", account: "' + FERRY + '" }\n    then: Group mail\n    source: user\n'))
  await expect(ruleRows(page)).toHaveCount(4, { timeout: 7_000 })
  // Broken: `then: 3`. Its line in the file, counted from 1.
  const broken = THREE_RULES.replace('    then: Group mail', '    then: 3')
  const line = broken.split('\n').findIndex((one) => one === '    then: 3') + 1
  await writeRulesFile(fixture, broken)
  const strip = page.getByTestId('mail-rules-file-error')
  await expect(strip).toBeVisible({ timeout: 8_000 })
  await expect(strip).toContainText(`Line ${line}:`)
  await expect(strip).toContainText('Walnut is still using the rules from')
  await expect(ruleRows(page)).toHaveCount(4)
  await expect(ruleRows(page).first().getByTestId('mail-rule-edit')).toBeDisabled()
  await shoot(page, SHOTS, 'c33-broken')
  // The grouped view says so too.
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-mail').click()
  await smartRow(page, 'inbox').click()
  await expect(page.getByTestId('mail-rules-error')).toBeVisible({ timeout: 20_000 })
  // A typo of a name the file already knows is a mistake, not a new group.
  await writeRulesFile(fixture, THREE_RULES.replace('    then: Group mail', '    then: Importnat'))
  await expect.poll(async () => (await api(fixture, '/rules')).body.error?.message ?? '', { timeout: 8_000 })
    .toContain('then: Importnat is not a group. Did you mean Important?')
  await writeRulesFile(fixture, THREE_RULES)
  await expect(page.getByTestId('mail-rules-error')).toHaveCount(0, { timeout: 8_000 })
  await openRules(page, true)
  await expect(page.getByTestId('mail-rules-file-error')).toHaveCount(0)
})

test('C34: an edit left open while the file changes on disk is never written over it', async ({ page }) => {
  await writeRulesFile(fixture, THREE_RULES)
  await waitRulesCount(3)
  await openRules(page)
  await ruleRows(page).first().getByTestId('mail-rule-edit').click()
  const editor = page.getByTestId('mail-rule-editor')
  await editor.getByTestId('mail-rule-note').fill('an edit in progress')
  const onDisk = THREE_RULES.replace('    then: Group mail', '    then: Important')
  await writeRulesFile(fixture, onDisk)
  await expect(page.getByTestId('mail-rules-changed')).toHaveText('The rules file changed on disk.', { timeout: 8_000 })
  await page.getByTestId('mail-rules-keep-editing').click()
  await editor.getByTestId('mail-rule-save').click()
  await expect(page.getByTestId('mail-rules-save-error')).toHaveText('The rules file changed on disk. Reload to see the new version.')
  expect(await readRulesFile(fixture)).toBe(onDisk)
  await page.getByTestId('mail-rules-error-reload').click()
  await expect(page.getByTestId('mail-rule-editor')).toHaveCount(0)
  await expect(page.getByTestId('mail-rules-save-error')).toHaveCount(0)
})

test('C67: a pattern that could hang is refused in the editor and never previewed; the server stays quick', async ({ page }) => {
  await openRules(page)
  const previews: string[] = []
  page.on('request', (request) => { if (request.url().includes('/rules/preview')) previews.push(request.postData() ?? '') })
  await page.getByTestId('mail-rules-add').click()
  const editor = page.getByTestId('mail-rule-editor')
  await editor.getByTestId('mail-rule-field').click()
  await page.getByTestId('mail-rule-field-list').getByRole('option', { name: 'Subject pattern' }).click()
  const before = previews.length
  await editor.getByTestId('mail-rule-value').fill('(a+)+$')
  await expect(editor.getByTestId('mail-rule-field-error')).toHaveText(RISKY)
  await page.waitForTimeout(900)
  expect(previews.slice(before).some((one) => one.includes('(a+)+$'))).toBe(false)
  const started = Date.now()
  const config = await fetch(`http://localhost:${fixture.port}/api/config`)
  expect(config.status).toBe(200)
  expect(Date.now() - started).toBeLessThan(200)
  // The server refuses it too, if it is written by hand.
  const refused = await api(fixture, '/rules/preview', { body: { scope: { role: 'inbox' }, when: { subject: { re: '(a+)+$' } }, then: 'Important' } })
  expect(refused.status).toBe(400)
  await editor.getByTestId('mail-rule-cancel').click()
})

test('C74: an account condition shows the account name, never its id', async ({ page }) => {
  const accounts = (await api(fixture, '/accounts')).body.accounts as Array<{ accountId: string; displayName?: string; address: string }>
  const ferry = accounts.find((one) => one.accountId === FERRY)!
  await writeRulesFile(fixture, [
    'version: 1', 'groups: []', 'rules:',
    '  - id: r-bbbb01', `    when: { from: "payroll", account: "${FERRY}" }`, '    then: Group mail', '    source: learned', '    created: 2026-09-28', '',
  ].join('\n'))
  await waitRulesCount(1)
  await openRules(page)
  const summary = ruleRows(page).first().getByTestId('mail-rule-summary')
  // The account's display name, unless another account carries the same one (a person's
  // two mailboxes usually do): then its address says which account it is.
  const shared = accounts.filter((one) => one.displayName && one.displayName === ferry.displayName).length > 1
  await expect(summary).toContainText(ferry.displayName && !shared ? ferry.displayName : ferry.address)
  expect(await page.locator(PANEL).innerText()).not.toContain(FERRY)
})

test('C92: a file gone for a moment changes nothing; gone for good, Restore from backup brings it back', async ({ page }) => {
  await writeRulesFile(fixture, THREE_RULES)
  await waitRulesCount(3)
  await openRules(page)
  // Make a `.bak` through the panel (one real save).
  await ruleRows(page).first().getByTestId('mail-rule-toggle').click()
  await expect.poll(async () => (await fileDoc())!.rules![0].enabled).toBe(false)
  const path = await rulesPath(fixture)
  const saved = await readRulesFile(fixture)
  const rev = (await api(fixture, '/rules')).body.rulesRev
  await fs.rm(path)
  await page.waitForTimeout(2_000)
  await fs.writeFile(path, saved!, 'utf8')
  await page.waitForTimeout(6_000)
  expect((await api(fixture, '/rules')).body.error).toBeUndefined()
  expect((await api(fixture, '/rules')).body.rulesRev).toBe(rev)
  // Now for good.
  await fs.rm(path)
  const strip = page.getByTestId('mail-rules-file-error')
  await expect(strip).toContainText('The rules file is missing.', { timeout: 15_000 })
  await expect(ruleRows(page)).toHaveCount(3)
  await page.getByTestId('mail-rules-restore').click()
  await expect(strip).toHaveCount(0, { timeout: 10_000 })
  expect(await readRulesFile(fixture)).not.toBeNull()
  expect(await fileHash(fixture)).not.toBe('')
})

// Last on purpose: its saves open a `.bak` edit session that C63 must not start inside.
test('C32 C48: add, edit, disable and delete a rule; each lands in the file and in the groups', async ({ page }) => {
  await writeRulesFile(fixture, 'version: 1\ngroups: []\nrules: []\n')
  await waitRulesCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openRules(page)
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { __flashes: string[] }).__flashes = seen
    new MutationObserver((records) => {
      for (const one of records) if ((one.target as Element).getAttribute?.('data-flash') === 'true') seen.push('flash')
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-flash'] })
  })
  // The model's own group first (the fixture's labeler files ticket mail under Ticket updates).
  const modelGroup = await groupOf(ROW.issues)
  expect(modelGroup).toMatch(/^u:/)
  const pager = (await getGroups(fixture, ALL_INBOXES)).groups.find((one: { label: string }) => one.label === 'Pager alerts')
  expect(pager).toBeTruthy()
  await page.getByTestId('mail-rules-add').click()
  const editor = page.getByTestId('mail-rule-editor')
  await editor.getByTestId('mail-rule-value').first().fill('issues@*')
  await expect(editor.getByTestId('mail-rule-preview')).toContainText(/Matches \d+ mail/, { timeout: 5_000 })
  await editor.getByTestId('mail-rule-note').fill('tickets are mine')
  // Keep out of the Inbox needs a group: with Important picked it cannot be ticked.
  await expect(editor.getByTestId('mail-rule-skip-inbox').locator('input')).toBeDisabled()
  await editor.getByTestId('mail-rule-save').click()
  await expect(editor).toHaveCount(0)
  await waitRulesCount(1)
  expect((await fileDoc())!.rules![0]).toMatchObject({ when: { from: 'issues@*' }, then: 'Important', source: 'user', note: 'tickets are mine' })
  await expect.poll(() => groupOf(ROW.issues), { timeout: 15_000 }).toBe('important')
  await expect(ruleRows(page)).toHaveCount(1)
  await expect(ruleRows(page).first().getByTestId('mail-rule-provenance')).toHaveText('Added by you')
  // Edit: send it to one of the model's groups instead (the targets list holds them).
  await ruleRows(page).first().getByTestId('mail-rule-edit').click()
  await editor.getByTestId('mail-rule-then').click()
  await page.getByTestId('mail-rule-then-list').getByRole('option', { name: 'Pager alerts' }).click()
  const skip = editor.getByTestId('mail-rule-skip-inbox').locator('input')
  await expect(skip).toBeEnabled()
  await skip.check()
  await editor.getByTestId('mail-rule-save').click()
  await expect(editor).toHaveCount(0)
  await expect.poll(async () => (await fileDoc())!.rules![0].then).toBe('Pager alerts')
  expect((await fileDoc())!.rules![0].skipInbox).toBe(true)
  await expect(ruleRows(page).first().getByTestId('mail-rule-skip-badge')).toHaveText('\u00b7 Skips the Inbox')
  await shoot(page.locator(PANEL), SHOTS, 'rules-skip-inbox')
  await expect.poll(() => groupOf(ROW.issues), { timeout: 15_000 }).toBe(pager.id)
  // Disable: the file says enabled false and the model's group takes the mail back.
  await ruleRows(page).first().getByTestId('mail-rule-toggle').click()
  await expect.poll(async () => (await fileDoc())!.rules![0].enabled).toBe(false)
  await expect.poll(() => groupOf(ROW.issues), { timeout: 15_000 }).toBe(modelGroup)
  // Delete needs the second click.
  const del = ruleRows(page).first().getByTestId('mail-rule-delete')
  await del.click()
  await expect(del).toHaveText('Delete rule?')
  await del.click()
  await expect.poll(async () => (await fileDoc())!.rules!.length).toBe(0)
  await expect(page.getByTestId('mail-rules-empty')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __flashes: string[] }).__flashes.length)).toBe(0)
})
