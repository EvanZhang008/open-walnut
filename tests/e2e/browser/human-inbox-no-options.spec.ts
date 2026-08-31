/**
 * A letter that PROMISED a decision and carries no options, read in the REAL UI.
 *
 * The server now rejects this shape at send time, so it can only ever arrive as a
 * letter already on disk — which is exactly why this spec seeds the store
 * DIRECTLY instead of using `POST /api/v1/human-inbox` like every other letter
 * spec. Trying to create one through the API is the negative case, and it is
 * covered at the route level (tests/web/human-inbox-routes.test.ts).
 *
 * What the human must see: the reader used to gate its whole decision block on
 * having buttons, so a letter like this rendered an "Action needed" badge over a
 * document with nothing to answer it with, and no explanation. The claim here is
 * that the reader now SAYS SO and points at the reply box that still works.
 *
 * Subject-scoped and tolerant of other letters: the fixture server is shared, so
 * the letter store is global state (same discipline as human-inbox.spec.ts).
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/human-inbox'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)

const NONCE = Date.now().toString(36)
const SUBJECT = `PW LTR optionless ${NONCE}`
const BODY_MARKER = `LETTER-OPTIONLESS-BODY-${NONCE}`

let walnutHome = ''
let letterId = ''

test.describe.configure({ mode: 'serial' })

/** `lt-<base36 time>-<hex>` — the only id shape the store will open a body for. */
function newLetterId(): string {
  return `lt-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
}

/**
 * Write the letter straight into the store: an envelope in index.json and a body
 * beside it. Read-modify-write so a letter another spec created in the same window
 * survives.
 */
async function seedOptionlessLetter(): Promise<string> {
  const dir = path.join(walnutHome, 'human-inbox')
  const indexFile = path.join(dir, 'index.json')
  const bodiesDir = path.join(dir, 'bodies')
  await fs.mkdir(bodiesDir, { recursive: true })

  const id = newLetterId()
  const markdown = `## Which cache should we keep?\n\n${BODY_MARKER}\n\n`
    + 'Option A halves cold reads. Option B keeps memory flat.\n'
  await fs.writeFile(path.join(bodiesDir, `${id}.md`), markdown, 'utf-8')

  const store = await fs.readFile(indexFile, 'utf-8')
    .then(raw => JSON.parse(raw) as { version: 1; letters: unknown[] })
    .catch(() => ({ version: 1 as const, letters: [] as unknown[] }))
  store.letters.push({
    id,
    subject: SUBJECT,
    type: 'action_required',
    bodyFormat: 'markdown',
    textPreview: 'A decision letter whose options never made it to disk.',
    sender: { sessionId: 'external', host: 'local' },
    createdAt: Date.now(),
    read: false,
    pinned: false,
    archived: false,
    bodyBytes: Buffer.byteLength(markdown, 'utf-8'),
    thread: [],
    // NO `actions` key at all — the defect this spec is about.
  })
  await fs.writeFile(indexFile, JSON.stringify(store, null, 2), 'utf-8')
  return id
}

async function loadHome(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
}

async function openInboxRail(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'Inbox' }).click()
  await expect(panel.locator('.hib-toolbar')).toBeVisible()
  return panel
}

test.beforeAll(async () => {
  ;({ walnutHome } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  letterId = await seedOptionlessLetter()
})

test.afterAll(async () => {
  // Archive through the API (its cross-process lock, not a raw rewrite) so the
  // shared feed does not keep this letter around for later specs.
  if (!letterId) return
  await fetch(`http://localhost:${TEST_PORT}/api/v1/human-inbox/${letterId}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: true }),
  }).catch(() => {})
})

test('a decision letter with no options explains itself and offers the reply box', async ({ page }) => {
  await loadHome(page)
  const panel = await openInboxRail(page)

  // Real click on the envelope row, not a deep link.
  const row = panel.locator('.hib-row').filter({ hasText: SUBJECT })
  await expect(row).toHaveCount(1, { timeout: 15_000 })
  await expect(row.locator('.hib-type')).toHaveText('Action needed')
  await row.click()

  // Scoped to the PAGE, not the panel: the overlay reader is portalled to the
  // document root (LetterReader → createPortal), so a panel-scoped locator never
  // finds it even though the row that opens it lives inside the panel.
  const reader = page.locator('.hib-view')
  await expect(reader).toBeVisible()
  await expect(reader.locator('.hib-reader-subject')).toHaveText(SUBJECT)

  // The letter still claims a decision…
  await expect(reader.locator('.hib-type')).toHaveText('Action needed')
  // …there is genuinely nothing to tap…
  await expect(reader.locator('.hib-action-btn')).toHaveCount(0)
  await expect(reader.locator('.hib-actions')).toHaveCount(0)
  // …the reader says so instead of showing an empty decision area…
  const notice = reader.locator('[data-testid="hib-no-options"]')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('attached no options')
  // …the document itself still renders…
  await expect(reader.locator('.hib-md-body')).toContainText(BODY_MARKER)
  // …and the control the notice points at is really there and usable.
  const composer = reader.locator('.hib-composer-input')
  await expect(composer).toBeVisible()
  await composer.fill('Neither — keep the current cache for now.')
  await expect(reader.locator('.hib-send-btn')).toBeEnabled()

  await page.screenshot({ path: `${SCREENSHOT_DIR}/hib-no-options.png` })
})
