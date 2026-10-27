/**
 * Every input box keeps what was typed and not sent (2026-10-27, the user: a reply
 * typed into the Ask here card was gone after they went to chat elsewhere and came
 * back; "all the input boxes must save permanently").
 *
 * Covers, through the real UI: the Ask here card's follow-up reply survives
 * closing the card, a reload, and a fresh browser (the server's copy, how the Mac
 * app and Chrome share a draft); a send clears the draft everywhere. A new Ask with words
 * comes back after a reload as a draft row. The inbox letter's reply and the note
 * with a choice survive a reload, and the reply clears once it is sent. A
 * new-session draft column comes back after a reload with its words, also beside
 * a session the URL names. The quick
 * task composer keeps its sentence after Esc and a reload.
 *
 * Chromium and WebKit (PW_WEBKIT=1).
 */
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, resetThreadsFixture, selectPassage, unfoldQuestions } from './threads-helpers'
import { TAGGED_PASSAGE, TAGGED_READY, TAGGED_SESSION, TAGGED_TASK, TAGGED_TITLES } from './threads-fixture'
import { discoverBrowserFixture } from './codex-test-audit'
import { draftPanel, openDraft } from './draft-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const NONCE = Date.now().toString(36)
// Unicode rides every draft (CJK and an emoji), so the store round-trips it as typed.
const UNI = '\u4f60\u597d \u{1F600}'

type DraftMap = Record<string, { v: string | null; ts: number }>

// The fixture's draft mirror serves only browsers that ask for it (src/web/routes/drafts.ts),
// so this spec's drafts never reach another spec's boxes.
const MIRROR = { 'x-walnut-drafts-mirror': '1' }
test.use({ extraHTTPHeaders: MIRROR })

async function serverDrafts(request: APIRequestContext): Promise<DraftMap> {
  const res = await request.get('/api/drafts')
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { drafts: DraftMap }).drafts
}

/** Tombstone this spec's leftovers from an earlier run, so no test starts on old words. */
async function forgetDrafts(request: APIRequestContext, match: (key: string) => boolean): Promise<void> {
  const drafts = await serverDrafts(request)
  const gone: DraftMap = {}
  for (const [k, e] of Object.entries(drafts)) if (e.v !== null && match(k)) gone[k] = { v: null, ts: Date.now() }
  if (Object.keys(gone).length) expect((await request.put('/api/drafts', { data: { drafts: gone } })).ok()).toBe(true)
}

/** The server holds `text` under some key matching `match` (the mirror writes within a second). */
async function expectServerDraft(request: APIRequestContext, match: (key: string) => boolean, text: string): Promise<string> {
  let found = ''
  await expect.poll(async () => {
    const hit = Object.entries(await serverDrafts(request)).find(([k, e]) => match(k) && e.v === text)
    found = hit?.[0] ?? ''
    return found
  }, { timeout: 15_000 }).not.toBe('')
  return found
}

/** The server's copy of one key, once its text contains `part`. */
async function expectServerHolds(request: APIRequestContext, key: string, part: string): Promise<void> {
  await expect.poll(async () => (await serverDrafts(request))[key]?.v ?? '', { timeout: 15_000 }).toContain(part)
}

