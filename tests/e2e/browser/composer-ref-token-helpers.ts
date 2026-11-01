/**
 * The composer draws an "@" task pick as a task pill (ComposerRefMirror) while the
 * box stays a plain textarea. Scenario matrix, shared by the Chromium spec and the
 * WebKit spec (the Mac app is a WKWebView):
 *
 *   1. pick: the box holds the readable `@[title]` token, and an overlay draws it
 *      as a pill (one token, the task's id, a dot whose state follows the task);
 *   2. glyph parity: the overlay's text sits EXACTLY on the textarea's own text.
 *      Proven by pixels: the same field is captured with the textarea's text
 *      visible and the overlay hidden, then with the overlay's plain text and the
 *      textarea's hidden; the two images must be the same picture;
 *   3. that parity holds in a draft column and in a running session's column (two
 *      different font sizes), at several column widths, with a token that wraps
 *      across lines, several tokens, newlines, and a box scrolled past its 5-line
 *      cap (the overlay must scroll with the textarea);
 *   4. the caret treats a token as one object: ArrowRight/ArrowLeft step over it, a
 *      click inside snaps to an edge, Backspace after it and Delete before it
 *      remove it whole, and with it gone the overlay unmounts and the textarea's
 *      own text is back;
 *   5. nothing about the message changes: the launch request carries the task tag,
 *      never the `@[…]` token.
 */
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { discoverFixtureRoot, draftComposer, loadHome, openDraftOnCwd, REAL_PANEL } from './draft-helpers'

let rpcSeq = 0

async function newTask(request: APIRequestContext, title: string, projectName: string): Promise<string> {
  const res = await request.post('/api/tasks', {
    data: { title: `${title} (${projectName})`, source: 'local', project: 'Walnut' },
  })
  expect(res.ok(), `create task: ${res.status()}`).toBe(true)
  const body = await res.json() as { task?: { id: string }; id?: string }
  return body.task?.id ?? body.id!
}

async function startRealSession(page: Page, message: string, taskId: string, mode?: string): Promise<void> {
  const reqId = `pw-reftoken-start-${++rpcSeq}`
  await page.evaluate(
    async ({ message, taskId, reqId, mode }) => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('ws failed'))
      })
      ws.send(JSON.stringify({
        type: 'req', id: reqId, method: 'session:start',
        payload: { taskId, message, project: 'Walnut', ...(mode ? { mode } : {}) },
      }))
      await new Promise<void>((resolve) => {
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(ev.data as string)
            if (parsed.type === 'res' && parsed.id === reqId) resolve()
          } catch { /* ignore */ }
        }
        setTimeout(resolve, 5000)
      })
      ws.close()
    },
    { message, taskId, reqId, mode },
  )
}

async function sessionIdsFor(request: APIRequestContext, taskId: string): Promise<Set<string>> {
  const res = await request.get(`/api/sessions/task/${taskId}`)
  if (!res.ok()) return new Set()
  const body = await res.json() as { sessions?: Array<{ claudeSessionId: string }> }
  return new Set((body.sessions ?? []).map((s) => s.claudeSessionId))
}

