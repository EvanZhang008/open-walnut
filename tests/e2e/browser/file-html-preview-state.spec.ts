/**
 * The HTML preview keeps the reader's place and the page's state when the file is written again.
 *
 * 2026-11-17, the user, on an agent's step-by-step page in the session's Files preview (a list of
 * changes on the left, the one picked on the right, tabs on top) when the agent wrote the file
 * again: "all the progress i have in that page is lost ... like I am in 3rd tab". The preview
 * loads the file again on every write, and the new document started on its first tab, nothing
 * picked, at its top. src/web/preview-state-script.ts now carries the page's state across.
 *
 * Pinned here, each through a real write to disk and the agent's tool event:
 *  - every kind of state the script reads off any page comes back (the window's scroll, a scrolled
 *    box, the selected tab, the picked list item, an open <details>, a checked box, a typed value),
 *    and so do the page's own localStorage and URL hash;
 *  - no frame of the new document is painted at the wrong place first (the page records each
 *    animation frame it is visible in);
 *  - a second write in a row keeps it too;
 *  - a write of the same bytes does not load the page again.
 * The page's own code shows each state's content (a tab's panel, the picked item's details), so
 * the test reads that content, not only the marks.
 */
import { test, expect, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { goToSessionFolder } from './todo-panel-helpers'

test.use({ viewport: { width: 1280, height: 860 } })

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'

type EventWindow = Window & { fileTestSocket?: WebSocket }

async function emitEvent(page: Page, name: string, data: Record<string, unknown>) {
  await page.waitForFunction(() => (window as EventWindow).fileTestSocket?.readyState === 1, null, { timeout: 30_000 })
  await page.evaluate(({ name, data }) => {
    const socket = (window as EventWindow).fileTestSocket
    if (!socket) throw new Error('Missing fixture socket')
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data }) }))
  }, { name, data })
}

/** What an agent's write looks like to the panel: the bytes on disk, then its tool's result. */
async function agentWrites(page: Page, abs: string, content: string) {
  await writeFile(abs, content)
  const data = { sessionId: SESSION_ID, toolUseId: `state-test-${Date.now()}`, toolName: 'Write', input: { file_path: abs } }
  await emitEvent(page, 'session:tool-use', data)
  await emitEvent(page, 'session:tool-result', data)
}

/** The fixture page: tabs drawn by its own script, a list whose picked item shows on the right,
 *  a tall body and a scrolling box, a <details>, a checkbox, a text box, a counter it keeps in
 *  localStorage and a step it keeps in the hash. */
