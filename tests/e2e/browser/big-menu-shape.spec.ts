/**
 * The hand-built big menus, measured as drawn (standard.md, "Big menus"; web/src/utils/menu-shape.ts):
 * the session ⋮ menu, the task row ⋮ and its right-click, the composer + menu. Each one's first level
 * (groups closed) must have the shape: everyday rows first, named sections, at most three bare rules,
 * Delete last alone under its rule, and every row that opens more ends with the one chevron.
 *
 * 2026-11-22, the UI audit on a copy of the user's data: seven rules in the session menu, Delete
 * above the session's group, three kinds of chevron (▶︎, ›, ▾) on rows that open more.
 * tests/web/menu-shape.test.ts makes every new menu box choose: measured here, or a short list.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { menuShapeProblems, type MenuShapeRow } from '../../../web/src/utils/menu-shape'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SID = (browserName: string) => `pw-background-bar-${browserName}`

test.setTimeout(150_000)
test.use({ viewport: { width: 1512, height: 920 }, deviceScaleFactor: 1 })

type Drawn = { rows: MenuShapeRow[]; chevronless: string[]; glyphs: string[]; offHeight: string[] }

/** The menu's first level as the shape sees it, plus the expanding rows that lack the shared chevron. */
async function drawn(menu: Locator): Promise<Drawn> {
  return menu.evaluate((root) => {
    const rows: Array<{ kind: string; danger?: boolean; label?: string }> = []
    const chevronless: string[] = []
    const glyphs: string[] = []
    const offHeight: string[] = []
    const ROW = '.task-kebab-item, .chat-plus-menu-item, .task-pin-shortcuts, .task-kebab-panels, .wn-context-menu-item'
    const shown = (el: HTMLElement) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0
    const walk = (el: Element) => {
      for (const child of Array.from(el.children)) {
        const c = child as HTMLElement
        if (!shown(c)) continue
        if (c.matches('.wn-menu-heading')) { rows.push({ kind: 'heading', label: c.innerText.trim() }); continue }
        if (c.matches('.task-kebab-divider, .chat-plus-menu-divider, [role="separator"]')) { rows.push({ kind: 'divider' }); continue }
        if (c.matches(ROW)) {
          const label = c.innerText.replace(/\s+/g, ' ').trim().slice(0, 60)
          const opens = c.matches('[aria-expanded], [aria-haspopup]')
          rows.push({ kind: opens ? 'group' : 'item', danger: /danger/.test(c.className), label })
          // Every row that opens more ends with the shared chevron; the Pin row's More is such a key.
          for (const key of [c, ...Array.from(c.querySelectorAll<HTMLElement>('[aria-expanded], [aria-haspopup]'))]) {
            if (key.matches('[aria-expanded], [aria-haspopup]') && !key.querySelector('.wn-disclosure-chevron')) chevronless.push(label)
          }
          if (/[▶▸▾›]/.test(label)) glyphs.push(label)
          // ONE row height (overlay-family.css, --overlay-row-height): a one-line row of words is 30 px;
          // a row that holds keys of its own (the Pin row's shortcuts) grows past it.
          const h = Math.round(c.getBoundingClientRect().height)
          if (c.matches('.task-kebab-item, .chat-plus-menu-item, .wn-context-menu-item') && !c.querySelector('button, input, [role="switch"]') && h !== 30) offHeight.push(`${label} (${h} px)`)
          // One drawn icon and one line of words: an icon slot holds an <svg>, never a typed character.
          for (const slot of Array.from(c.querySelectorAll<HTMLElement>('.task-kebab-icon, .chat-plus-menu-key'))) {
            if (slot.closest(ROW) === c && !slot.querySelector('svg') && slot.textContent!.trim()) glyphs.push(`${label} (icon "${slot.textContent!.trim()}")`)
          }
          // Whatever its class, a row that leads with a one- or two-character mark and no drawn icon
          // (a boxed letter, a typed arrow) has a typed icon.
          const lead = c.firstElementChild as HTMLElement | null
          if (lead && lead.tagName !== 'svg' && !lead.querySelector('svg') && /^\S{1,2}$/.test(lead.textContent!.trim())) glyphs.push(`${label} (leads with "${lead.textContent!.trim()}")`)
          continue
        }
        walk(c)
      }
    }
    walk(root)
    return { rows: rows as MenuShapeRow[], chevronless, glyphs, offHeight }
  })
}

