/**
 * The notification center joins the one notice card (2026-11-21 UI audit of the user's real feed:
 * the center's rows were a third card of their own). With the kinds his feed holds (this computer's
 * Claude Code not installed, a Rhythm break notice from 23 hours ago, letters from tasks with long
 * titles and a fork's machine name for a session, an error), the open panel is checked for:
 *   - every row a NoticeCard; an unread row the same fill and frame as a read one (its status says
 *     "New"); the Claude Code notice the same card, its x at its top right, ONE main action, the
 *     manual command whole under "Other ways to set up";
 *   - a long task title on two lines before it is cut, the time under it;
 *   - the source as one quiet last line, the machine name and host only in its title;
 *   - the break notice's End break / Another block gone once the break is over;
 *   - the rail's selected entry not a solid block, the rail narrower, the counts the one badge;
 *   - the header's Clear and Quiet as tool buttons saying what they do;
 *   - a scrim over the page beside the panel, a click on which closes it;
 *   - the bell: one count badge, no dot on it.
 * And (2026-11-22 review) with a break that is still on, a pending ask on another computer and an
 * AI provider that does not answer:
 *   - a break's buttons render while it runs and leave the open panel when it ends;
 *   - the host of an ask on another computer is on its source line;
 *   - Clear never takes an ask still waiting; Enter on a row's x closes the row;
 *   - the compact provider card shows Open API settings without a click.
 * PANEL_SHOTS=<dir> saves the open panel at 1512x920 in both themes (PANEL_BEFORE=1: only the
 * screenshots, for a build before this change).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { bpSetup, railButton } from './host-attention-helpers'
import { connected } from './host-problems-helpers'
import { bell, openBell } from './host-problems-fixture-helpers'

const SHOTS = process.env.PANEL_SHOTS || ''
const BEFORE = process.env.PANEL_BEFORE === '1'
const HOUR = 3_600_000
const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'

test.use({ viewport: { width: 1512, height: 920 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial', timeout: 120_000 })

/** The feed as his Walnut wrote it on 2026-11-21 (neutral names), newest first. */
function feed(now: number): Array<Record<string, unknown>> {
  const breakEnds = now - 23 * HOUR + 10 * 60_000
  return [
    {
      id: 'pc-focus', kind: 'reminder', severity: 'success', title: 'Focus block done, 10 min break',
      body: '45 min. Stand up and move; the break ends at 14:50.', dedupKey: 'plugin:walnut-rhythm:focus-done',
      timestamp: now - 23 * HOUR, read: true,
      actions: [
        { kind: 'op', label: 'End break', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_break_skip', expiresAt: breakEnds },
        { kind: 'op', label: 'Another block', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_focus_start', expiresAt: breakEnds },
      ],
    },
    {
      id: 'pc-letter-1', kind: 'letter', severity: 'info', letterId: 'pc-l1', dedupKey: 'letter:pc-l1',
      title: 'Task “Garden planner for the spring beds”: the watering chart is redrawn',
      body: 'The watering chart is redrawn with the new bed sizes. Three pictures are attached here; reply "ok" and I print it on Friday.',
      sessionId: 'cffc7f02-9b1e-4c55-8d0a-111111111111', taskId: 'pc-task-demo',
      sessionTitle: 'Fork of Session: garden — the chart draft', host: 'local',
      timestamp: now - 23 * HOUR + 60_000, read: false,
    },
    {
      id: 'pc-letter-2', kind: 'letter', severity: 'info', letterId: 'pc-l2', dedupKey: 'letter:pc-l2',
      title: 'Task “Recipe book: soup chapter for the winter evenings”: two recipes need a look',
      body: 'In short: the lentil soup and the pumpkin soup list the same spice twice; pick which one keeps it.',
      sessionId: 'aa11bb22-0000-4000-8000-222222222222', taskId: 'pc-task-image',
      sessionTitle: 'Recipe book: soup chapter', project: 'Home', host: 'devbox',
      timestamp: now - 23 * HOUR + 120_000, read: false,
    },
    {
      id: 'pc-error', kind: 'operation-error', severity: 'error', needsYou: 'own-action', category: 'Data & Sync',
      title: 'Disk space low', body: 'Free space on the disk that holds Walnut’s data. Walnut frees what it can rebuild first.',
      dedupKey: 'error:pc-disk', timestamp: now - 2 * HOUR, read: true,
    },
  ]
}

/** The health answer with this computer's Claude Code (or provider) state laid over it. */
async function localHealth(page: Page, patch: () => Record<string, unknown>): Promise<void> {
  // Registered after bpSetup's own health route, so it answers first.
  await page.route('**/api/system/health', async (route) => {
    try {
      const res = await route.fetch()
      const body = await res.json() as Record<string, unknown>
      await route.fulfill({ response: res, json: { ...body, ...patch() } })
    } catch { /* the page closed mid-request */ }
  })
  await page.route('**/api/system/local-claude/check', (route) => route.fulfill({ json: {} }))
}

/** This computer's Claude Code is not installed (the one-click install is offered). */
async function claudeMissing(page: Page): Promise<void> {
  await localHealth(page, () => ({
    hasReadyProvider: true, claudeCliAvailable: false,
    localClaude: {
      checkedAt: Date.now(), claude: { found: false, minVersion: '2.1.280' },
      problems: [{ kind: 'claude_missing', message: 'Claude Code is not installed on this computer.', commands: [INSTALL] }],
    },
  }))
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(SHOTS, `${BEFORE ? 'before' : 'after'}-${name}.png`) })
}

