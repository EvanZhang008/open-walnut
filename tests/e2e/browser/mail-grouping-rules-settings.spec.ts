/**
 * Settings > Mail rules (spec 12), reached by SPA clicks from the sidebar, on the `PW_MAIL_GROUPS`
 * fixture. The rules file is read and written through the helpers (its path comes from the fixture
 * server's own `GET /rules`), so every claim is checked against the bytes on disk:
 *
 * - C31 C75 C88: the real path, Copy path, the Triage cross-links both ways, Create rules file, and
 *   the Built-in list's one note under its heading.
 * - C32: add, edit, disable and delete a rule, each written to the file and applied to the groups.
 * - C63: two quick moves are one write (or two chained ones), focus follows the moved row, `.bak` is
 *   the pre-edit file.
 * - C33 C65: a hand edit is picked up; a broken one keeps the last rules and says which line.
 * - C34: an edit open while the file changes on disk is never silently written over it.
 * - C67: subject patterns run in the linear matcher: nested repeats are accepted and previewed, and
 *   so is a nest of empty repeats typed key by key (the compiler once took an hour on it); a
 *   back-reference or a too-big pattern is refused in the editor, with the server's sentence, before
 *   any preview is sent. A pattern being typed is judged once typing pauses: no error on every
 *   keystroke, no preview and Save off meanwhile, and Save stays off while an error shows. A rule an
 *   older Walnut saved with a pattern now too big loads switched off, says so in one line, and keeps
 *   its pattern through a save of another rule and through an edit of its own note (said once, in
 *   the editor, while it is open); changed into another too-big one it is refused, made light it
 *   saves and the rule is on.
 * - C93: a changed condition drops the old count at once ("Checking..." in its place, no jump), and
 *   an answer for an older input never shows.
 * - C94: text is stored as typed (`^re: ` keeps its space, through a note-only edit too), an edited
 *   rule keeps a hand-written id, a stored pattern that is invalid loads that rule off with the way
 *   back on (its switch says why), hints for patterns that can never match as meant, a field change
 *   keeps the text, Enter saves, and a summary shows its pattern as code that wraps at 700 px.
 * - C92: a file that vanishes briefly changes nothing; one that stays gone can be restored.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  ALL_INBOXES, FERRY, MARINA, ROW, api, fileHash, getGroups, groupOfMessage, readRulesFile, rulesPath, startGroupsFixture,
  waitLabeled, waitSorted, writeRulesFile,
} from './mail-grouping-helpers'
import { openMail, shoot, smartRow, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

const SHOTS = '/tmp/mail-grouping/shots/v2/chromium'
const PANEL = '#mail-rules'
const BACKREFERENCE = 'This pattern refers to a group by number or name (\\1, \\k<name>), which mail rules do not support. Write out the text it should match instead.'
const TOO_BIG = 'This pattern repeats too many times to check quickly. Use smaller numbers in {n,m}.'
const tooLong = (length: number) => `This pattern is ${length} characters; the limit is 200. Shorten it, or split it into two rules.`
const RULE_OFF = 'This rule is off: its pattern repeats too many times to check quickly. Edit it with smaller numbers in {n,m} to turn it on.'
const RULE_OFF_HELD = 'This rule stays off until this pattern is made smaller. Use smaller numbers in {n,m}.'
const INVALID = 'This pattern is not a valid regular expression: '
const UNCLOSED = 'a ( has no matching ). Close it, or write \\( to match a bracket.'
const RULE_OFF_INVALID = `This rule is off until its pattern is fixed: ${UNCLOSED}`
const PATTERN_HELP = 'A regular expression; case is ignored.'
const HINT_SLASHES_FLAGS = 'Patterns here take no slashes or flags; as written, this matches only subjects that contain them.'
const HINT_NEEDS_MORE = 'This pattern needs more than 300 characters, but only the first 300 of a subject are checked, so it never matches. Make it need 300 or fewer.'
const HINT_EMPTY_CHOICE = 'The | with nothing on one side matches every subject, so the rule would take all mail.'

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
  const builtins = (await api(fixture, '/rules')).body.builtins as Array<{ then: string }>
  await expect(page.getByTestId('mail-rules-builtin')).toHaveCount(builtins.length)
  // Each built-in rule says where its mail goes, as a person's rule does.
  await expect(page.getByTestId('mail-rules-builtin-target')).toHaveText(builtins.map((one) => `\u2192 ${one.then}`))
  // The order is said once, in the rules' footer, never on every row nor again under Built-in.
  await expect(page.locator(PANEL).getByText(/yours come before the built\u2011in ones/)).toHaveCount(1)
  await expect(page.getByTestId('mail-rules-builtin').filter({ hasText: 'before the built-in' })).toHaveCount(0)
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
  // The panel points to the mail router (the Org page), which reads every new Inbox mail since 2026-11-14.
  await expect(page.getByTestId('mail-rules-router-link').getByRole('link', { name: 'Open Org' })).toHaveAttribute('href', '/org')
  await page.getByTestId('settings-nav-triage').click()
  await expect(page).toHaveURL(/#triage$/)
  // Inbox Triage no longer reads mail (2026-11-14), so its card points to the Org page, not back here.
  await expect(page.getByTestId('triage-mail-router-note').getByRole('link', { name: 'Open Org' })).toHaveAttribute('href', '/org')
  await page.getByTestId('settings-nav-mail-rules').click()
  await expect(page).toHaveURL(/#mail-rules$/)
  expect(await page.evaluate(() => (window as unknown as { __spaMarker?: number }).__spaMarker)).toBe(42)
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
  // A rule of the user's with no note has no second line; a learned one says so, with its note.
  await expect(moved.getByTestId('mail-rule-provenance')).toHaveCount(0)
  await expect(page.locator(PANEL).locator('[data-rule-id="r-aaaa03"]').getByTestId('mail-rule-provenance'))
    .toHaveText('Learned Sep 28 \u00b7 code host mail')
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

test('C67: nested repeats preview at once; a back-reference or a too-big pattern is refused before any preview; the server stays quick', async ({ page }) => {
  await openRules(page)
  const previews: string[] = []
  page.on('request', (request) => { if (request.url().includes('/rules/preview')) previews.push(request.postData() ?? '') })
  await page.getByTestId('mail-rules-add').click()
  const editor = page.getByTestId('mail-rule-editor')
  await editor.getByTestId('mail-rule-field').click()
  await page.getByTestId('mail-rule-field-list').getByRole('option', { name: 'Subject pattern' }).click()
  // What a backtracking engine hangs on is safe in the linear matcher: no refusal, a real preview.
  await editor.getByTestId('mail-rule-value').fill('(a+)+$')
  await expect(editor.getByTestId('mail-rule-preview')).toContainText(/Matches (at least )?\d[\d,]* mails?/, { timeout: 5_000 })
  await expect(editor.getByTestId('mail-rule-field-error')).toHaveCount(0)
  expect(previews.some((one) => one.includes('(a+)+$'))).toBe(true)
  const fillOf = (button: Locator) => button.evaluate((node) => getComputedStyle(node).backgroundColor)
  await expect(editor.getByTestId('mail-rule-save')).toBeEnabled()
  await expect(editor.getByTestId('mail-rule-save')).toHaveCSS('opacity', '1')
  const liveFill = await fillOf(editor.getByTestId('mail-rule-save'))
  // Compiled on every keystroke as it is typed; it once froze the compiler for an hour.
  const deep = '(?:(?:(?:(?:(?:){999}){999}){999}){999}){999}'
  await editor.getByTestId('mail-rule-value').fill('')
  await editor.getByTestId('mail-rule-value').pressSequentially(deep)
  await expect.poll(() => previews.some((one) => one.includes(deep)), { timeout: 5_000 }).toBe(true)
  await expect(editor.getByTestId('mail-rule-field-error')).toHaveCount(0)
  await expect(editor.getByTestId('mail-rule-preview')).toContainText(/Matches (at least )?\d[\d,]* mails?/, { timeout: 5_000 })
  // Typed key by key, an unfinished pattern is not red on every keystroke: it is judged once typing
  // pauses, and until then nothing is previewed and Save is off.
  for (const [typed, reason] of [
    ['(?', '(? does not start a group; a plain group is (?:...).'],
    ['[a', 'a [ has no matching ]. Close it, or write \\[ to match a bracket.'],
    ['\\', 'it ends with a lone \\. Remove it, or write \\\\ to match a backslash.'],
    ['*invoice*', '* has nothing before it to repeat. To match any text, use .* (for example .*invoice.*).'],
  ] as const) {
    const before = previews.length
    await editor.getByTestId('mail-rule-value').fill('')
    await editor.getByTestId('mail-rule-value').pressSequentially(typed)
    await expect(editor.getByTestId('mail-rule-field-error')).toHaveCount(0)
    await expect(editor.getByTestId('mail-rule-save')).toBeDisabled()
    await expect(editor.getByTestId('mail-rule-field-error')).toHaveText(`${INVALID}${reason}`)
    await expect(editor.getByTestId('mail-rule-save')).toBeDisabled()
    if (typed === '*invoice*') await shoot(editor, SHOTS, 'c67-invalid-after-pause')
    expect(previews.slice(before).some((one) => one.includes(JSON.stringify(typed).slice(1, -1)))).toBe(false)
  }
  // Leaving the field judges it at once.
  await editor.getByTestId('mail-rule-value').fill('(x')
  await editor.getByTestId('mail-rule-note').focus()
  await expect(editor.getByTestId('mail-rule-field-error')).toHaveText(`${INVALID}${UNCLOSED}`, { timeout: 400 })
  for (const [value, sentence] of [['(\\w+) \\1', BACKREFERENCE], ['(?:a{0,100}){0,100}', TOO_BIG], ['a'.repeat(218), tooLong(218)]] as const) {
    const before = previews.length
    await editor.getByTestId('mail-rule-value').fill(value)
    await expect(editor.getByTestId('mail-rule-field-error')).toHaveText(sentence)
    // Off, and looks it, from the moment the error shows: dimmed, without the blue fill.
    await expect(editor.getByTestId('mail-rule-save')).toBeDisabled()
    await expect(editor.getByTestId('mail-rule-save')).toHaveCSS('opacity', '0.45')
    expect(await fillOf(editor.getByTestId('mail-rule-save'))).not.toBe(liveFill)
    await page.waitForTimeout(900)
    const inBody = JSON.stringify(value).slice(1, -1)
    expect(previews.slice(before).some((one) => one.includes(inBody))).toBe(false)
  }
  const started = Date.now()
  const config = await fetch(`http://localhost:${fixture.port}/api/config`)
  expect(config.status).toBe(200)
  expect(Date.now() - started).toBeLessThan(200)
  // The server refuses a back-reference written by hand too, and runs the nested repeat.
  const preview = (re: string) => api(fixture, '/rules/preview', { body: { scope: { role: 'inbox' }, when: { subject: { re } }, then: 'Important' } })
  const refused = await preview('(\\w+) \\1')
  expect(refused.status).toBe(400)
  expect(JSON.stringify(refused.body)).toContain('refers to a group by number or name')
  expect((await preview('(a+)+$')).status).toBe(200)
  await editor.getByTestId('mail-rule-cancel').click()
})

test('C67: a rule saved with a pattern now too big is off with one line; the rest work; a save keeps its pattern', async ({ page }) => {
  const big = '(?:x{1,90}y{1,90}){40}'
  const withBig = `${THREE_RULES}  - id: r-aaaa09\n    when: { subject: { re: "${big}" } }\n    then: Important\n    source: user\n`
  await writeRulesFile(fixture, withBig)
  await waitRulesCount(4)
  expect((await api(fixture, '/rules')).body.error).toBeUndefined()
  await openRules(page)
  await expect(ruleRows(page)).toHaveCount(4)
  const offRow = page.locator(PANEL).locator('[data-rule-id="r-aaaa09"]')
  await expect(offRow.getByTestId('mail-rule-off')).toHaveText(RULE_OFF)
  await expect(offRow).toHaveAttribute('data-enabled', 'false')
  await expect(offRow.getByTestId('mail-rule-toggle')).toBeDisabled()
  await expect(offRow.getByTestId('mail-rule-toggle-wrap')).toHaveAttribute('title', RULE_OFF)
  await expect(page.locator(PANEL).getByTestId('mail-rule-off')).toHaveCount(1)
  await expect(page.getByTestId('mail-rules-file-error')).toHaveCount(0)
  await shoot(page, SHOTS, 'c67-off-rule')
  // Saving another rule writes the whole file: the off rule's pattern is kept as written.
  await ruleRows(page).first().getByTestId('mail-rule-edit').click()
  const editor = page.getByTestId('mail-rule-editor')
  await editor.getByTestId('mail-rule-note').fill('kept beside an off rule')
  await editor.getByTestId('mail-rule-save').click()
  await expect(editor).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(async () => (await fileDoc())?.rules?.[0]?.note, { timeout: 10_000 }).toBe('kept beside an off rule')
  const doc = await fileDoc()
  expect(doc?.rules?.[3]?.when?.subject?.re).toBe(big)
  expect(JSON.stringify(doc)).not.toContain('offReason')
  await expect(offRow.getByTestId('mail-rule-off')).toHaveText(RULE_OFF)
  // Edit the off rule's own note: its pattern is kept as written, never judged as new, never previewed.
  // Said once, calmly, in the editor under the pattern; the row's own line waits until it closes.
  const previews: string[] = []
  page.on('request', (request) => { if (request.url().includes('/rules/preview')) previews.push(request.postData() ?? '') })
  await offRow.getByTestId('mail-rule-edit').click()
  const offEditor = page.getByTestId('mail-rule-editor')
  await expect(offEditor.getByTestId('mail-rule-field-off')).toHaveText(RULE_OFF_HELD)
  await expect(offEditor.getByTestId('mail-rule-field-error')).toHaveCount(0)
  await expect(offRow.getByTestId('mail-rule-off')).toHaveCount(0)
  await expect(page.locator(PANEL).getByText('Use smaller numbers in {n,m}.')).toHaveCount(1)
  await offEditor.getByTestId('mail-rule-note').fill('kept although off')
  await expect(offEditor.getByTestId('mail-rule-save')).toBeEnabled()
  await shoot(page, SHOTS, 'c67-off-rule-edit')
  await offEditor.getByTestId('mail-rule-save').click()
  await expect(offEditor).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(async () => (await fileDoc())?.rules?.[3]?.note, { timeout: 10_000 }).toBe('kept although off')
  expect((await fileDoc())?.rules?.[3]?.when?.subject?.re).toBe(big)
  await expect(offRow.getByTestId('mail-rule-off')).toHaveText(RULE_OFF)
  expect(previews.some((one) => one.includes('y{1,90}'))).toBe(false)
  // Its pattern changed into another too-big one is refused like any typed pattern, in red.
  await offRow.getByTestId('mail-rule-edit').click()
  const value = offEditor.getByTestId('mail-rule-value')
  await value.fill('(?:x{1,90}y{1,90}){41}')
  await expect(offEditor.getByTestId('mail-rule-field-error')).toHaveText(TOO_BIG)
  await expect(offEditor.getByTestId('mail-rule-field-off')).toHaveCount(0)
  await expect(offEditor.getByTestId('mail-rule-save')).toBeDisabled()
  // Made light, it saves, and the rule is on again with no off line.
  await value.fill('x{1,3}y')
  await expect(offEditor.getByTestId('mail-rule-field-error')).toHaveCount(0)
  await expect(offEditor.getByTestId('mail-rule-preview')).toHaveText(/^Matches (at least )?\d[\d,]* mails?/, { timeout: 5_000 })
  await expect(offEditor.getByTestId('mail-rule-save')).toBeEnabled()
  await offEditor.getByTestId('mail-rule-save').click()
  await expect(offEditor).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(async () => (await fileDoc())?.rules?.[3]?.when?.subject?.re, { timeout: 10_000 }).toBe('x{1,3}y')
  expect((await fileDoc())?.rules?.[3]?.note).toBe('kept although off')
  await expect(offRow).toHaveAttribute('data-enabled', 'true')
  await expect(offRow.getByTestId('mail-rule-off')).toHaveCount(0)
  await expect(offRow.getByTestId('mail-rule-toggle')).toBeEnabled()
  await expect(offRow.getByTestId('mail-rule-toggle')).toBeChecked()
  await writeRulesFile(fixture, THREE_RULES)
  await waitRulesCount(3)
})

test('C93: a changed condition drops the old count at once; only the answer for the current input shows', async ({ page }) => {
  await openRules(page)
  await page.getByTestId('mail-rules-add').click()
  const editor = page.getByTestId('mail-rule-editor')
  const preview = editor.getByTestId('mail-rule-preview')
  const value = editor.getByTestId('mail-rule-value').first()
  await value.fill('issues@*')
  await expect(preview).toHaveText(/^Matches [1-9][\d,]* mails?( \u00b7 ((all )?already there|[\d,]+ would move, [\d,]+ already there))?( \u00b7 Show (it|\d+))?$/, { timeout: 5_000 })
  const answered = (await preview.textContent())!
  const height = (await preview.boundingBox())!.height
  // Every text the preview shows from here on.
  await preview.evaluate((node) => {
    const seen: string[] = []
    ;(window as unknown as { __previewSeen: string[] }).__previewSeen = seen
    new MutationObserver(() => seen.push(node.textContent ?? '')).observe(node, { subtree: true, childList: true, characterData: true })
  })
  const seen = () => page.evaluate(() => (window as unknown as { __previewSeen: string[] }).__previewSeen.slice())
  // Hold the answer for a sender nobody is, so the count it replaces could only show if it were kept.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held = 0
  const isPreview = (url: URL) => url.pathname.endsWith('/rules/preview')
  await page.route(isPreview, async (route) => {
    if ((route.request().postData() ?? '').includes('nobody-sends-this')) { held += 1; await gate }
    await route.continue().catch(() => {})
  })
  await value.fill('nobody-sends-this@*')
  expect(await preview.textContent()).toBe('Checking\u2026')
  await expect.poll(() => held, { timeout: 5_000 }).toBe(1)
  await page.waitForTimeout(800)
  // Past the pause the pattern is judged; its count is still on its way.
  await expect(preview).toHaveText('Counting mails\u2026')
  expect((await preview.boundingBox())!.height).toBe(height)
  expect((await seen()).some((text) => text.startsWith('Matches'))).toBe(false)
  // Changed again while that answer is held: the new input's answer shows, and the late one never does.
  await value.fill('issues@*')
  await expect(preview).toHaveText(answered, { timeout: 5_000 })
  release()
  await page.waitForTimeout(1_000)
  await expect(preview).toHaveText(answered)
  expect((await seen()).filter((text) => text.startsWith('Matches')).every((text) => text === answered)).toBe(true)
  // Asked again, the sender nobody is gets its own answer.
  await value.fill('nobody-sends-this@*')
  await expect(preview).toHaveText(/^Matches 0 mails$/, { timeout: 5_000 })
  await page.unroute(isPreview)
  await editor.getByTestId('mail-rule-cancel').click()
})

test('C94: text is kept as typed, an edited rule keeps its id, a stored pattern Walnut will not run loads off, hints, Enter saves', async ({ page }) => {
  await writeRulesFile(fixture, [
    'version: 1', 'groups: []', 'rules:',
    '  - id: r-old001', '    when: { subject: { re: "^re: " } }', '    then: Important', '    source: user',
    '  - id: r-old002', '    when: { subject: { re: "(unclosed" } }', '    then: Important', '    source: user', '    note: "hand written"',
    '  - id: r-old003', '    when: { subject: { re: "(?=.{0,500}invoice)(?=.{0,500}paid)" } }', '    then: Not important', '    source: user', '',
  ].join('\n'))
  await waitRulesCount(3)
  expect((await api(fixture, '/rules')).body.error).toBeUndefined()
  await openRules(page)
  await expect(ruleRows(page)).toHaveCount(3)
  // A pattern Walnut will not run turns off that rule alone, saying the way back on; the rest of the file works.
  const broken = page.locator(PANEL).locator('[data-rule-id="r-old002"]')
  await expect(broken.getByTestId('mail-rule-off')).toHaveText(RULE_OFF_INVALID)
  await expect(broken.getByTestId('mail-rule-toggle')).toBeDisabled()
  await expect(broken.getByTestId('mail-rule-toggle-wrap')).toHaveAttribute('title', RULE_OFF_INVALID)
  await expect(page.getByTestId('mail-rules-file-error')).toHaveCount(0)
  await expect(page.getByTestId('mail-rules-add')).toBeEnabled()
  await expect(ruleRows(page).first().getByTestId('mail-rule-toggle')).toBeEnabled()
  // Its editor names the cause, calmly, once; Enter in the note saves, the pattern kept byte for byte.
  await broken.getByTestId('mail-rule-edit').click()
  const editor = page.getByTestId('mail-rule-editor')
  await expect(editor.getByTestId('mail-rule-field-off')).toHaveText(`This rule stays off until this pattern is fixed: ${UNCLOSED}`)
  await expect(editor.getByTestId('mail-rule-field-error')).toHaveCount(0)
  await expect(broken.getByTestId('mail-rule-off')).toHaveCount(0)
  await shoot(page.locator(PANEL).locator('.mail-rules-rules'), SHOTS, 'c94-invalid-off-editing')
  await editor.getByTestId('mail-rule-note').fill('still hand written')
  await editor.getByTestId('mail-rule-note').press('Enter')
  await expect(editor).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(async () => (await fileDoc())?.rules?.[1]?.note, { timeout: 10_000 }).toBe('still hand written')
  expect((await fileDoc())?.rules?.[1]).toMatchObject({ id: 'r-old002', when: { subject: { re: '(unclosed' } } })
  await expect(broken.getByTestId('mail-rule-off')).toHaveText(RULE_OFF_INVALID)
  // A note-only edit of `^re: ` keeps its trailing space, and its hand-written id.
  const reply = page.locator(PANEL).locator('[data-rule-id="r-old001"]')
  await reply.getByTestId('mail-rule-edit').click()
  await editor.getByTestId('mail-rule-note').fill('replies')
  await editor.getByTestId('mail-rule-save').click()
  await expect(editor).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(async () => (await fileDoc())?.rules?.[0]?.note, { timeout: 10_000 }).toBe('replies')
  expect((await fileDoc())?.rules?.[0]).toMatchObject({ id: 'r-old001', when: { subject: { re: '^re: ' } } })
  // A pattern in a summary is code, without the slashes the editor asks people to leave out.
  const long = page.locator(PANEL).locator('[data-rule-id="r-old003"]').getByTestId('mail-rule-pattern')
  await expect(long).toHaveText('(?=.{0,500}invoice)(?=.{0,500}paid)')
  expect(await long.evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(/mono|menlo|courier/i)
  // A new rule, as its editor opens.
  await page.getByTestId('mail-rules-add').click()
  await shoot(editor, SHOTS, 'c94-editor-empty')
  // + Add condition starts at the editor's left edge, with the conditions.
  const leftOf = async (testId: string) => (await editor.getByTestId(testId).first().boundingBox())!.x
  expect(Math.abs((await leftOf('mail-rule-add-condition')) - (await leftOf('mail-rule-field')))).toBeLessThan(2)
  // What was typed under one text field stays when the field changes to another.
  await editor.getByTestId('mail-rule-field').click()
  await page.getByTestId('mail-rule-field-list').getByRole('option', { name: 'Subject contains' }).click()
  const value = editor.getByTestId('mail-rule-value')
  await value.fill('invoice')
  await editor.getByTestId('mail-rule-field').click()
  await page.getByTestId('mail-rule-field-list').getByRole('option', { name: 'Subject pattern' }).click()
  await expect(value).toHaveValue('invoice')
  await expect(value).toHaveAttribute('placeholder', 'invoice #\\d+')
  await expect(editor.getByTestId('mail-rule-field-help')).toHaveText(PATTERN_HELP)
  // Patterns that run but would not match as they seem meant to: a warning that blocks nothing, with
  // the one-click fix where there is one.
  for (const [typed, hint, fix] of [
    ['/invoice/i', HINT_SLASHES_FLAGS, 'invoice'], ['a{1000}', HINT_NEEDS_MORE, null], ['invoice|', HINT_EMPTY_CHOICE, 'invoice'],
  ] as const) {
    await value.fill(typed)
    const line = editor.getByTestId('mail-rule-field-hint')
    await expect(line).toContainText(hint)
    await expect(line).toHaveAttribute('data-warn', 'true')
    await expect(editor.getByTestId('mail-rule-field-error')).toHaveCount(0)
    await expect(editor.getByTestId('mail-rule-save')).toBeEnabled()
    if (typed === '/invoice/i') await shoot(editor, SHOTS, 'c94-hint')
    if (fix) {
      await line.getByTestId('mail-rule-hint-fix').click()
      await expect(value).toHaveValue(fix)
      await expect(editor.getByTestId('mail-rule-field-hint')).toHaveCount(0)
    } else {
      await expect(line.getByTestId('mail-rule-hint-fix')).toHaveCount(0)
    }
  }
  // A Unicode property runs: no hint, no error.
  await value.fill('\\p{L}+ invoice')
  await expect(editor.getByTestId('mail-rule-field-help')).toHaveText(PATTERN_HELP)
  await expect(editor.getByTestId('mail-rule-field-error')).toHaveCount(0)
  // Typed with a trailing space and saved with Enter: stored exactly as typed, at once (no wait for the pause).
  await value.fill('^fw: ')
  await value.press('Enter')
  await expect(editor).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(async () => (await fileDoc())?.rules?.[0]?.when?.subject?.re, { timeout: 10_000 }).toBe('^fw: ')
  // The saved rule leaves no draft behind, though its last keystrokes were not yet kept when Enter saved.
  await page.waitForTimeout(500)
  await page.getByTestId('mail-rules-add').click()
  await expect(editor.getByTestId('mail-rule-value')).toHaveValue('')
  await expect(editor.getByTestId('mail-rule-field')).toHaveAttribute('data-value', 'from')
  await editor.getByTestId('mail-rule-cancel').click()
  // At 700 px a long pattern wraps inside its code box, within the row.
  await page.setViewportSize({ width: 700, height: 900 })
  await expect(long).toBeVisible()
  await shoot(page.locator(PANEL).locator('.mail-rules-rules'), SHOTS, 'c94-list-700')
  const box = (await long.boundingBox())!
  const row = (await page.locator(PANEL).locator('[data-rule-id="r-old003"]').boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width + 1)
  await writeRulesFile(fixture, THREE_RULES)
  await waitRulesCount(3)
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
  await expect(ruleRows(page).first().getByTestId('mail-rule-provenance')).toHaveText('tickets are mine')
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