function judge(id: string, d: Drawn) {
  const line = d.rows.map((r) => (r.kind === 'divider' ? '—' : r.kind === 'heading' ? `[${r.label}]` : r.label)).join(' | ')
  expect(menuShapeProblems(d.rows), `${id}: ${line}`).toEqual([])
  expect(d.chevronless, `${id}: rows that open more without the shared chevron`).toEqual([])
  expect(d.glyphs, `${id}: a hand-drawn arrow glyph on a row`).toEqual([])
  expect(d.offHeight, `${id}: one-line rows off the family's row height`).toEqual([])
  // Big enough to be a big menu: the check above really ran.
  expect(d.rows.filter((r) => r.kind === 'item' || r.kind === 'group').length, `${id}: ${line}`).toBeGreaterThanOrEqual(8)
}

async function openColumn(page: Page, sid: string): Promise<Locator> {
  await page.addInitScript((id) => {
    try { sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }])) } catch { /* ignore */ }
  }, sid)
  await page.evaluate((url) => { location.assign(url) }, `${API}/`)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 90_000 })
  return panel
}

/** The right edge of every chevron drawn in the menu: one column, open groups included. */
async function chevronColumn(menu: Locator): Promise<number[]> {
  return menu.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>('.wn-disclosure-chevron'))
    .filter((c) => c.getClientRects().length > 0)
    .map((c) => Math.round(c.getBoundingClientRect().right)))
}

/** An open group that shows its rows in place without the shared indent and rail. */
async function bodiesWithoutRail(menu: Locator): Promise<string[]> {
  return menu.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>('.task-kebab-group-body, .task-kebab-team-rows'))
    .filter((b) => b.getClientRects().length > 0 && parseFloat(getComputedStyle(b).borderLeftWidth) < 1)
    .map((b) => (b.previousElementSibling as HTMLElement | null)?.innerText?.trim().slice(0, 40) ?? b.className))
}

async function settle(menu: Locator) {
  await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))))
}

test('the session menu: Session and Task sections, Delete task last', async ({ page, browserName }) => {
  const panel = await openColumn(page, SID(browserName))
  await panel.locator('.session-panel-header .task-kebab-btn').click()
  const menu = page.locator('.task-kebab-menu')
  await expect(menu.getByTestId('kebab-group-dates')).toBeVisible({ timeout: 60_000 })
  await settle(menu)
  const d = await drawn(menu)
  judge('session-kebab', d)
  // Every row's chevron on one column, the Pin row's Others included (the UI review, 2026-11-23).
  const col = await chevronColumn(menu)
  expect(Math.max(...col) - Math.min(...col), `session-kebab chevrons: ${col.join(', ')}`).toBeLessThanOrEqual(1)
  expect(d.rows.filter((r) => r.kind === 'heading').map((r) => r.label)).toEqual(['SESSION', 'TASK'].map((h) => expect.stringMatching(new RegExp(`^${h}$`, 'i'))))
  // The session's own group sits in its section, Session info leading it, closed like every group
  // (open, it made the menu taller than a 1280 x 800 window: the UI review, 2026-11-22).
  const session = menu.getByTestId('session-kebab-session')
  await session.locator('> .task-kebab-group-toggle').click()
  const details = session.getByTestId('session-kebab-details').locator('> .task-kebab-group-toggle')
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  await details.click()
  await expect(session.getByTestId('session-kebab-meta')).toBeVisible()
  expect(d.rows.at(-1)).toMatchObject({ danger: true, label: 'Delete task' })
})

