/**
 * Learning from a correction (design v2), driven as a person drives it on the `PW_MAIL_GROUPS`
 * fixture: the row menu's `Important...` / `Not important...`, the reader's `Not right?`, and a group's
 * `These are important...` and `Rename group`.
 *
 * What is graded is the promise "Walnut learns only when you press Save": the card's words, that
 * Cancel and Esc write nothing (the rules file's hash), that Save writes the exact rule first with the
 * note verbatim, that Undo takes it out again, and that the rule model's draft (faked by the fixture's
 * `PW_MAIL_RULE_MODEL`) is an extra, never a wait. The labeling model (groups-labeler.mjs) always
 * answers here, so every group is one it named.
 *
 * Every API check goes to the fixture's own port (`mail-grouping-helpers.ts`), never baseURL.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  ALL_INBOXES, CHANGE_DESK, FERRY, MARINA, ROW, api, deliver, fileHash, fileRules, getGroups, groupLine,
  groupOfMessage, mailRow, openGroupLine, openGroupMenu, openGrouped, readRulesFile, startGroupsFixture,
  statusLine, waitLabeled, waitSorted, writeRulesFile,
} from './mail-grouping-helpers'
import { shoot, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

const SHOTS = '/tmp/mail-grouping/shots/v2/chromium'
const CARD = '[data-testid="mail-correct"]'
const MODEL_FAILED = "Walnut couldn't turn your note into a rule. Your note is saved with the rule you pick."
const RECIPIENTS_UNKNOWN = "Walnut can't see who this mail was sent to, so it can't learn a rule about recipients from it."
/** An unread Change Desk mail with no recipients at all (groups-set.mjs). */
const CHANGE_NO_RECIPIENTS = 'INBOX:31:304'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

async function rulesRev(fixture: MailFixture): Promise<string> {
  return (await api(fixture, '/rules')).body.rulesRev
}

/** The label of the group a message sits in now. */
async function labelOf(fixture: MailFixture, groupId: string): Promise<string> {
  if (groupId === 'important') return 'Important'
  const groups = await getGroups(fixture, ALL_INBOXES)
  return groups.groups.find((one: { id: string }) => one.id === groupId).label
}

/**
 * The row of one mail on screen: in Important it is already drawn; in a group, the group is opened and
 * all its rows shown. Returns the row and the group it is in.
 */
async function revealRow(page: Page, fixture: MailFixture, accountId: string, messageId: string): Promise<{ row: Locator; groupId: string }> {
  const groupId = await groupOfMessage(fixture, accountId, messageId)
  expect(groupId, `${messageId} is in a group`).toBeTruthy()
  if (groupId !== 'important') {
    const group = await openGroupLine(page, groupId!)
    const more = group.getByTestId('mail-group-more-rows')
    if (await more.count()) await more.click()
  }
  const row = mailRow(page, accountId, messageId)
  await expect(row).toBeVisible({ timeout: 20_000 })
  return { row, groupId: groupId! }
}

/** The correction card on one mail, from its row menu (`Important...` or `Not important...`). */
async function openCard(page: Page, fixture: MailFixture, accountId: string, messageId: string): Promise<{ card: Locator; groupId: string; row: Locator }> {
  const { row, groupId } = await revealRow(page, fixture, accountId, messageId)
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: groupId === 'important' ? 'Not important\u2026' : 'Important\u2026' }).click()
  const card = page.locator(CARD)
  await expect(card).toBeVisible()
  return { card, groupId, row }
}

async function pick(card: Locator, groupId: string): Promise<void> {
  await card.locator(`[data-testid="mail-correct-choice"][data-group-id="${groupId}"]`).check()
}

async function toStep2(card: Locator, note: string): Promise<void> {
  if (note) await card.getByTestId('mail-correct-why').fill(note)
  await card.getByTestId('mail-correct-next').click()
  await expect(card.locator('[data-step="rule"]')).toBeVisible()
  await expect(card.getByTestId('mail-correct-rule').first()).toBeVisible({ timeout: 10_000 })
}