function fixtureHtml(version: number): string {
  const items = Array.from({ length: 8 }, (_, i) => `<li data-i="${i + 1}">Change ${i + 1}</li>`).join('')
  const rows = Array.from({ length: 60 }, (_, i) => `<p>Box row ${i + 1}</p>`).join('')
  const filler = Array.from({ length: 80 }, (_, i) => `<p>Filler paragraph ${i + 1} of version ${version}.</p>`).join('')
  return `<!doctype html>
<html><head><title>State fixture</title>
<style>
  body { font: 15px system-ui; margin: 16px; }
  [role=tab] { padding: 6px 12px; cursor: pointer; border: 1px solid #999; background: #eee; }
  [role=tab][aria-selected=true] { background: #335; color: #fff; }
  .panel { display: none; } .panel.shown { display: block; }
  ul.steps li { cursor: pointer; padding: 3px 6px; } ul.steps li.active { background: #fd8; }
  #box { height: 160px; overflow: auto; border: 1px solid #aaa; }
</style></head>
<body>
<h1 id="title">State fixture version ${version}</h1>
<div role="tablist"><span role="tab" id="t1" aria-selected="true">Tab 1</span><span role="tab" id="t2" aria-selected="false">Tab 2</span><span role="tab" id="t3" aria-selected="false">Tab 3</span></div>
<div class="panel shown" id="p1"><p>Panel one</p></div>
<div class="panel" id="p2"><p>Panel two</p></div>
<div class="panel" id="p3"><ul class="steps">${items}</ul><p id="detail">Details of change 1</p></div>
<details id="more"><summary>More</summary><p>Hidden notes</p></details>
<label><input type="checkbox" id="agree"> Agree</label>
<input type="text" id="note" value="">
<form>${version > 1 ? '<input type="text" name="phone" value="">' : ''}<input type="text" name="email" value=""></form>
<label class="pick"><input type="checkbox" name="opt"> Option</label>
<p>Visits: <span id="visits"></span> Step: <span id="step"></span></p>
<div id="box">${rows}</div>
${filler}
<script>
  var tabs = document.querySelectorAll('[role=tab]');
  tabs.forEach(function (t, i) { t.addEventListener('click', function () {
    tabs.forEach(function (u, j) { u.setAttribute('aria-selected', String(i === j)); document.getElementById('p' + (j + 1)).classList.toggle('shown', i === j); });
  }); });
  document.querySelectorAll('ul.steps li').forEach(function (li) { li.addEventListener('click', function () {
    document.querySelectorAll('ul.steps li').forEach(function (x) { x.classList.toggle('active', x === li); });
    document.getElementById('detail').textContent = 'Details of change ' + li.dataset.i;
  }); });
  document.querySelector('ul.steps li').classList.add('active');
  // Pages that mark a summary or a label from the control's own event: put back, they must not
  // be clicked again (that would close the section, untick the box).
  var more = document.getElementById('more');
  more.addEventListener('toggle', function () { more.querySelector('summary').classList.toggle('open', more.open); });
  var opt = document.querySelector('input[name=opt]');
  opt.addEventListener('change', function () { opt.parentElement.classList.toggle('selected', opt.checked); });
  var n = Number(localStorage.getItem('visits') || '0') + 1;
  localStorage.setItem('visits', String(n));
  document.getElementById('visits').textContent = String(n);
  document.getElementById('step').textContent = location.hash.slice(1) || 'none';
  window.__frames = [];
  var t0 = Date.now();
  (function rec() {
    var sel = document.querySelector('[role=tab][aria-selected=true]');
    window.__frames.push({ shown: getComputedStyle(document.documentElement).opacity !== '0', y: scrollY, tab: sel ? sel.id : '' });
    if (Date.now() - t0 < 2500) requestAnimationFrame(rec);
  })();
</script>
</body></html>
`
}

async function openHtml(page: Page, name: string): Promise<{ frame: FrameLocator; explorer: Locator }> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  await goToSessionFolder(explorer)
  await explorer.locator('.sfe-name', { hasText: name }).click()
  const frame = page.frameLocator('iframe.fv-html-preview')
  await expect(frame.locator('#title')).toContainText('State fixture version 1', { timeout: 15_000 })
  return { frame, explorer }
}

async function scratchHtml(page: Page, name: string): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  const body = await res.json()
  const cwd = (body?.session?.cwd ?? body?.cwd) as string
  const abs = `${cwd}/${name}`
  expect((await page.request.post('/api/files/create', { data: { path: abs } })).status()).toBe(200)
  const put = await page.request.put('/api/file-content', { data: { path: abs, content: fixtureHtml(1) } })
  expect(put.ok(), await put.text()).toBe(true)
  return abs
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname === '/ws') (window as EventWindow).fileTestSocket = this
      }
    }
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
      Object.defineProperty(window.WebSocket, key, { value: NativeWebSocket[key] })
    }
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 45_000 })
})