async function waitForNewSessionId(request: APIRequestContext, taskId: string, before: Set<string>): Promise<string> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const ids = await sessionIdsFor(request, taskId)
    for (const id of ids) if (!before.has(id)) return id
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no new mock session appeared for task ${taskId}`)
}

async function pendingPermissionTool(request: APIRequestContext, sid: string): Promise<string | null> {
  const res = await request.get(`/api/sessions/${sid}`)
  if (!res.ok()) return null
  const body = await res.json() as { session?: { pendingPermission?: { toolName?: string } } }
  return body.session?.pendingPermission?.toolName ?? null
}

/** Type "@<query>" where the caret is and click the palette's row for `rowText`. */
async function pickTask(page: Page, panel: Locator, query: string, rowText: string): Promise<void> {
  await page.keyboard.type(`@${query}`)
  const palette = panel.locator('.mention-palette')
  const row = palette.locator('.mention-row-task').filter({ hasText: rowText })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await expect(palette).toHaveCount(0)
}

interface TokenGeometry {
  value: string
  mirrorText: string
  taRect: { x: number; y: number; width: number; height: number }
  mirrorRect: { x: number; y: number; width: number; height: number }
  taScrollH: number
  mirrorScrollH: number
  taScrollTop: number
  mirrorScrollTop: number
  taFill: string
  tokens: Array<{ id: string; kind: string; cls: string; rects: Array<{ x: number; y: number; width: number; height: number }>; dot: { w: string; bg: string } }>
}

async function geometry(field: Locator): Promise<TokenGeometry> {
  // A scroll event is delivered on the next frame: let it run before reading.
  await field.page().evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  return field.evaluate((root) => {
    const ta = root.querySelector('textarea') as HTMLTextAreaElement
    const mirror = root.querySelector('.chat-input-mirror') as HTMLElement
    const box = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height })
    return {
      value: ta.value,
      mirrorText: (mirror.textContent ?? '').replace(/\u200b/g, ''),
      taRect: box(ta.getBoundingClientRect()),
      mirrorRect: box(mirror.getBoundingClientRect()),
      taScrollH: ta.scrollHeight,
      mirrorScrollH: mirror.scrollHeight,
      taScrollTop: ta.scrollTop,
      mirrorScrollTop: mirror.scrollTop,
      taFill: getComputedStyle(ta).webkitTextFillColor,
      tokens: [...mirror.querySelectorAll<HTMLElement>('.chat-ref-token')].map((t) => {
        const open = t.querySelector('.chat-ref-open') as HTMLElement
        const dot = getComputedStyle(open)
        return {
          id: t.dataset.refId ?? '',
          kind: t.dataset.refKind ?? '',
          cls: t.className,
          rects: [...t.getClientRects()].map(box),
          dot: { w: dot.backgroundImage.includes('radial-gradient') ? 'dot' : 'none', bg: dot.backgroundImage },
        }
      }),
    }
  })
}

/** Caret offset of the box, read straight off the textarea. */
const caretOf = (ta: Locator) => ta.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)

/**
 * Capture `field` three times and compare pixels. A: the textarea's own text
 * visible, the overlay hidden. B: the overlay's plain text (every pill decoration
 * off) over the textarea's hidden text. C: B with the overlay moved 1px sideways,
 * the control that says what a real misalignment looks like in this picture.
 * B must look like A, and nothing like C. (Not byte-equal: a glyph on a
 * quarter-pixel boundary can round to the other side when the same text is drawn
 * as separate fragments, which moves a handful of glyphs by a fraction of a pixel.)
 */
async function pixelParity(page: Page, field: Locator, save: string): Promise<{ diff: number; control: number; total: number; where: string }> {
  await field.evaluate((root) => { (root.querySelector('textarea') as HTMLTextAreaElement).spellcheck = false })
  const style = await page.addStyleTag({ content: '/* parity */' })
  const setCss = (css: string) => style.evaluate((el, css) => { el.textContent = css }, css)
  await setCss(`
    .chat-input-textarea { caret-color: transparent !important; -webkit-text-fill-color: #000 !important; color: #000 !important; }
    .chat-input-mirror { visibility: hidden !important; }`)
  const a = await field.screenshot({ animations: 'disabled', caret: 'hide' })
  const overlayPlain = `
    .chat-input-textarea { caret-color: transparent !important; }
    .chat-input-mirror { color: #000 !important; }
    .chat-ref-token { background: none !important; color: #000 !important; border-radius: 0 !important; }
    .chat-ref-edge { color: #000 !important; }
    .chat-ref-open { background: none !important; }`
  await setCss(overlayPlain)
  const b = await field.screenshot({ animations: 'disabled', caret: 'hide' })
  await setCss(`${overlayPlain} .chat-input-mirror { transform: translateX(1px) !important; }`)
  const c = await field.screenshot({ animations: 'disabled', caret: 'hide' })
  await style.evaluate((el) => el.remove())
  const out = await page.evaluate(async ({ a, b, c }) => {
    const decode = async (b64: string) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const cv = document.createElement('canvas')
      cv.width = bmp.width
      cv.height = bmp.height
      const ctx = cv.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      return ctx.getImageData(0, 0, bmp.width, bmp.height)
    }
    const [ia, ib, ic] = [await decode(a), await decode(b), await decode(c)]
    if (ia.width !== ib.width || ia.height !== ib.height || ia.width !== ic.width || ia.height !== ic.height) {
      return { diff: -1, control: -1, total: ia.width * ia.height, where: 'size differs', png: '' }
    }
    const differs = (x: ImageData, y: ImageData, i: number) =>
      Math.abs(x.data[i] - y.data[i]) > 40 || Math.abs(x.data[i + 1] - y.data[i + 1]) > 40 || Math.abs(x.data[i + 2] - y.data[i + 2]) > 40
    let diff = 0
    let control = 0
    let [x0, x1, y0, y1] = [ia.width, -1, ia.height, -1]
    const vis = document.createElement('canvas')
    vis.width = ia.width
    vis.height = ia.height
    const vctx = vis.getContext('2d')!
    const vd = vctx.createImageData(ia.width, ia.height)
    for (let i = 0; i < ia.data.length; i += 4) {
      const bad = differs(ia, ib, i)
      if (differs(ia, ic, i)) control++
      // Red where A and B differ, A faded elsewhere.
      vd.data[i] = bad ? 255 : 255 - (255 - ia.data[i]) / 3
      vd.data[i + 1] = bad ? 0 : 255 - (255 - ia.data[i + 1]) / 3
      vd.data[i + 2] = bad ? 0 : 255 - (255 - ia.data[i + 2]) / 3
      vd.data[i + 3] = 255
      if (bad) {
        diff++
        const px = (i / 4) % ia.width
        const py = Math.floor(i / 4 / ia.width)
        if (px < x0) x0 = px
        if (px > x1) x1 = px
        if (py < y0) y0 = py
        if (py > y1) y1 = py
      }
    }
    vctx.putImageData(vd, 0, 0)
    return { diff, control, total: ia.width * ia.height, where: diff ? `x ${x0}-${x1}, y ${y0}-${y1}` : '', png: vis.toDataURL('image/png').split(',')[1] }
  }, { a: a.toString('base64'), b: b.toString('base64'), c: c.toString('base64') })
  if (out.diff !== 0) {
    await fs.writeFile(`${save}-a-textarea.png`, a)
    await fs.writeFile(`${save}-b-overlay.png`, b)
    if (out.png) await fs.writeFile(`${save}-diff.png`, Buffer.from(out.png, 'base64'))
  }
  return out
}

/** The overlay sits on the textarea: same box, same wrap, same scroll, same words. */
async function expectOverlayOnTextarea(field: Locator, why: string): Promise<TokenGeometry> {
  const g = await geometry(field)
  expect.soft(g.mirrorText, `${why}: overlay repeats the box text`).toBe(g.value)
  expect.soft(g.mirrorRect.x, `${why}: x`).toBeCloseTo(g.taRect.x, 0)
  expect.soft(g.mirrorRect.y, `${why}: y`).toBeCloseTo(g.taRect.y, 0)
  expect.soft(g.mirrorRect.width, `${why}: width`).toBeCloseTo(g.taRect.width, 0)
  expect.soft(g.mirrorRect.height, `${why}: height`).toBeCloseTo(g.taRect.height, 0)
  expect.soft(g.mirrorScrollH, `${why}: the same text wraps to the same height`).toBe(g.taScrollH)
  expect.soft(g.mirrorScrollTop, `${why}: scrolled together`).toBeCloseTo(g.taScrollTop, 0)
  expect.soft(g.taFill, `${why}: the textarea's own text is hidden`).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  return g
}

async function expectPixelParity(page: Page, field: Locator, why: string, shots: string): Promise<void> {
  const { diff, control, total, where } = await pixelParity(page, field, `${shots}/parity-${why.replace(/[^a-z0-9]+/gi, '-')}`)
  const note = `${why}: overlay vs textarea glyph pixels differ in ${diff} of ${total} (${where}); a 1px slip would differ in ${control}`
  // The picture has text in it, so the control sees it.
  expect.soft(control, `${note}: the control sees nothing`).toBeGreaterThan(50)
  // The overlay is the same picture, up to a few glyphs rounding to the other
  // side of a quarter pixel: far below what a 1px slip costs.
  expect.soft(diff, note).toBeGreaterThanOrEqual(0)
  expect.soft(diff, note).toBeLessThanOrEqual(Math.max(60, control * 0.2))
}

export async function runRefTokenMatrix(page: Page, request: APIRequestContext, engine: string): Promise<void> {
  const tag = `pw-pill-${Date.now().toString(36)}`
  const shots = `/tmp/wn-ref-pill/${engine}`
  await fs.mkdir(shots, { recursive: true })

  // A long title (it must wrap inside a narrow column), one task that never ran
  // (idle dot) and one whose session parks on a permission prompt (waiting dot).
  const longTitle = `${tag} Nightly digest - Monitor the team channel with an agent loop · Review Queues`
  const idleTask = await newTask(request, longTitle, engine)
  const shortTask = await newTask(request, `${tag} short`, engine)
  const waitingTask = await newTask(request, `${tag} parked`, engine)
  await loadHome(page)
  const before = await sessionIdsFor(request, waitingTask)
  await startRealSession(page, 'status-permission-test:Bash', waitingTask, 'default')
  const waitingSid = await waitForNewSessionId(request, waitingTask, before)
  await expect.poll(() => pendingPermissionTool(request, waitingSid), { timeout: 30_000 }).toBe('Bash')

  const fixtureRoot = await discoverFixtureRoot()
  // A narrow column, so the long title wraps; wider ones come later.
  await page.setViewportSize({ width: 1000, height: 1000 })
  await loadHome(page)
  const panel = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const input = draftComposer(page)
  const field = panel.locator('.chat-input-field')
  await input.click()

  // 1. Pick: the box holds the readable token, the overlay draws the pill.
  await expect(panel.locator('.chat-input-mirror')).toHaveCount(0)
  await page.keyboard.type('please read ')
  await pickTask(page, panel, tag, `${tag} Nightly digest`)
  const label = `${longTitle} (${engine})`
  await expect(input).toHaveValue(`please read @[${label}] `)
  await expect(panel.locator('.chat-input-mirror')).toHaveCount(1)
  let g = await expectOverlayOnTextarea(field, 'draft, one long token')
  expect(g.tokens).toHaveLength(1)
  expect(g.tokens[0].id).toBe(idleTask)
  expect(g.tokens[0].kind).toBe('task')
  expect(g.tokens[0].cls).toContain('is-idle')
  expect.soft(g.tokens[0].dot.w, 'the status dot is drawn').toBe('dot')
  // The long title wrapped: the pill is more than one line fragment, all inside the box.
  expect.soft(g.tokens[0].rects.length, 'a long token wraps across lines').toBeGreaterThan(1)
  for (const r of g.tokens[0].rects) {
    expect.soft(r.x).toBeGreaterThanOrEqual(g.taRect.x - 1)
    expect.soft(r.x + r.width).toBeLessThanOrEqual(g.taRect.x + g.taRect.width + 1)
  }
  await expectPixelParity(page, field, 'draft, one long token', shots)
  await panel.locator('.chat-input-box').screenshot({ path: `${shots}/01-draft-long-token-wraps.png` })

  // Typing goes on after the token, in the same sentence.
  await page.keyboard.type('and then the parked one ')
  await pickTask(page, panel, tag, `${tag} parked`)
  await page.keyboard.type('plus ')
  await pickTask(page, panel, tag, `${tag} short`)
  await page.keyboard.type('done')
  g = await expectOverlayOnTextarea(field, 'draft, three tokens')
  expect(g.tokens.map((t) => t.id)).toEqual([idleTask, waitingTask, shortTask])
  expect(g.tokens[1].cls, 'a task parked on a prompt wears the waiting dot').toContain('is-waiting')
  expect(g.tokens[2].cls).toContain('is-idle')
  await expectPixelParity(page, field, 'draft, three tokens', shots)
  await panel.locator('.chat-input-box').screenshot({ path: `${shots}/02-draft-three-tokens.png` })

  // 2. Other column widths re-wrap the same text; the overlay must follow each.
  for (const width of [1600, 760]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect(panel.locator('.chat-input-mirror')).toHaveCount(1)
    await expectOverlayOnTextarea(field, `draft at ${width}px`)
    await expectPixelParity(page, field, `draft at ${width}px`, shots)
  }
  await page.setViewportSize({ width: 1000, height: 1000 })

  // 3. Newlines, and a box scrolled past its five-line cap.
  for (let i = 0; i < 7; i++) {
    await page.keyboard.insertText(`\nline ${i + 1} of a longer note`)
  }
  await input.evaluate((el) => {
    const ta = el as HTMLTextAreaElement
    ta.setSelectionRange(ta.value.length, ta.value.length)
    ta.scrollTop = ta.scrollHeight
  })
  g = await expectOverlayOnTextarea(field, 'draft, tall box')
  expect(g.taScrollH, 'the box is taller than its cap, so it scrolls').toBeGreaterThan(g.taRect.height)
  expect(g.taScrollTop, 'and it is scrolled').toBeGreaterThan(0)
  await expectPixelParity(page, field, 'draft, tall box scrolled to the end', shots)
  await input.evaluate((el) => { (el as HTMLTextAreaElement).scrollTop = 0 })
  await expectOverlayOnTextarea(field, 'draft, tall box scrolled back up')
  await expectPixelParity(page, field, 'draft, tall box scrolled to the top', shots)

  // 4. The caret treats a token as one object. Start from a clean box.
  await input.evaluate((el) => { (el as HTMLTextAreaElement).select() })
  await page.keyboard.press('Backspace')
  await expect(panel.locator('.chat-input-mirror')).toHaveCount(0)
  await page.keyboard.type('a ')
  await pickTask(page, panel, tag, `${tag} short`)
  await page.keyboard.type('b')
  const token = `@[${tag} short (${engine})]`
  await expect(input).toHaveValue(`a ${token} b`)
  const start = 2
  const end = start + token.length
  await input.evaluate((el, at) => { (el as HTMLTextAreaElement).setSelectionRange(at, at) }, start)
  await page.keyboard.press('ArrowRight')
  expect(await caretOf(input), 'ArrowRight steps over the whole token').toBe(end)
  await page.keyboard.press('ArrowLeft')
  expect(await caretOf(input), 'ArrowLeft steps back over it').toBe(start)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  expect(await caretOf(input), 'the next ArrowRight moves one character').toBe(end + 1)

  // A click in the middle of the pill lands on an edge, never inside the title.
  g = await geometry(field)
  const r = g.tokens[0].rects[0]
  const nearStart = await (async () => {
    await page.mouse.click(r.x + r.width * 0.25, r.y + r.height / 2)
    return caretOf(input)
  })()
  expect([start, end], `click at a quarter of the pill put the caret at ${nearStart}`).toContain(nearStart)
  await page.mouse.click(r.x + r.width * 0.75, r.y + r.height / 2)
  const nearEnd = await caretOf(input)
  expect([start, end], `click at three quarters of the pill put the caret at ${nearEnd}`).toContain(nearEnd)
  expect(nearEnd, 'the right part snaps right').toBe(end)
  expect(nearStart, 'the left part snaps left').toBe(start)

  // Backspace right after it removes it whole; the textarea's own text is back.
  await input.evaluate((el, at) => { (el as HTMLTextAreaElement).setSelectionRange(at, at) }, end)
  await page.keyboard.press('Backspace')
  await expect(input).toHaveValue('a b')
  await expect(panel.locator('.chat-input-mirror')).toHaveCount(0)
  expect(await input.evaluate((el) => getComputedStyle(el).webkitTextFillColor)).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)

  // Delete right before one removes it whole too.
  await input.evaluate((el) => { (el as HTMLTextAreaElement).setSelectionRange(2, 2) })
  await pickTask(page, panel, tag, `${tag} short`)
  await expect(input).toHaveValue(`a ${token} b`)
  await input.evaluate((el, at) => { (el as HTMLTextAreaElement).setSelectionRange(at, at) }, start)
  await page.keyboard.press('Delete')
  await expect(input).toHaveValue('a b')
  await expect(panel.locator('.chat-input-mirror')).toHaveCount(0)

  // Editing the words of a token turns it back into plain text: no pill, no stale overlay.
  await input.evaluate((el) => { (el as HTMLTextAreaElement).setSelectionRange(2, 2) })
  await pickTask(page, panel, tag, `${tag} short`)
  await expect(panel.locator('.chat-input-mirror')).toHaveCount(1)
  await input.fill(`a @[${tag} shXort (${engine})] b`)
  await expect(panel.locator('.chat-input-mirror')).toHaveCount(0)

  // 5. The launch carries the task tag, never the token.
  await input.evaluate((el) => { (el as HTMLTextAreaElement).select() })
  await page.keyboard.press('Backspace')
  await page.keyboard.type('please read ')
  await pickTask(page, panel, tag, `${tag} short`)
  await page.keyboard.type('echo-input')
  await expectOverlayOnTextarea(field, 'draft before launch')
  const launch = page.waitForRequest((req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start')
  const launched = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/sessions/quick-start')
  await page.keyboard.press('Enter')
  const body = (await launch).postData() ?? ''
  expect(body).toContain(`<task-ref id=\\"${shortTask}\\"`)
  expect(body).not.toContain('@[')
  const { taskId } = await (await launched).json() as { taskId: string }
  const sid = await waitForNewSessionId(request, taskId, new Set())

  // In the running session's column (smaller type, narrower box) the same.
  const session = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(session).toBeVisible({ timeout: 30_000 })
  const sessionInput = session.locator('.chat-input-textarea')
  const sessionField = session.locator('.chat-input-field')
  await sessionInput.click()
  await page.keyboard.type('and ')
  await pickTask(page, session, tag, `${tag} Nightly digest`)
  await page.keyboard.type('too')
  await expect(session.locator('.chat-input-mirror')).toHaveCount(1)
  g = await expectOverlayOnTextarea(sessionField, 'session column, long token')
  expect(g.tokens[0].id).toBe(idleTask)
  await expectPixelParity(page, sessionField, 'session column, long token', shots)
  await session.locator('.chat-input-box').screenshot({ path: `${shots}/03-session-column-long-token.png` })
}