async function openPanel(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme })
  await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], feed: feed(Date.now()) })
  await claudeMissing(page)
  // bpSetup loaded Home under its own health route; load it again under this one.
  await page.reload()
  await expect(bell(page)).toBeVisible({ timeout: 45_000 })
  await openBell(page)
  if (await railButton(page, 'All').getAttribute('aria-current') !== 'true') await railButton(page, 'All').click()
  await expect(page.locator('[data-testid="nfc-local-claude"]')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.notification-panel .notification-feed-item', { hasText: 'Disk space low' })).toBeVisible()
}

for (const scheme of ['light', 'dark'] as const) {
  test(`NP-${scheme}: the open panel at 1512x920 (${scheme})`, async ({ page }) => {
    await openPanel(page, scheme)
    await shot(page, `panel-${scheme}`)
    if (BEFORE) return
    const panel = page.locator('.notification-panel')

    // Every row is the one notice card, and unread is no fill: a letter (unread) and the error (read)
    // share their background and frame; the letter's status says New.
    const rows = panel.locator('.notification-feed-item')
    expect(await rows.count()).toBeGreaterThanOrEqual(4)
    expect(await rows.evaluateAll((els) => els.every((e) => e.classList.contains('wn-notice')))).toBe(true)
    const look = (text: string) => panel.locator('.notification-feed-item', { hasText: text }).first().evaluate((e) => {
      const cs = getComputedStyle(e)
      return `${cs.backgroundColor}|${cs.borderTopColor}|${cs.borderLeftColor}|${cs.borderRadius}`
    })
    expect(await look('watering chart')).toBe(await look('Disk space low'))
    await expect(panel.locator('.notification-feed-item', { hasText: 'watering chart' }).locator('.nfc-row-status')).toHaveText('New')

    // A long task title takes two lines before it is cut, with its time under it.
    const geo = await panel.locator('.notification-feed-item', { hasText: 'soup chapter' }).evaluate((e) => {
      const title = e.querySelector('.notification-feed-item-title')!
      const time = e.querySelector('.notification-feed-item-time')!.getBoundingClientRect()
      const t = title.getBoundingClientRect()
      return { lines: Math.round(t.height / parseFloat(getComputedStyle(title).lineHeight)), cut: title.scrollHeight > title.clientHeight + 1, timeTop: time.top, titleBottom: t.bottom }
    })
    expect(geo.lines).toBe(2)
    expect(geo.cut).toBe(false)
    expect(geo.timeTop).toBeGreaterThanOrEqual(geo.titleBottom - 1)

    // The source: one quiet last line, the fork by its own name (as its avatar reads it); its machine
    // prefix, the session id and "local" only in titles.
    const fork = panel.locator('.notification-feed-item', { hasText: 'watering chart' })
    await expect(fork.locator('.nfc-row-source')).toHaveText('garden \u2014 the chart draft')
    await expect(fork).not.toContainText('Fork of Session')
    await expect(fork).not.toContainText('cffc7f02')
    await expect(fork.locator('.notification-feed-item-time')).toHaveAttribute('title', /Fork of Session[\s\S]*Session id: cffc7f02[\s\S]*Host: /)
    const image = panel.locator('.notification-feed-item', { hasText: 'soup chapter' })
    // Another computer stays on the line (a phone has no hover); this computer is no news.
    await expect(image.locator('.nfc-row-source')).toHaveText('Recipe book: soup chapter · Home · on Dev box')
    await expect(image.locator('.nfc-chip')).toHaveCount(0)

    // The break notice from 23 hours ago offers nothing that only applied to that break.
    const focus = panel.locator('.notification-feed-item', { hasText: 'Focus block done' })
    await expect(focus).toBeVisible()
    await expect(focus.getByRole('button', { name: 'End break' })).toHaveCount(0)
    await expect(focus.getByRole('button', { name: 'Another block' })).toHaveCount(0)

    // Claude Code: the same card, its x at its top right, one main action, the command folded and whole.
    const local = panel.locator('[data-testid="nfc-local-claude"]')
    await expect(local).toHaveClass(/wn-notice/)
    const box = (await local.boundingBox())!
    const xBox = (await local.getByRole('button', { name: 'Dismiss Claude Code notice' }).boundingBox())!
    expect(xBox.y - box.y).toBeLessThan(16)
    expect(box.x + box.width - (xBox.x + xBox.width)).toBeLessThan(16)
    await expect(local.locator('.btn-primary')).toHaveText(['Install Claude Code'])
    await expect(local.getByRole('button', { name: 'Open API settings' })).toBeVisible()
    await expect(local.locator('code.setup-command')).toBeHidden()
    await local.getByText('Other ways to set up').click()
    const cmd = local.locator('code.setup-command')
    await expect(cmd).toHaveText(INSTALL)
    const cmdBox = (await cmd.boundingBox())!
    expect(cmdBox.height).toBeLessThan(26)
    await shot(page, `panel-${scheme}-other-ways`)
    await local.getByText('Other ways to set up').click()

    // The rail: narrower, its selected entry Home's quiet state (no solid block), the counts one badge.
    const rail = (await panel.locator('.nfc-rail').boundingBox())!
    expect(rail.width).toBeLessThanOrEqual(120)
    const active = await railButton(page, 'All').evaluate((e) => getComputedStyle(e).backgroundColor)
    const alpha = Number(/rgba?\(([^)]+)\)/.exec(active)?.[1]?.split(',')[3] ?? 1)
    expect(alpha).toBeLessThan(0.3)

    // The header: tool buttons in one group, saying what they do.
    const tools = panel.locator('.nfc-header-tools')
    await expect(tools.locator('button.btn')).toHaveText(['Clear all', 'Mute for 1 hour', ''])
    await expect(tools.getByTestId('nfc-quiet-toggle')).toHaveAttribute('title', /Mute toasts, sounds and phone pushes for an hour/)

    // A light scrim right of the panel; a click on it closes the panel.
    const scrim = await page.locator('[data-testid="notification-panel-backdrop"]').evaluate((e) => {
      const after = getComputedStyle(e, '::after')
      return { bg: after.backgroundColor, left: parseFloat(after.left) }
    })
    const panelBox = (await panel.boundingBox())!
    expect(scrim.bg).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/)
    expect(Math.abs(scrim.left - (panelBox.x + panelBox.width))).toBeLessThan(20)
    await page.mouse.click(panelBox.x + panelBox.width + 200, 400)
    await expect(panel).toBeHidden()

    // The bell: one count badge at most, never a dot on it.
    // (unread letters wait on him, and Claude Code is a reason: before, a dot sat on the count's corner)
    await expect(bell(page).locator('.notification-badge-count')).toBeVisible()
    await expect(bell(page).locator('.notification-badge-dot')).toHaveCount(0)
    await shot(page, `sidebar-${scheme}`)
  })
}

