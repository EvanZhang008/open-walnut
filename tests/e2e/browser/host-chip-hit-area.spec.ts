/**
 * Folder picker host chips: every chip takes a click over its whole area, every
 * time, while hosts load, once they are connected, and with a host offline.
 *
 * Reported 2026-10-29 from the Mac app (WebKit): "I could not click a host ...
 * sometimes it works, sometimes it doesn't, or I need to aim a bit lower".
 *
 * Each chip is hit-tested (elementFromPoint) and then really clicked at its
 * middle, its edges and the ends of its straight edges. Host statuses are routed client-side
 * (host-problems-helpers' Hosts) and the working-dirs answer gets five remote
 * hosts, the user's real count. page.goto only loads the app.
 *
 * The same picker picks only a folder and a host (user, same day): the chip
 * row is labelled Host, and the engine and Pin rows it carried live in the
 * draft's More (tier, priority, dates) and the composer's model pill (engine).
 *
 * Run: bun x playwright test host-chip-hit-area --project=chromium-host-fixture --workers=1
 *      PW_WEBKIT=1 bun x playwright test host-chip-hit-area --project=webkit --workers=1
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { closeDraftModelPicker, draftEngineButton, openDraft, openDraftSettings } from './draft-helpers'
import { Hosts, connected, connecting, failed, resetServerHostFixture } from './host-problems-helpers'

const SHOTS = '/tmp/sps-chip'

const HOSTS = [
  { alias: 'bigbox', label: 'Big build box' },
  { alias: 'smallbox', label: 'Small dev box' },
  { alias: 'labmac', label: 'Lab mac' },
  { alias: 'homepc', label: 'Home pc' },
  { alias: 'cloudbox', label: 'Cloud' },
]

// Every chip x nine points x two clicks: minutes on a loaded machine, not 30 s.
test.describe.configure({ timeout: 240_000 })
test.beforeAll(async ({ request }) => { await resetServerHostFixture(request) })
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

const picker = (page: Page): Locator => page.locator('.session-path-selector')
const tabs = (page: Page): Locator => picker(page).locator('.sps-host-tab')

/** Five configured remote hosts, each with one history folder (the picker's real
 *  shape). `delay.ms` holds every answer from then on (read per request). */
async function injectHosts(page: Page, delay: { ms: number } = { ms: 0 }): Promise<void> {
  await page.route('**/api/sessions/working-dirs', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { dirs: Array<Record<string, unknown>>; hosts?: Array<{ alias: string }> }
    body.hosts = [...(body.hosts ?? []).filter((h) => !HOSTS.some((x) => x.alias === h.alias)), ...HOSTS]
    body.dirs = [
      ...body.dirs,
      ...HOSTS.map((h, i) => ({ cwd: `/home/alice/work/project-${i}`, host: h.alias, hostLabel: h.label, lastUsed: new Date(Date.now() - i * 60_000).toISOString(), count: 1 })),
    ]
    if (delay.ms) await new Promise((r) => setTimeout(r, delay.ms))
    await route.fulfill({ response: res, json: body })
  })
}

async function openPicker(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openDraft(page)
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()
  await expect(picker(page)).toBeVisible()
  // All, Local, the five hosts (the fixture may add hosts of its own).
  for (const h of HOSTS) await expect(picker(page).locator(`.sps-host-tab[data-host="${h.alias}"]`)).toBeVisible()
  // The panel slides about 4px into place as it opens (commandPaletteIn, longer
  // on a loaded machine): aim once it has landed, as a person does.
  await expect.poll(() => picker(page).evaluate((el) => el.getAnimations().length)).toBe(0)
}

/** The row never scrolls and every chip sits wholly inside it. */
async function expectWholeRow(page: Page): Promise<void> {
  const geo = await picker(page).locator('.sps-host-filter').evaluate((row) => {
    const r = row.getBoundingClientRect()
    const chips = [...row.querySelectorAll('.sps-host-tab')].map((c) => c.getBoundingClientRect())
    return {
      scrolls: row.scrollWidth > row.clientWidth + 1,
      outside: chips.filter((c) => c.left < r.left - 0.5 || c.right > r.right + 0.5 || c.top < r.top - 0.5 || c.bottom > r.bottom + 0.5).length,
    }
  })
  expect(geo).toEqual({ scrolls: false, outside: 0 })
}