test.describe('rule model down (the default)', () => {
  let server: MailFixtureServer
  let fixture: MailFixture
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    ;({ server, fixture } = await startGroupsFixture({ ruleModel: 'down' }))
    await waitLabeled(fixture, ALL_INBOXES, 120_000)
  })
  test.afterAll(async () => { await server?.stop() })

  test('step 1 and 2 say the words, Important is picked from the menu, and Esc after step 2 writes nothing', async ({ page }) => {
    await openGrouped(page, fixture)
    const before = { hash: await fileHash(fixture), rev: await rulesRev(fixture) }
    const { card, groupId, row } = await openCard(page, fixture, MARINA, ROW.review)
    const label = await labelOf(fixture, groupId)
    await expect(card).toHaveAttribute('aria-label', 'Where should this mail go?')
    await expect(card.locator('.mail-correct-title')).toHaveText(`This mail is in ${label}. Where should it go?`)
    const labels = await card.locator('.mail-correct-choice-label').allTextContents()
    expect(labels[0]).toBe('Important')
    expect(labels).toContain(`Keep in ${label}`)
    expect(labels).not.toContain('Not important')
    expect(labels.at(-1)).toBe('New group\u2026')
    // The menu said Important..., so Important is already picked and Next is ready.
    await expect(card.locator('[data-testid="mail-correct-choice"][data-group-id="important"]')).toBeChecked()
    await expect(card.getByTestId('mail-correct-next')).toBeEnabled()
    await expect(card.getByText('Why? (optional, helps Walnut learn)')).toBeVisible()
    // A new group with a taken name is refused and keeps Next disabled.
    await pick(card, 'new')
    await card.getByLabel('New group name').fill(label.toLowerCase())
    await expect(card.getByTestId('mail-correct-new-group-error')).toHaveText('That group already exists.')
    await expect(card.getByTestId('mail-correct-next')).toBeDisabled()
    await card.getByLabel('New group name').fill('important')
    await expect(card.getByTestId('mail-correct-new-group-error')).toBeVisible()
    // The counter shows only past 250 characters.
    await card.getByTestId('mail-correct-why').fill('x'.repeat(250))
    await expect(card.getByTestId('mail-correct-counter')).toHaveCount(0)
    await card.getByTestId('mail-correct-why').fill('x'.repeat(251))
    await expect(card.getByTestId('mail-correct-counter')).toHaveText('251 / 300')
    await pick(card, 'important')
    await toStep2(card, 'sent to me directly')
    await expect(card.locator('.mail-correct-title')).toHaveText('Save this as a rule?')
    await expect(card.getByTestId('mail-correct-model-failed')).toHaveText(MODEL_FAILED, { timeout: 20_000 })
    await shoot(card, SHOTS, 'learn-step2')
    await page.keyboard.press('Escape')
    await expect(page.locator(CARD)).toHaveCount(0)
    await expect(row).toBeFocused()
    expect(await fileHash(fixture)).toBe(before.hash)
    expect(await rulesRev(fixture)).toBe(before.rev)
  })

  test('Save rule writes the rule first with the note verbatim, moves the mail to Important, Undo removes it', async ({ page }) => {
    await openGrouped(page, fixture)
    const note = 'Reviews need me: "sent to me", not the pager'
    const { card, groupId } = await openCard(page, fixture, MARINA, ROW.review)
    await toStep2(card, note)
    await expect(card.locator('[data-testid="mail-correct-rule"]:checked')).toHaveCount(1)
    await expect(card.getByTestId('mail-correct-model-failed')).toHaveText(MODEL_FAILED, { timeout: 20_000 })
    await card.getByTestId('mail-correct-save').click()
    await expect(page.locator(CARD)).toHaveCount(0)
    const status = statusLine(page, /^Saved\. \d+ mails? moved to Important\./)
    await expect(status).toBeVisible()
    const rules = await fileRules(fixture)
    expect(rules[0]).toMatchObject({ then: 'Important', source: 'learned', note })
    expect(rules[0].created).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(rules[0].id).toMatch(/^r-[0-9a-f]{6}$/)
    await waitSorted(fixture)
    expect(await groupOfMessage(fixture, MARINA, ROW.review)).toBe('important')
    await expect(page.locator(`.mail-important [data-testid="mail-row"][data-message-id="${ROW.review}"]`)).toBeVisible({ timeout: 10_000 })
    await shoot(page, SHOTS, 'learn-saved')
    await status.getByTestId('mail-rule-undo').click()
    await expect.poll(async () => (await fileRules(fixture)).some((one) => one.id === rules[0].id)).toBe(false)
    await waitSorted(fixture)
    await expect.poll(() => groupOfMessage(fixture, MARINA, ROW.review), { timeout: 20_000 }).toBe(groupId)
  })

  test('Not important... on an Important mail picks Not important and keeps the model\'s group for it', async ({ page }) => {
    await openGrouped(page, fixture)
    const { card, groupId } = await openCard(page, fixture, MARINA, ROW.direct)
    expect(groupId).toBe('important')
    await expect(card.locator('.mail-correct-title')).toHaveText('This mail is in Important. Where should it go?')
    await expect(card.locator('[data-testid="mail-correct-choice"][data-group-id="not-important"]')).toBeChecked()
    await toStep2(card, 'lunch plans can wait')
    await card.getByTestId('mail-correct-save').click()
    await expect(page.locator(CARD)).toHaveCount(0)
    const status = statusLine(page, /^Saved\. .*moved out of Important\./)
    await expect(status).toBeVisible()
    const rules = await fileRules(fixture)
    expect(rules[0]).toMatchObject({ then: 'Not important', source: 'learned', note: 'lunch plans can wait' })
    await waitSorted(fixture)
    await expect.poll(() => groupOfMessage(fixture, MARINA, ROW.direct), { timeout: 20_000 }).not.toBe('important')
    await status.getByTestId('mail-rule-undo').click()
    await expect.poll(async () => (await fileRules(fixture)).length).toBe(rules.length - 1)
    await waitSorted(fixture)
    await expect.poll(() => groupOfMessage(fixture, MARINA, ROW.direct), { timeout: 20_000 }).toBe('important')
  })

  test('the reader\'s Not right? opens the same card on the open mail', async ({ page }) => {
    await openGrouped(page, fixture)
    const { row, groupId } = await revealRow(page, fixture, MARINA, ROW.oncall)
    const label = await labelOf(fixture, groupId)
    await row.click()
    const line = page.getByTestId('mail-reader-sort')
    await expect(line).toContainText(`In ${label}`)
    await line.getByTestId('mail-reader-sort-fix').click()
    const card = page.locator(CARD)
    await expect(card).toBeVisible()
    await expect(card.locator('.mail-correct-title')).toHaveText(`This mail is in ${label}. Where should it go?`)
    await shoot(page, SHOTS, 'reader-not-right')
    await card.getByTestId('mail-correct-cancel').click()
    await expect(card).toHaveCount(0)
    await expect(line.getByTestId('mail-reader-sort-fix')).toBeFocused()
  })

  test('a Change Desk mail sent to me offers the direct draft first, with the server coverage line', async ({ page }) => {
    await openGrouped(page, fixture)
    const proposal = (await api(fixture, '/rules/propose', {
      body: { accountId: FERRY, messageId: ROW.changeDirect, target: 'Important', scope: ALL_INBOXES, model: false },
    })).body
    const { card } = await openCard(page, fixture, FERRY, ROW.changeDirect)
    await toStep2(card, '')
    const kinds = await card.getByTestId('mail-correct-rule').evaluateAll((nodes) => nodes.map((one) => one.getAttribute('data-kind')))
    expect(kinds.indexOf('sender-direct')).toBeGreaterThanOrEqual(0)
    expect(kinds.indexOf('sender-direct')).toBeLessThan(kinds.indexOf('sender-subject'))
    const { known, of } = proposal.recipients
    await expect(card.getByTestId('mail-correct-recipients'))
      .toHaveText(`Walnut knows the recipients of ${known} of ${of} mails from this sender.`)
    const direct = card.locator('[data-testid="mail-correct-option"][data-kind="sender-direct"]')
    await direct.getByTestId('mail-correct-rule').check()
    await card.getByTestId('mail-correct-save').click()
    await expect(page.locator(CARD)).toHaveCount(0)
    const rules = await fileRules(fixture)
    expect(rules[0].when).toMatchObject({ from: CHANGE_DESK, addressedToMe: true, account: FERRY })
    await statusLine(page, /^Saved\./).getByTestId('mail-rule-undo').click()
    await expect.poll(async () => (await fileRules(fixture)).length).toBe(rules.length - 1)
    await waitSorted(fixture)
  })

  test('a Change Desk mail with no recipients offers no recipient drafts and says why', async ({ page }) => {
    await openGrouped(page, fixture)
    const { card } = await openCard(page, fixture, FERRY, CHANGE_NO_RECIPIENTS)
    await toStep2(card, '')
    await expect(card.locator('[data-kind="sender-direct"], [data-kind="sender-not-direct"]')).toHaveCount(0)
    await expect(card.getByTestId('mail-correct-recipients')).toHaveText(RECIPIENTS_UNKNOWN)
    await page.keyboard.press('Escape')
    await expect(page.locator(CARD)).toHaveCount(0)
  })

  test('a rule saved into a New group, then undone, leaves no empty group behind', async ({ page }) => {
    await openGrouped(page, fixture)
    const { card } = await openCard(page, fixture, MARINA, ROW.review)
    await pick(card, 'new')
    await card.getByLabel('New group name').fill('Harbour desk')
    await expect(card.getByTestId('mail-correct-next')).toBeEnabled()
    await toStep2(card, '')
    await card.getByTestId('mail-correct-save').click()
    await expect(page.locator(CARD)).toHaveCount(0)
    await expect.poll(async () => (await readRulesFile(fixture)) ?? '').toContain('Harbour desk')
    const yaml = await import('js-yaml')
    const saved = yaml.load((await readRulesFile(fixture))!) as { groups: string[]; rules: any[] }
    expect(saved.groups).toContain('Harbour desk')
    expect(saved.rules[0].then).toBe('Harbour desk')
    await waitSorted(fixture)
    await expect(groupLine(page, 'u:harbour-desk')).toBeVisible({ timeout: 20_000 })
    await statusLine(page, /^Saved\./).getByTestId('mail-rule-undo').click()
    await expect.poll(async () => {
      const doc = yaml.load((await readRulesFile(fixture)) ?? '') as { groups?: string[] } | null
      return doc?.groups ?? []
    }).not.toContain('Harbour desk')
    const groups = await waitSorted(fixture)
    expect(groups.groups.some((one: any) => one.label === 'Harbour desk')).toBe(false)
    await expect(groupLine(page, 'u:harbour-desk')).toHaveCount(0, { timeout: 20_000 })
  })

  test('a correction that would override an earlier rule says so, and Keep my earlier rule first saves under it', async ({ page }) => {
    await writeRulesFile(fixture, [
      'version: 1', 'groups: []', 'rules:',
      '  - id: r-0ea71e',
      `    when: { from: "${CHANGE_DESK}", subject: "Action Required", account: "${FERRY}" }`,
      '    then: Important', '    source: learned', '    created: 2026-09-27', '',
    ].join('\n'))
    await expect.poll(async () => (await api(fixture, '/rules')).body.rules?.[0]?.id, { timeout: 15_000 }).toBe('r-0ea71e')
    await waitSorted(fixture)
    await openGrouped(page, fixture)
    const proposal = (await api(fixture, '/rules/propose', {
      body: { accountId: FERRY, messageId: ROW.changeAlias, target: 'Not important', scope: ALL_INBOXES, model: false },
    })).body
    const sender = proposal.drafts.find((one: any) => one.kind === 'sender')
    expect(sender.shadows[0]).toMatchObject({ ruleId: 'r-0ea71e' })
    const { card, groupId } = await openCard(page, fixture, FERRY, ROW.changeAlias)
    expect(groupId).toBe('important')
    await toStep2(card, '')
    const option = card.locator('[data-testid="mail-correct-option"][data-kind="sender"]')
    await expect(option.getByTestId('mail-correct-shadow'))
      .toContainText(`This overrides your rule "${sender.shadows[0].summary}" for ${sender.shadows[0].mails} mail`)
    await option.getByTestId('mail-correct-keep-earlier').click()
    await expect(option.getByTestId('mail-correct-shadow')).toHaveText('Your earlier rule stays first.')
    await option.getByTestId('mail-correct-rule').check()
    await card.getByTestId('mail-correct-save').click()
    await expect(page.locator(CARD)).toHaveCount(0)
    const rules = await fileRules(fixture)
    expect(rules[0].id).toBe('r-0ea71e')
    expect(rules[1]).toMatchObject({ then: 'Not important', source: 'learned' })
    await waitSorted(fixture)
    expect(await groupOfMessage(fixture, FERRY, ROW.changeAlias)).toBe('important')
    await writeRulesFile(fixture, 'version: 1\ngroups: []\nrules: []\n')
    await expect.poll(async () => (await api(fixture, '/rules')).body.rules.length, { timeout: 15_000 }).toBe(0)
    await waitSorted(fixture)
  })

  test('These are important... saves a group rule with the note, moves the group to Important, Undo brings it back', async ({ page }) => {
    await openGrouped(page, fixture)
    const groups = await getGroups(fixture, ALL_INBOXES)
    const pager = groups.groups.find((one: { label: string }) => one.label === 'Pager alerts')
    expect(pager).toBeTruthy()
    const hash = await fileHash(fixture)
    const menu = await openGroupMenu(page, pager.id)
    await menu.getByRole('menuitem', { name: 'These are important\u2026' }).click()
    const card = page.getByTestId('mail-group-important-card')
    await expect(card).toBeVisible()
    await expect(card.locator('.mail-correct-title')).toHaveText('Treat Pager alerts as important?')
    await expect(card).toContainText('Mail Walnut groups as Pager alerts goes to Important from now on.')
    // Cancel writes nothing.
    await card.getByTestId('mail-group-card-cancel').click()
    await expect(card).toHaveCount(0)
    expect(await fileHash(fixture)).toBe(hash)
    await (await openGroupMenu(page, pager.id)).getByRole('menuitem', { name: 'These are important\u2026' }).click()
    const note = 'pages at night are mine to answer'
    await page.getByTestId('mail-group-card-why').fill(note)
    await shoot(page.getByTestId('mail-group-important-card'), SHOTS, 'group-important-card')
    await page.getByTestId('mail-group-card-save').click()
    await expect(page.getByTestId('mail-group-important-card')).toHaveCount(0)
    const status = statusLine(page, /^Saved\. Mail in Pager alerts now goes to Important\./)
    await expect(status).toBeVisible()
    const rules = await fileRules(fixture)
    expect(rules[0]).toMatchObject({ when: { group: 'Pager alerts' }, then: 'Important', source: 'learned', note })
    await waitSorted(fixture)
    await expect(groupLine(page, pager.id)).toHaveCount(0, { timeout: 20_000 })
    const important = (await api(fixture, '/messages?scope=role:inbox&group=important&limit=200')).body.messages
    expect(important.some((one: { messageId: string }) => one.messageId === ROW.oncall)).toBe(true)
    await status.getByTestId('mail-rule-undo').click()
    await expect.poll(async () => (await fileRules(fixture)).some((one) => one.id === rules[0].id)).toBe(false)
    await waitSorted(fixture)
    await expect(groupLine(page, pager.id)).toHaveAttribute('data-unread', String(pager.unread), { timeout: 20_000 })
  })

  test('Rename group changes the name everywhere, refuses a taken one, and new mail keeps the new name', async ({ page }) => {
    await openGrouped(page, fixture, MARINA)
    const groups = await getGroups(fixture, { accountId: MARINA, mailboxId: 'INBOX' })
    const builds = groups.groups.find((one: { label: string }) => one.label === 'Build results')
    const other = groups.groups.find((one: { label: string; id: string }) => one.id !== builds.id && one.id.startsWith('u:'))
    const hash = await fileHash(fixture)
    await (await openGroupMenu(page, builds.id)).getByRole('menuitem', { name: 'Rename group' }).click()
    const card = page.getByTestId('mail-group-rename-card')
    const field = card.getByTestId('mail-group-card-name')
    await expect(field).toHaveValue('Build results')
    await expect(card.getByTestId('mail-group-card-save')).toBeDisabled()
    // A name another group has is refused by the server, in words.
    await field.fill(other.label.toUpperCase())
    await card.getByTestId('mail-group-card-save').click()
    await expect(card.getByTestId('mail-group-card-error')).toHaveText(`Another group is already called ${other.label}.`)
    await field.fill('CI runs')
    await card.getByTestId('mail-group-card-save').click()
    await expect(card).toHaveCount(0)
    await expect(statusLine(page, /^Renamed to CI runs\./)).toBeVisible()
    await expect(groupLine(page, builds.id).getByTestId('mail-group-name')).toHaveText('CI runs')
    const after = await getGroups(fixture, { accountId: MARINA, mailboxId: 'INBOX' })
    expect(after.groups.find((one: { id: string }) => one.id === builds.id)).toMatchObject({ label: 'CI runs', renamed: true })
    // A rename is not a rule: the rules file is untouched.
    expect(await fileHash(fixture)).toBe(hash)
    // The next build mail the model sorts lands in the same group under the new name.
    const made = (await deliver(fixture, 1, { account: 'marina' })).delivered[0]!
    await waitLabeled(fixture, ALL_INBOXES)
    await expect.poll(() => groupOfMessage(fixture, MARINA, made.messageId), { timeout: 30_000 }).toBe(builds.id)
    await expect(groupLine(page, builds.id)).toHaveAttribute('data-unread', String(builds.unread + 1), { timeout: 20_000 })
  })
})