/** A live break, a pending ask and a settled one on another computer, and an error with no link. */
function liveFeed(now: number, breakEnds: number): Array<Record<string, unknown>> {
  return [
    {
      id: 'pl-focus', kind: 'reminder', severity: 'success', title: 'Focus block done, 5 min break',
      body: '25 min. Stand up and move.', dedupKey: 'plugin:walnut-rhythm:focus-done', timestamp: now - 60_000, read: true,
      actions: [
        { kind: 'op', label: 'End break', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_break_skip', expiresAt: breakEnds },
        { kind: 'op', label: 'Another block', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_focus_start', expiresAt: breakEnds },
      ],
    },
    {
      id: 'pl-ask', kind: 'permission', severity: 'warning', title: 'Bash', body: 'rm -rf build/',
      dedupKey: 'perm:pl-req-1', requestId: 'pl-req-1', toolName: 'Bash', input: { command: 'rm -rf build/' },
      sessionId: 'bb22cc33-0000-4000-8000-333333333333', sessionTitle: 'Clean the build folder', host: 'devbox',
      timestamp: now - 30_000, read: false,
    },
    {
      id: 'pl-asked', kind: 'permission', severity: 'success', title: 'Read', resolved: 'allowed',
      dedupKey: 'perm:pl-req-0', requestId: 'pl-req-0', toolName: 'Read', input: { file_path: 'notes.txt' },
      sessionId: 'bb22cc33-0000-4000-8000-444444444444', timestamp: now - 3 * 60_000, read: true,
    },
    {
      id: 'pl-error', kind: 'operation-error', severity: 'error', needsYou: 'own-action', category: 'Data & Sync',
      title: 'Disk space low', body: 'Free space on the disk that holds Walnut\u2019s data.',
      dedupKey: 'error:pl-disk', timestamp: now - 2 * HOUR, read: true,
    },
  ]
}

test('NP-live: a running break\'s buttons, an ask\'s host, Clear and a row\'s x by key', async ({ page }) => {
  const now = Date.now()
  // The page's clock runs on its own and is moved past the break's end below: a busy host can take
  // longer than any fixed wait just to show the bell (2026-11-22: 51 s, past a 25 s break).
  const breakEnds = now + 10 * 60_000
  await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], feed: liveFeed(now, breakEnds) })
  await claudeMissing(page)
  await page.clock.install({ time: now })
  await page.reload()
  await expect(bell(page)).toBeVisible({ timeout: 45_000 })
  await openBell(page)
  if (await railButton(page, 'All').getAttribute('aria-current') !== 'true') await railButton(page, 'All').click()
  const panel = page.locator('.notification-panel')

  // While the break runs, its row offers both of its buttons, as the card family's actions.
  const focus = panel.locator('.notification-feed-item', { hasText: 'Focus block done' })
  const buttons = focus.getByTestId('nfc-notice-action')
  await expect(buttons).toHaveText(['End break', 'Another block'], { timeout: 20_000 })
  await expect(buttons.first()).toHaveClass(/nfc-card-action--primary/)
  await expect(focus.locator('.nfc-card-action')).toHaveCount(2)

  // The ask on another computer names it on its source line; the settled one has its short id.
  const ask = panel.locator('.nfc-perm-card', { hasText: 'rm -rf build/' })
  await expect(ask.locator('.nfc-row-source')).toHaveText('Clean the build folder \u00b7 on Dev box')
  await expect(panel.locator('.nfc-perm-card', { hasText: 'notes.txt' }).locator('.nfc-row-source')).toHaveText('Session bb22cc33\u2026')

  // Enter on a row's x closes the row; the panel stays open and the row does not open.
  const error = panel.locator('.notification-feed-item', { hasText: 'Disk space low' })
  await error.getByRole('button', { name: 'Dismiss notification' }).focus()
  await page.keyboard.press('Enter')
  await expect(error).toHaveCount(0)
  await expect(panel).toBeVisible()

  // The break ends with the panel open: its buttons go, its row stays as history.
  await page.clock.fastForward(breakEnds - now + 1_000)
  await expect(buttons).toHaveCount(0, { timeout: 10_000 })
  await expect(focus).toBeVisible()

  // Clear all takes what is settled and leaves the ask that still waits.
  await panel.getByRole('button', { name: 'Clear all' }).click()
  await expect(focus).toHaveCount(0)
  await expect(panel.locator('.nfc-perm-card', { hasText: 'notes.txt' })).toHaveCount(0)
  await expect(ask).toBeVisible()
  // On Needs you nothing settled is left: no Clear at all.
  await railButton(page, 'Needs you').click()
  await expect(ask).toBeVisible()
  await expect(panel.locator('.nfc-header-clear')).toHaveCount(0)
})

