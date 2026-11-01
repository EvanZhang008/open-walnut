/**
 * The selected-word echo ends whenever the user is no longer on the selection
 * (web/src/utils/selection-echo.ts), on any page: a session chat and a plugin's
 * page alike. Reported 2026-11-01 twice ("after I deselect, the highlight stays",
 * then on a plugin's problem page "it never removes the highlight").
 */
import { expect, type Locator, type Page } from '@playwright/test'

const ECHO = 'walnut-page-selmatch'

export const echoCount = (page: Page) => page.evaluate((n) => (
  (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights?.get(n)?.size ?? 0
), ECHO)
const selected = (page: Page) => page.evaluate(() => getSelection()?.toString() ?? '')

/** The middle of the first copy of `word` inside `scope` that is on screen. */
async function wordPoint(scope: Locator, word: string): Promise<{ x: number; y: number }> {
  return scope.evaluate((el, w) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n as Text).data
      for (let at = text.indexOf(w); at >= 0; at = text.indexOf(w, at + 1)) {
        // A whole word, so a double click selects exactly it.
        if (/\w/.test(text[at - 1] ?? '') || /\w/.test(text[at + w.length] ?? '')) continue
        const r = document.createRange()
        r.setStart(n, at)
        r.setEnd(n, at + w.length)
        const b = r.getBoundingClientRect()
        if (!b.width || b.top < 140 || b.bottom > innerHeight - 60) continue
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
        if (!hit || !el.contains(hit)) continue
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
      }
    }
    throw new Error(`no visible copy of ${w}`)
  }, word)
}

async function selectWord(page: Page, scope: Locator, word: string): Promise<{ x: number; y: number }> {
  const p = await wordPoint(scope, word)
  await page.mouse.dblclick(p.x, p.y)
  await expect.poll(() => selected(page)).toBe(word)
  await expect.poll(() => echoCount(page)).toBeGreaterThan(1)
  return p
}

/**
 * Select `word` (it must show at least twice in `scope`) and check every way off
 * it ends the echo: a click on the word itself, a press on text that cannot be
 * selected, a click into a field, a press into a frame (the browser keeps the
 * page's selection then, unpainted), and that a new selection echoes again. A
 * control that cancels its press to keep the selection (Copy) keeps the echo
 * exactly while the selection stays.
 */
export async function expectEchoEndsOffSelection(page: Page, scope: Locator, word: string): Promise<void> {
  // A frame on the page, as a plugin's embedded app or a preview is.
  await page.evaluate(() => {
    const f = document.createElement('iframe')
    f.id = 'echo-probe-frame'
    f.srcdoc = '<body style="margin:0"><textarea style="width:180px;height:30px"></textarea></body>'
    f.style.cssText = 'position:fixed;bottom:8px;right:8px;width:200px;height:40px;z-index:2147483000;border:1px solid #888;background:#fff'
    document.body.appendChild(f)
  })
  const frame = page.locator('#echo-probe-frame')
  await expect(frame).toBeVisible()
  // A box of text that cannot be selected, a field, and a control that keeps the selection.
  await page.evaluate(() => {
    const box = (id: string, tag: string, left: number) => {
      const el = document.createElement(tag)
      el.id = id
      el.textContent = tag === 'input' ? '' : id
      el.style.cssText = `position:fixed;bottom:8px;left:${left}px;width:110px;height:30px;z-index:2147483000;background:#eee;color:#000`
      document.body.appendChild(el)
      return el
    }
    box('echo-probe-plain', 'div', 8).style.userSelect = 'none'
    box('echo-probe-field', 'input', 130)
    box('echo-probe-keep', 'button', 252).addEventListener('mousedown', (e) => e.preventDefault())
  })
  const centre = async (sel: string) => {
    const b = (await page.locator(sel).boundingBox())!
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }

  // A click on the selected word collapses the selection: the echo goes with it.
  let p = await selectWord(page, scope, word)
  await page.mouse.click(p.x, p.y)
  await expect.poll(() => selected(page)).toBe('')
  await expect.poll(() => echoCount(page)).toBe(0)

  // A press on text that cannot be selected.
  await selectWord(page, scope, word)
  let c = await centre('#echo-probe-plain')
  await page.mouse.click(c.x, c.y)
  await expect.poll(() => echoCount(page)).toBe(0)

  // A click into a field: the user types somewhere else now.
  await selectWord(page, scope, word)
  await page.locator('#echo-probe-field').click()
  await expect.poll(() => echoCount(page)).toBe(0)

  // A control that cancels its press keeps the echo while the selection stays.
  await selectWord(page, scope, word)
  c = await centre('#echo-probe-keep')
  await page.mouse.click(c.x, c.y)
  await page.waitForTimeout(300)
  const kept = (await selected(page)) === word
  expect(await echoCount(page) > 0, `selection ${kept ? 'kept' : 'cleared'} by a press that cancels its mousedown`).toBe(kept)

  // A press into the frame: the page keeps its selection, the user is elsewhere.
  await selectWord(page, scope, word)
  const fb = (await frame.boundingBox())!
  await page.mouse.click(fb.x + 40, fb.y + fb.height / 2)
  await expect.poll(() => echoCount(page)).toBe(0)
  expect(await selected(page)).toBe(word)

  // Back on the page, a new selection echoes again.
  p = await selectWord(page, scope, word)
  await page.mouse.click(p.x, p.y)
  await expect.poll(() => echoCount(page)).toBe(0)
  await page.evaluate(() => {
    for (const id of ['echo-probe-frame', 'echo-probe-plain', 'echo-probe-field', 'echo-probe-keep']) document.getElementById(id)?.remove()
  })
}

/** A word of four letters or more shown at least twice in `scope` (for a page whose text the test does not own). */
export async function repeatedWord(scope: Locator): Promise<string> {
  return scope.evaluate((el) => {
    const counts = new Map<string, number>()
    for (const w of (el as HTMLElement).innerText.match(/\b[A-Za-z]{4,}\b/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1)
    const best = [...counts].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])[0]
    if (!best) throw new Error('no repeated word on the page')
    return best[0]
  })
}