test('a rewritten HTML file keeps the tab, the picked item, the scroll and the page\'s own state', async ({ page }) => {
  const name = `state-${Date.now()}.html`
  const abs = await scratchHtml(page, name)
  const { frame } = await openHtml(page, name)

  // The reader's moves, with real clicks and typing in the page.
  await frame.locator('#t3').click()
  await frame.locator('ul.steps li', { hasText: 'Change 5' }).click()
  await expect(frame.locator('#detail')).toHaveText('Details of change 5')
  await frame.locator('#more summary').click()
  await frame.locator('#agree').check()
  await frame.locator('#note').fill('my note')
  await frame.locator('input[name=email]').fill('me@example.com')
  await frame.locator('label.pick').click()
  await expect(frame.locator('label.pick')).toHaveClass(/selected/)
  await frame.locator('#title').evaluate(() => { history.replaceState(null, '', '#step-4') })
  await frame.locator('#box').evaluate((el) => { el.scrollTop = 900 })
  await frame.locator('body').evaluate(() => window.scrollTo(0, 1400))
  await expect(frame.locator('#visits')).toHaveText('1')
  await page.waitForTimeout(600)
  const before = await frame.locator('body').evaluate(() => ({ y: window.scrollY, box: document.getElementById('box')!.scrollTop }))
  expect(before.y).toBeGreaterThan(1300)

  for (const version of [2, 3]) {
    await agentWrites(page, abs, fixtureHtml(version))
    await expect(frame.locator('#title')).toContainText(`State fixture version ${version}`, { timeout: 15_000 })
    await expect(frame.locator('#t3')).toHaveAttribute('aria-selected', 'true')
    await expect(frame.locator('#p3')).toBeVisible()
    await expect(frame.locator('ul.steps li.active')).toHaveText('Change 5')
    await expect(frame.locator('#detail')).toHaveText('Details of change 5')
    await expect(frame.locator('#more')).toHaveJSProperty('open', true)
    await expect(frame.locator('#agree')).toBeChecked()
    await expect(frame.locator('#note')).toHaveValue('my note')
    // Found by its name, not its place: the phone field added before it stays empty.
    await expect(frame.locator('input[name=email]')).toHaveValue('me@example.com')
    await expect(frame.locator('input[name=phone]')).toHaveValue('')
    await expect(frame.locator('input[name=opt]')).toBeChecked()
    await expect(frame.locator('label.pick')).toHaveClass(/selected/)
    await expect(frame.locator('#more summary')).toHaveClass(/open/)
    // The page's own storage and hash: its script read them on its first line.
    await expect(frame.locator('#visits')).toHaveText(String(version))
    await expect(frame.locator('#step')).toHaveText('step-4')
    await expect.poll(() => frame.locator('body').evaluate(() => window.scrollY)).toBeGreaterThan(before.y - 5)
    expect(await frame.locator('body').evaluate(() => window.scrollY)).toBeLessThan(before.y + 5)
    expect(await frame.locator('#box').evaluate((el) => el.scrollTop)).toBe(before.box)
    // Never painted at its top or on its first tab first: every frame it was visible in is the
    // restored one.
    await page.waitForTimeout(400)
    const frames = await frame.locator('body').evaluate(() => (window as unknown as { __frames: { shown: boolean; y: number; tab: string }[] }).__frames)
    const wrong = frames.filter((f) => f.shown && (f.tab !== 't3' || Math.abs(f.y - before.y) > 5))
    expect(wrong, JSON.stringify(frames.slice(0, 12))).toEqual([])
  }

  // The same bytes again: the page is not loaded again.
  await frame.locator('body').evaluate(() => { (window as unknown as { __stamp: number }).__stamp = 42 })
  await agentWrites(page, abs, fixtureHtml(3))
  await page.waitForTimeout(3000)
  expect(await frame.locator('body').evaluate(() => (window as unknown as { __stamp?: number }).__stamp)).toBe(42)
})

test('the page\'s state comes back when the file is opened again', async ({ page }) => {
  const name = `state-reopen-${Date.now()}.html`
  await scratchHtml(page, name)
  const { frame, explorer } = await openHtml(page, name)
  await frame.locator('#t2').click()
  await expect(frame.locator('#p2')).toBeVisible()
  await page.waitForTimeout(600)
  // Away to another file and back: a new frame, named with the page's last state.
  await explorer.locator('.sfe-name', { hasText: 'drag-fixture.html' }).click()
  await expect(frame.locator('body')).toContainText('Drag fixture preview', { timeout: 10_000 })
  await explorer.locator('.sfe-name', { hasText: name }).click()
  await expect(frame.locator('#title')).toContainText('State fixture version 1', { timeout: 10_000 })
  await expect(frame.locator('#t2')).toHaveAttribute('aria-selected', 'true')
  await expect(frame.locator('#visits')).toHaveText('2')
  // And the other file got nothing of it.
  await explorer.locator('.sfe-name', { hasText: 'drag-fixture.html' }).click()
  await expect(frame.locator('body')).toContainText('Drag fixture preview', { timeout: 10_000 })
  expect(await frame.locator('body').evaluate(() => window.name)).toBe('')
})