test('the task row menu, by its ⋮ and by right-click: one menu, the same shape', async ({ page }) => {
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `Big menu shape ${Date.now()}`, source: 'local' }),
  })
  const { task } = (await res.json()) as { task: { id: string; title: string } }
  try {
    await page.evaluate((url) => { location.assign(url) }, API)
    await page.locator('.todo-search-input').fill(task.title)
    const row = page.locator(`.todo-panel-item[data-task-id="${task.id}"]`)
    await expect(row).toBeVisible({ timeout: 60_000 })
    const shapes: Record<string, Drawn> = {}
    for (const [id, open] of [
      ['row-kebab', () => row.getByRole('button', { name: 'More actions' }).click()],
      ['row-context', () => row.click({ button: 'right' })],
    ] as const) {
      await open()
      const menu = page.locator('.task-kebab-menu:visible')
      await expect(menu.getByTestId('kebab-group-dates')).toBeVisible()
      await settle(menu)
      shapes[id] = await drawn(menu)
      judge(id, shapes[id])
      expect(shapes[id].rows.at(-1)).toMatchObject({ danger: true, label: 'Delete task' })
      if (id === 'row-kebab') {
        // Inside every group too: each row is one drawn icon and its words (Move & transfer's
        // source row once led with a boxed letter, Team's Directors row with a typed star).
        const closed = menu.locator('.task-kebab-group-toggle[aria-expanded="false"]:visible, [data-testid="kebab-team-toggle"][aria-expanded="false"]:visible')
        for (let i = 0; i < 12 && (await closed.count()) > 0; i++) await closed.first().click()
        await settle(menu)
        expect((await drawn(menu)).glyphs, `${id}, every group open: a typed icon`).toEqual([])
        // Every open group reads the same: the indent and rail (Team's rows once had only an indent),
        // and its chevrons end on the menu's one column.
        expect(await bodiesWithoutRail(menu), `${id}: open groups without the rail`).toEqual([])
        const col = await chevronColumn(menu)
        expect(Math.max(...col) - Math.min(...col), `${id} chevrons, every group open: ${col.join(', ')}`).toBeLessThanOrEqual(1)
      }
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
    }
    expect(shapes['row-context'].rows).toEqual(shapes['row-kebab'].rows)
  } finally {
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' }).catch(() => undefined)
  }
})

test('the composer + menu: Add, Shortcuts, This task, This chat; named sections, no bare rules', async ({ page, browserName }) => {
  const panel = await openColumn(page, SID(browserName))
  await panel.locator('.chat-plus-btn').first().click()
  const menu = page.locator('.chat-plus-menu.wn-menu').first()
  await expect(menu).toBeVisible()
  await settle(menu)
  const d = await drawn(menu)
  const line = d.rows.map((r) => (r.kind === 'heading' ? `[${r.label}]` : r.kind === 'divider' ? '—' : r.label)).join(' | ')
  // Shorter than a big menu on some fixtures: the rules apply at any length here.
  expect(menuShapeProblems(d.rows, { minRows: 0 }), `composer-plus: ${line}`).toEqual([])
  expect(d.rows.filter((r) => r.kind === 'divider'), `composer-plus: no bare rules, its sections are named: ${line}`).toEqual([])
  expect(d.chevronless, 'composer-plus').toEqual([])
  expect(d.glyphs, 'composer-plus').toEqual([])
  expect(d.rows.filter((r) => r.kind === 'heading').map((r) => r.label?.toLowerCase())).toContain('shortcuts')

  // A row that opens a menu beside it (More, Reply style) keeps its chevron pointing at it when
  // open; only a row that opens its rows in place turns it down (2026-11-23: More pointed down).
  const openers = menu.locator('[aria-haspopup][aria-expanded]:has(> .wn-disclosure-chevron)')
  const n = await openers.count()
  expect(n, 'the + menu has a row that opens a menu beside it').toBeGreaterThan(0)
  for (let i = 0; i < n; i++) {
    if (!(await menu.isVisible())) await panel.locator('.chat-plus-btn').first().click()
    const opener = openers.nth(i)
    if ((await opener.getAttribute('aria-expanded')) !== 'true') await opener.click()
    await expect(opener).toHaveAttribute('aria-expanded', 'true')
    const turn = await opener.locator('> .wn-disclosure-chevron').evaluate((el) => getComputedStyle(el).transform)
    expect(turn, `${await opener.innerText()}: open flyout row's chevron`).toBe('none')
  }
})

// Ids the source guard (tests/web/menu-shape.test.ts) looks for: 'session-kebab', 'row-kebab', 'row-context', 'composer-plus'.