test('NP-provider: the compact provider card shows its one action without a click', async ({ page }) => {
  await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], feed: [] })
  await localHealth(page, () => ({
    claudeCodeNeeded: false, hasReadyProvider: false, claudeCliAvailable: true,
    mainProvider: 'ollama', mainProviderLocal: true, credentialDetail: 'http://127.0.0.1:11434',
    localClaude: { checkedAt: Date.now(), claude: { found: true, auth: 'ok', version: '2.1.280', minVersion: '2.1.280' }, problems: [] },
  }))
  await page.reload()
  await expect(bell(page)).toBeVisible({ timeout: 45_000 })
  await openBell(page)
  const local = page.locator('[data-testid="nfc-local-claude"]')
  await expect(local).toBeVisible({ timeout: 20_000 })
  await expect(local).toHaveAttribute('data-compact', 'true')
  await expect(local).toHaveAttribute('data-kind', 'provider')
  await expect(local.getByRole('button', { name: 'Open API settings' })).toBeVisible()
  await shot(page, 'panel-provider-compact')
  // A click on it goes to the providers settings, and the panel closes.
  await local.getByRole('button', { name: 'Open API settings' }).click()
  await expect(page.locator('.notification-panel')).toBeHidden()
  await expect(page).toHaveURL(/\/settings/)
})
