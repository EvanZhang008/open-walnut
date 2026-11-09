/**
 * A thread card's header row (web/src/components/org/OrgThreads.tsx, styles/org-threads.css): the
 * state, then "Pinned by <node>", "Opened by <node>" and the time. 2026-11-09: in WebKit (the Mac
 * app's engine) the right-hand part overflowed to the left over "Needs you" when the node's name
 * was long, because an end-aligned grid item took its full text width. The pieces must never
 * overlap or leave the card at any width the Org side bar takes (its 300px floor, wider drags, the
 * stacked layout of a narrow window, full screen): the node's name gives way, the state and the
 * time stay whole.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
const made: string[] = []

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

test.afterAll(async ({ request }) => {
  for (const id of made) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

interface Box { x: number; y: number; width: number; height: number }

/** Every piece of every card header, with the box it paints in. */
async function headBoxes(page: Page): Promise<Array<{ id: string; head: Box; pieces: Array<{ name: string; box: Box; text: string }> }>> {
  return page.locator('[data-testid="org-thread"]').evaluateAll((cards) => cards.map((c) => {
    const rect = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
    const head = c.querySelector('[data-testid="org-thread-head"]')!
    const pieces = ['org-thread-state', 'org-thread-pinned', 'org-thread-from', 'org-thread-time']
      .map((name) => ({ name, el: head.querySelector(`[data-testid="${name}"]`) }))
      .filter((p): p is { name: string; el: Element } => !!p.el)
      .map((p) => ({ name: p.name, box: rect(p.el), text: p.el.textContent ?? '' }))
    return { id: c.getAttribute('data-thread-id') ?? '', head: rect(head), pieces }
  }))
}

function expectNoOverlap(cards: Awaited<ReturnType<typeof headBoxes>>, where: string): void {
  expect(cards.length, where).toBeGreaterThan(0)
  for (const c of cards) {
    const { head, pieces } = c
    for (const p of pieces) {
      expect(p.box.width, `${where} ${c.id} ${p.name} is visible`).toBeGreaterThan(0)
      expect(p.box.x, `${where} ${c.id} ${p.name} starts inside the card`).toBeGreaterThanOrEqual(head.x - 0.5)
      expect(p.box.x + p.box.width, `${where} ${c.id} ${p.name} ends inside the card`).toBeLessThanOrEqual(head.x + head.width + 0.5)
    }
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i].box, b = pieces[j].box
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
        expect(overlapX > 0.5 && overlapY > 0.5, `${where} ${c.id}: ${pieces[i].name} "${pieces[i].text}" overlaps ${pieces[j].name} "${pieces[j].text}"`).toBe(false)
      }
    }
    // The state and the time are never cut; the node's name is what gives way.
    for (const name of ['org-thread-state', 'org-thread-time']) {
      expect(pieces.some((p) => p.name === name), `${where} ${c.id} shows ${name}`).toBe(true)
    }
  }
}

test('a card header never overlaps itself, whatever the side bar width or the node name', async ({ page, request }) => {
  const project = `Threads header fit with a really long project name for the node ${STAMP}`
  const work = (await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Header work ${STAMP}`, project, source: 'local' })).task.id
  made.push(work)
  // Two tasks, so the project gets a lead of its own (with one, the task itself answers).
  made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Header review ${STAMP}`, project, source: 'local' })).task.id)
  const node = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: project })).task.id
  made.push(node)
  const { walnutHome } = await discoverBrowserFixture(TEST_PORT)
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
  // Every state his view shows, each with the node's own first post ("Opened by"), one pinned by
  // the node ("Pinned by"), one plain, and the in-progress ones (the line below starts open).
  const thread = (n: string, title: string, state: string, extra: Record<string, unknown> = {}) => ({
    id: `th-00000000e00${n}`, title, titled: true, state, reply: `${title}: the summary`, createdAt: at(90), updatedAt: at(5),
    messages: [], opener: { text: `${title}?`, at: at(90), from: 'node', by: `task:${node}` }, ...extra,
  })
  fs.mkdirSync(`${walnutHome}/org/threads`, { recursive: true })
  fs.writeFileSync(`${walnutHome}/org/threads/${node}.json`, JSON.stringify({ version: 1, taskId: node, threads: [
    thread('1', 'Yearly learning budget', 'needs', { pinned: { at: at(4), by: `task:${node}` } }),
    thread('2', 'Mail: the meetup asks about the talk', 'answered'),
    thread('3', 'Working on the routing', 'working'),
    { id: 'th-00000000e004', title: 'Plain ask', titled: true, state: 'needs', reply: 'Plain: the summary', createdAt: at(30), updatedAt: at(3), messages: [{ id: 'tm-00000000e004', at: at(30), text: 'Plain ask?', via: 'chat' }] },
  ] }))

  await isolateUiPrefs(page)
  await page.addInitScript(() => { localStorage.setItem('open-walnut-view:org.threads.showInProgress', 'true') })
  await page.setViewportSize({ width: 1000, height: 900 })
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(project))
  await detail.getByTestId('org-top-threads').click()
  await expect(page.locator('[data-testid="org-thread"]')).toHaveCount(4, { timeout: 30_000 })
  await expect(page.locator('[data-thread-id="th-00000000e001"]').getByTestId('org-thread-pinned')).toContainText('Pinned by')

  fs.mkdirSync(SHOTS, { recursive: true })
  const browser = test.info().project.name
  // Side bar widths: its 300px floor (27vw of 1000), wider windows, the stacked layout of a narrow one.
  for (const width of [1000, 1280, 1600, 760, 480]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(200)
    if (width === 1000) await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/org-thread-head-${width}-${browser}.png` })
    expectNoOverlap(await headBoxes(page), `viewport ${width}`)
  }
  // A dragged side bar, from its floor up: the handle sets the width the cards take.
  await page.setViewportSize({ width: 1400, height: 900 })
  for (const w of [300, 340, 420, 560]) {
    await page.getByTestId('org-rail').evaluate((e, px) => { (e as HTMLElement).style.width = `${px}px` }, w)
    await page.waitForTimeout(100)
    expectNoOverlap(await headBoxes(page), `side bar ${w}px`)
  }
  // Full screen: the sheet with a margin on every side.
  await page.getByTestId('org-rail-fullscreen').click()
  await expect(page.getByTestId('org-rail')).toHaveAttribute('data-fullscreen', '1')
  expectNoOverlap(await headBoxes(page), 'full screen')
  await page.getByTestId('org-rail-fullscreen').click()
  // The full name is still there to read: on hover.
  await expect(page.locator('[data-thread-id="th-00000000e002"]').getByTestId('org-thread-from')).toHaveAttribute('title', /Opened by .*long project name/)
})