type Box = { x: number; y: number; width: number; height: number }

/**
 * Points inside a chip: the middle, each edge 2px in, and the four ends of the
 * straight top and bottom edges. A chip is a pill, and no engine counts its
 * rounded ends' outer corners as part of it, so the corners of its box are not
 * points of the chip.
 */
function chipPoints(b: Box): Array<{ name: string; x: number; y: number }> {
  const IN = 2, r = b.height / 2
  const [l, t, w, h] = [b.x, b.y, b.width, b.height]
  return [
    { name: 'middle', x: l + w / 2, y: t + h / 2 },
    { name: 'top', x: l + w / 2, y: t + IN },
    { name: 'bottom', x: l + w / 2, y: t + h - IN },
    { name: 'left', x: l + IN, y: t + h / 2 },
    { name: 'right', x: l + w - IN, y: t + h / 2 },
    { name: 'top-left', x: l + r, y: t + IN },
    { name: 'top-right', x: l + w - r, y: t + IN },
    { name: 'bottom-left', x: l + r, y: t + h - IN },
    { name: 'bottom-right', x: l + w - r, y: t + h - IN },
  ]
}

/** Every chip must be the element under each of its points. Returns the misses. */
async function hitMisses(page: Page): Promise<string[]> {
  const out: string[] = []
  const n = await tabs(page).count()
  for (let i = 0; i < n; i++) {
    const chip = tabs(page).nth(i)
    const box = await chip.boundingBox()
    if (!box) { out.push(`${i} no box`); continue }
    const misses = await chip.evaluate((t, pts) => pts.flatMap((p) => {
      const el = document.elementFromPoint(p.x, p.y)
      return el?.closest('.sps-host-tab') === t ? []
        : [`${t.textContent} ${p.name} (${Math.round(p.x)},${Math.round(p.y)}) -> ${el ? `${el.tagName}.${String(el.className)}` : 'null'}`]
    }), chipPoints(box))
    out.push(...misses)
  }
  return out
}

/** Really click every chip at every point; each click must select that chip. */
async function clickMisses(page: Page, between?: () => Promise<void>): Promise<string[]> {
  const out: string[] = []
  const n = await tabs(page).count()
  for (let i = n - 1; i >= 0; i--) {
    for (const name of chipPoints({ x: 0, y: 0, width: 1, height: 1 }).map((p) => p.name)) {
      const target = tabs(page).nth(i)
      // Start from another chip, so every click is a change. Raw mouse clicks
      // throughout: a locator click waits for the chip to hold still, which
      // would hide exactly the motion this test is about.
      const other = tabs(page).nth(i === 0 ? 1 : 0)
      const ob = await other.boundingBox()
      if (!ob) { out.push(`${i} no box for the other chip`); continue }
      await page.mouse.click(ob.x + ob.width / 2, ob.y + ob.height / 2)
      await expect(other).toHaveClass(/\bactive\b/)
      if (between) await between()
      const box = await target.boundingBox()
      if (!box) { out.push(`${i} no box`); continue }
      const p = chipPoints(box).find((q) => q.name === name)!
      await page.mouse.click(p.x, p.y)
      const ok = await target.evaluate((el) => el.classList.contains('active'))
      if (!ok) out.push(`${await target.textContent()} ${name}`)
    }
  }
  return out
}