async function shot(page: Page, name: string, el?: Locator): Promise<void> {
  const dir = `${process.env.DRAFTS_SHOT_DIR ?? '/tmp/drafts-kept'}/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  if (el) await el.screenshot({ path: `${dir}/${name}.png` })
  else await page.screenshot({ path: `${dir}/${name}.png` })
}

async function openTagged(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  return openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
}

const card = (panel: Locator) => panel.locator('.thread-card')
const q1Row = (panel: Locator) => panel.locator('.thread-map .thread-map-row[data-kind="thread"]').nth(0)

/** A second browser with nothing in its storage: what it shows came from the server. */
async function freshBrowser(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL as string, extraHTTPHeaders: MIRROR })
  return ctx.newPage()
}

test.describe('Every input box keeps its unsent draft', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  // A later run of this spec starts on no words of this one.
  test.afterAll(async ({ request }) => {
    const drafts = await serverDrafts(request)
    const gone: DraftMap = {}
    for (const [k, e] of Object.entries(drafts)) {
      if (e.v !== null && (e.v.includes(NONCE) || k === `draft:ask-pages:${TAGGED_SESSION}`)) gone[k] = { v: null, ts: Date.now() }
    }
    if (Object.keys(gone).length) await request.put('/api/drafts', { data: { drafts: gone } })
  })

  test('the Ask here card keeps a follow-up reply through close, reload and another browser; a send clears it', async ({ page, request, browser }) => {
    await resetThreadsFixture(request, TAGGED_SESSION)
    await forgetDrafts(request, (k) => k.includes(TAGGED_SESSION))
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const words = `half a reply ${NONCE} ${UNI}`

    let panel = await openTagged(page)
    await q1Row(panel).click()
    let input = card(panel).locator('.thread-card-input')
    await expect(input).toHaveAttribute('placeholder', new RegExp(`Reply in .${TAGGED_TITLES.Q1.slice(0, 10)}`))
    await input.fill(words)
    await shot(page, '01-typed', card(panel))

    // Close the card (Esc) and open it again: the words are there.
    await input.press('Escape')
    await expect(card(panel)).toHaveCount(0)
    await q1Row(panel).click()
    await expect(card(panel).locator('.thread-card-input')).toHaveValue(words)

    // Gone elsewhere and back after a reload: still there.
    const key = await expectServerDraft(request, (k) => k.startsWith(`draft:session:${TAGGED_SESSION}:`), words)
    await page.reload()
    panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
    await q1Row(panel).click()
    input = card(panel).locator('.thread-card-input')
    await expect(input).toHaveValue(words)
    await shot(page, '02-after-reload', card(panel))

    // Another browser with empty storage (the Mac app beside Chrome): the server's copy.
    const other = await freshBrowser(browser)
    const otherPanel = await openTagged(other)
    await q1Row(otherPanel).click()
    await expect(card(otherPanel).locator('.thread-card-input')).toHaveValue(words)
    await other.context().close()

    // Sent: the box empties, the draft is gone from this browser and from the server.
    await input.press('Enter')
    await expect(card(panel).locator('.thread-card-body')).toContainText(`half a reply ${NONCE}`, { timeout: 30_000 })
    await expect(input).toHaveValue('')
    await expect.poll(async () => (await serverDrafts(request))[key]?.v ?? null, { timeout: 15_000 }).toBeNull()
    expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBeNull()
    await page.reload()
    panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
    await q1Row(panel).click()
    await expect(card(panel).locator('.thread-card-input')).toHaveValue('')
    expect(errors).toEqual([])
  })

  test('a new Ask with words comes back after a reload as a draft question', async ({ page, request }) => {
    await resetThreadsFixture(request, TAGGED_SESSION)
    await forgetDrafts(request, (k) => k.includes(TAGGED_SESSION))
    const words = `an unsent question ${NONCE}`
    let panel = await openTagged(page)
    await unfoldQuestions(panel)
    await centreInHistory(page, panel, TAGGED_PASSAGE.slice(0, 30))
    await selectPassage(page, panel, TAGGED_PASSAGE.slice(0, 30))
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    const input = card(panel).locator('.thread-card-input')
    await expect(input).toBeFocused()
    await input.fill(words)
    await expectServerDraft(request, (k) => k.startsWith(`draft:session:${TAGGED_SESSION}:`), words)
    // Which passage the Ask is about is kept beside its words.
    await expectServerHolds(request, `draft:ask-pages:${TAGGED_SESSION}`, '"pageKey"')

    // Reload without leaving the Ask: it is a draft row, and opening it shows the words.
    await page.reload()
    panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
    const draftRow = panel.locator('.thread-map .thread-map-row[data-kind="draft"]')
    await expect(draftRow).toHaveCount(1, { timeout: 15_000 })
    await draftRow.click()
    await expect(card(panel).locator('.thread-card-input')).toHaveValue(words)
    await shot(page, '03-ask-draft-back', card(panel))
  })

  test('the inbox letter reply and the note with a choice survive a reload; the reply clears once sent', async ({ page, request }) => {
    const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
    const started = await request.post('/api/sessions/quick-start', { data: { cwd: `${fixtureRoot}/projects/walnut`, message: '' } })
    expect(started.ok(), await started.text()).toBe(true)
    const { sessionId } = await started.json() as { sessionId: string }
    const subject = `PW draft letter ${NONCE}`
    const sent = await request.post('/api/v1/human-inbox', {
      data: {
        subject, type: 'action_required', html: `<p>Pick one (${NONCE}).</p>`, text: `Pick one (${NONCE}).`,
        actions: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
      },
      headers: { 'x-walnut-caller-sid': sessionId },
    })
    expect(sent.status(), await sent.text()).toBe(201)
    const { id: letterId } = await sent.json() as { id: string }

    const openReader = async () => {
      await page.getByRole('button', { name: /^Notifications/ }).click()
      const center = page.locator('.notification-panel')
      await center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
      await center.locator('.hib-row').filter({ hasText: subject }).click()
      const reader = page.locator('.hib-reader')
      await expect(reader.locator('.hib-reader-subject')).toHaveText(subject, { timeout: 15_000 })
      return reader
    }
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    let reader = await openReader()
    const reply = `a reply I will finish later ${NONCE} ${UNI}`
    const note = `only after the smoke run ${NONCE}`
    await reader.locator('.hib-composer-input').fill(reply)
    await reader.locator('.hib-freetext').fill(note)
    await expectServerDraft(request, (k) => k === `draft:letter-reply:${letterId}`, reply)
    await expectServerDraft(request, (k) => k === `draft:letter-note:${letterId}`, note)

    await page.reload()
    await page.waitForLoadState('networkidle')
    reader = await openReader()
    await expect(reader.locator('.hib-composer-input')).toHaveValue(reply)
    await expect(reader.locator('.hib-freetext')).toHaveValue(note)
    await shot(page, '04-letter-after-reload', reader)

    await reader.locator('.hib-send-btn').click()
    await expect(reader.locator('.hib-composer-input')).toHaveValue('', { timeout: 20_000 })
    await expect.poll(async () => (await serverDrafts(request))[`draft:letter-reply:${letterId}`]?.v ?? null, { timeout: 15_000 }).toBeNull()
    // The note is kept: it goes with a choice, and none was picked.
    await expect(reader.locator('.hib-freetext')).toHaveValue(note)
    // A choice sends the note, and the note's draft goes with it.
    await reader.locator('.hib-action-btn').filter({ hasText: 'Option A' }).click()
    await expect(reader.locator('.hib-answered-note')).toContainText(note, { timeout: 20_000 })
    await expect.poll(async () => (await serverDrafts(request))[`draft:letter-note:${letterId}`]?.v ?? null, { timeout: 15_000 }).toBeNull()
  })

  test('a new-session draft column comes back after a reload with its words', async ({ page, request }) => {
    await forgetDrafts(request, (k) => k.startsWith('draft:new-session'))
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openDraft(page)
    const words = `start a task about drafts ${NONCE}`
    await panel.locator('.chat-input-textarea').fill(words)
    await expectServerDraft(request, (k) => k.startsWith('draft:new-session:draft:'), words)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(draftPanel(page)).toBeVisible({ timeout: 15_000 })
    await expect(draftPanel(page).locator('.chat-input-textarea')).toHaveValue(words)
    await shot(page, '05-new-session-draft-back', draftPanel(page))
  })

  test('a new-session draft keeps its column beside a session the URL names', async ({ page, request }) => {
    await forgetDrafts(request, (k) => k.startsWith('draft:new-session'))
    await resetThreadsFixture(request, TAGGED_SESSION)
    await openTagged(page)
    await expect.poll(() => new URL(page.url()).search).toContain(TAGGED_SESSION)
    const panel = await openDraft(page)
    const words = `a second task beside a session ${NONCE}`
    await panel.locator('.chat-input-textarea').fill(words)
    await expectServerDraft(request, (k) => k.startsWith('draft:new-session:draft:'), words)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(draftPanel(page)).toBeVisible({ timeout: 15_000 })
    await expect(draftPanel(page).locator('.chat-input-textarea')).toHaveValue(words)
    await expect(page.locator(`.main-page-session-column [data-session-id="${TAGGED_SESSION}"]`).first()).toBeVisible()
    await draftPanel(page).locator('.chat-input-textarea').fill('')
  })

  test('the quick task composer keeps its sentence after Esc and a reload', async ({ page, request }) => {
    await forgetDrafts(request, (k) => k.startsWith('draft:quick-task:composer'))
    const openComposer = async () => {
      await page.click('a[href="/calendar"]')
      await expect(page.locator('.cal-toolbar')).toBeVisible()
      const today = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
      await page.locator('.cal-grid-scroll').evaluate((el) => { el.scrollTop = 14 * 48 - el.clientHeight / 2 })
      const box = await page.locator(`.cal-day-col[data-day="${day}"]`).boundingBox()
      if (!box) throw new Error(`day column ${day} not visible`)
      await page.mouse.click(box.x + box.width / 2, box.y + 14 * 48 + 12)
      const composer = page.locator('.cal-create-popover .quick-task-composer')
      await expect(composer).toBeVisible()
      return composer
    }
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    let composer = await openComposer()
    const words = `call the plumber ${NONCE}`
    await composer.locator('.qtc-input').fill(words)
    await composer.locator('.qtc-input').press('Escape')
    await expect(composer).toHaveCount(0)
    composer = await openComposer()
    await expect(composer.locator('.qtc-input')).toHaveValue(words)
    await expectServerHolds(request, 'draft:quick-task:composer', words)
    await page.reload()
    await page.waitForLoadState('networkidle')
    composer = await openComposer()
    await expect(composer.locator('.qtc-input')).toHaveValue(words)
    await shot(page, '06-quick-task-after-reload', composer)
    await composer.locator('.qtc-input').fill('')
  })
})