test.describe('rule model canned', () => {
  let server: MailFixtureServer
  let fixture: MailFixture
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    ;({ server, fixture } = await startGroupsFixture({ ruleModel: 'canned' }))
    await waitLabeled(fixture, ALL_INBOXES, 120_000)
  })
  test.afterAll(async () => { await server?.stop() })

  test('the note becomes a "from your note" draft whose count is the preview count', async ({ page }) => {
    await openGrouped(page, fixture)
    const note = 'sent to a group alias'
    const answer = (await api(fixture, '/rules/propose', {
      body: { accountId: FERRY, messageId: ROW.changeAlias, target: 'Not important', note, scope: ALL_INBOXES },
    })).body
    expect(answer.model.status).toBe('ok')
    expect(answer.model.draft.when.addressedToMe).toBe(false)
    const preview = (await api(fixture, '/rules/preview', {
      body: { scope: ALL_INBOXES, when: answer.model.draft.when, then: answer.model.draft.then },
    })).body
    const { card, groupId } = await openCard(page, fixture, FERRY, ROW.changeAlias)
    if (groupId === 'important') await expect(card.locator('[data-testid="mail-correct-choice"][data-group-id="not-important"]')).toBeChecked()
    else await pick(card, 'important')
    await toStep2(card, note)
    const model = card.locator('[data-testid="mail-correct-option"][data-kind="model"]')
    await expect(model).toBeVisible({ timeout: 20_000 })
    await expect(model.getByTestId('mail-correct-from-note')).toHaveText('from your note')
    if (groupId === 'important') await expect(model.getByTestId('mail-correct-matches')).toContainText(`Matches ${preview.matches.toLocaleString('en-US')} mail`)
    await shoot(card, SHOTS, 'learn-from-note')
    await model.getByTestId('mail-correct-rule').check()
    await card.getByTestId('mail-correct-save').click()
    await expect(page.locator(CARD)).toHaveCount(0)
    const rules = await fileRules(fixture)
    expect(rules[0]).toMatchObject({ source: 'learned', note })
    expect(rules[0].when.addressedToMe).toBe(false)
    await statusLine(page, /^Saved\./).getByTestId('mail-rule-undo').click()
    await expect.poll(async () => (await fileRules(fixture)).length).toBe(rules.length - 1)
    await waitSorted(fixture)
  })

  test('a model rule about recipients on a mail with no recipients is dropped with the recipients sentence', async ({ page }) => {
    await openGrouped(page, fixture)
    const { card } = await openCard(page, fixture, FERRY, CHANGE_NO_RECIPIENTS)
    await toStep2(card, 'sent to a group alias')
    await expect(card.getByTestId('mail-correct-model-failed')).toHaveText(RECIPIENTS_UNKNOWN, { timeout: 20_000 })
    await expect(card.locator('[data-kind="model"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })
})

test.describe('rule model invalid', () => {
  let server: MailFixtureServer
  let fixture: MailFixture
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    ;({ server, fixture } = await startGroupsFixture({ ruleModel: 'invalid' }))
    await waitLabeled(fixture, ALL_INBOXES, 120_000)
  })
  test.afterAll(async () => { await server?.stop() })

  test('invalid model output keeps the local drafts, says so, and the note is still saved', async ({ page }) => {
    await openGrouped(page, fixture)
    const { card } = await openCard(page, fixture, MARINA, ROW.review)
    await toStep2(card, 'these need my answer')
    await expect(card.getByTestId('mail-correct-model-failed')).toHaveText(MODEL_FAILED, { timeout: 20_000 })
    await card.getByTestId('mail-correct-save').click()
    await expect(page.locator(CARD)).toHaveCount(0)
    expect((await fileRules(fixture))[0]).toMatchObject({ note: 'these need my answer', source: 'learned' })
  })
})