test('connected and offline hosts: every chip takes a click over its whole area', async ({ page }, info) => {
  const hosts = new Hosts(page)
  await hosts.install([
    connected('bigbox', 'Big build box'), connected('smallbox', 'Small dev box'),
    failed('labmac', 'Lab mac', 'unreachable'), failed('homepc', 'Home pc', 'timeout'),
    connected('cloudbox', 'Cloud'),
  ])
  await injectHosts(page)
  await openPicker(page)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-connected.png`, clip: await picker(page).boundingBox() ?? undefined })
  await expectWholeRow(page)
  expect({ hit: await hitMisses(page), click: await clickMisses(page) }).toEqual({ hit: [], click: [] })
})

// The Mac app's page zoom changes the CSS viewport the page lays out in: zoomed
// out to 80% a 1280px window is 1600 CSS px wide, zoomed in to 125% it is 1024.
test('page zoomed out and in (the Mac app zoom): every chip still takes the click', async ({ page }) => {
  const hosts = new Hosts(page)
  await hosts.install([
    connected('bigbox', 'Big build box'), connected('smallbox', 'Small dev box'),
    failed('labmac', 'Lab mac', 'unreachable'), connecting('homepc', 'Home pc'),
    connected('cloudbox', 'Cloud'),
  ])
  await injectHosts(page)
  await openPicker(page)
  for (const [zoom, width, height] of [['80%', 1600, 1000], ['125%', 1024, 640], ['100%', 1280, 800]] as const) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(300)
    await expectWholeRow(page)
    expect({ hit: await hitMisses(page), click: await clickMisses(page) }, `zoom ${zoom}`).toEqual({ hit: [], click: [] })
  }
})

test('hosts still loading and changing state: every chip still takes the click', async ({ page }) => {
  const hosts = new Hosts(page)
  await hosts.install(HOSTS.map((h) => connecting(h.alias, h.label)))
  const delay = { ms: 0 }
  await injectHosts(page, delay)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openDraft(page)
  // From the open on, the picker's own refetch of the folders and its host
  // status read are slow: the chips are aimed at and clicked while both are
  // still on their way, and a status frame lands before every click.
  delay.ms = 4000
  hosts.hydrateDelayMs = 4000
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()
  await expect(picker(page)).toBeVisible()
  // The tabs come from the page's warm-up answer, already cached.
  for (const h of HOSTS) await expect(picker(page).locator(`.sps-host-tab[data-host="${h.alias}"]`)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => picker(page).evaluate((el) => el.getAnimations().length)).toBe(0)
  const hit = await hitMisses(page)
  let flip = 0
  const click = await clickMisses(page, async () => {
    flip++
    const h = HOSTS[flip % HOSTS.length]
    await hosts.push(flip % 2 ? connected(h.alias, h.label) : failed(h.alias, h.label, 'unreachable'))
  })
  expect({ hit, click }).toEqual({ hit: [], click: [] })
})

test('the picker picks a folder and a host; tier and engine are in More and the model pill', async ({ page }, info) => {
  await injectHosts(page)
  await openPicker(page)
  const p = picker(page)
  await expect(p.getByRole('group', { name: 'Host' })).toBeVisible()
  await expect(p.locator('.sps-host-filter-label')).toHaveText('Host')
  await expect(p.locator('.pin-tier-options, .provider-rail-item, .draft-more-btn')).toHaveCount(0)
  await expect(p.getByRole('button', { name: /^(More|Claude|Codex|Focus|Satellite|Parked)$/ })).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-picker.png`, clip: await p.boundingBox() ?? undefined })
  await page.keyboard.press('Escape')
  await expect(p).toHaveCount(0)

  const panel = page.locator('.main-page-session-column .draft-session-panel')
  const menu = await openDraftSettings(panel)
  for (const tier of ['Focus', 'Satellite', 'Parked']) {
    await expect(menu.locator('.task-kebab-tier-btn', { hasText: tier })).toBeVisible()
  }
  // A fresh draft still lands in Focus.
  await expect(menu.locator('.task-kebab-tier-btn[aria-pressed="true"]')).toHaveText(/Focus/)
  const menuBox = await menu.boundingBox()
  const barBox = await panel.locator('.draft-launch-bar').boundingBox()
  if (menuBox && barBox) {
    const x = Math.min(menuBox.x, barBox.x), y = Math.min(menuBox.y, barBox.y)
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-more.png`, clip: {
      x, y, width: Math.max(menuBox.x + menuBox.width, barBox.x + barBox.width) - x,
      height: Math.max(menuBox.y + menuBox.height, barBox.y + barBox.height) - y,
    } })
  }
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  await expect(await draftEngineButton(page, panel, 'claude')).toHaveAttribute('aria-selected', 'true')
  await expect(await draftEngineButton(page, panel, 'codex')).toBeVisible()
  await closeDraftModelPicker(page)
})