test.describe('rule model slow', () => {
  let server: MailFixtureServer
  let fixture: MailFixture
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    ;({ server, fixture } = await startGroupsFixture({ ruleModel: 'slow' }))
    await waitLabeled(fixture, ALL_INBOXES, 120_000)
  })
  test.afterAll(async () => { await server?.stop() })

  test('local drafts are clickable within a second, the radios never move, and a touch is kept', async ({ page }) => {
    await openGrouped(page, fixture)
    const { card } = await openCard(page, fixture, MARINA, ROW.review)
    await card.getByTestId('mail-correct-why').fill('reviews are mine to answer')
    const started = Date.now()
    await card.getByTestId('mail-correct-next').click()
    const second = card.getByTestId('mail-correct-rule').nth(1)
    await expect(second).toBeEnabled({ timeout: 5_000 })
    const elapsed = Date.now() - started
    expect(elapsed, `local drafts took ${elapsed} ms`).toBeLessThan(1_000)
    await expect(card.getByTestId('mail-correct-model-wait')).toHaveText('Reading your note\u2026')
    const yWaiting = (await second.boundingBox())!.y
    await second.check()
    await expect(card.getByTestId('mail-correct-model-failed')).toHaveText(MODEL_FAILED, { timeout: 25_000 })
    const yFailed = (await second.boundingBox())!.y
    expect(yFailed).toBe(yWaiting)
    await expect(second).toBeChecked()
    await card.getByTestId('mail-correct-save').click()
    await expect(page.locator(CARD)).toHaveCount(0)
    expect((await fileRules(fixture))[0]).toMatchObject({ note: 'reviews are mine to answer' })
  })
})
