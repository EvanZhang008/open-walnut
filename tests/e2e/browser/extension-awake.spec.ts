/**
 * What agent-awake.ts relies on, in Chromium itself: a page Chrome counts as hidden (a background
 * tab here, a covered agent window in the person's Chrome) never loads a video made from a file
 * (readyState stays 0) and runs no animation frame; once the debugger sets
 * Emulation.setFocusEmulationEnabled on it, the page counts as on screen, the video loads and frames
 * run. 2026-11-17: a site's video upload in the user's covered agent window
 * sat at "Uploading" for good. If a Chromium update stops this working, this fails first.
 *
 * Chromium is driven over raw CDP, not through Playwright: Playwright turns focus emulation on for
 * every page it drives, so through it a background tab never counts as hidden.
 * The extension's side (an upload on a hidden page sends it and holds the session) is
 * tests/core/browser-control/extension-awake.test.ts.
 */
import { expect, test, chromium } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VIDEO = fs.readFileSync(fileURLToPath(new URL('../../fixtures/media/tiny.webm', import.meta.url))).toString('base64')
/** A video made from a file's bytes (as a site's upload preview does), then one animation frame asked for. */
const PROBE = `(async () => {
  const bytes = Uint8Array.from(atob('${VIDEO}'), (c) => c.charCodeAt(0))
  const v = document.createElement('video')
  v.muted = true
  v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }))
  document.body.append(v)
  const until = Date.now() + 3000
  while (v.readyState === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
  let frame = false
  requestAnimationFrame(() => { frame = true })
  await new Promise((r) => setTimeout(r, 800))
  return { visibility: document.visibilityState, readyState: v.readyState, frame }
})()`

let browser: ChildProcess | undefined
let ws: WebSocket | undefined

test.afterAll(() => { ws?.close(); browser?.kill() })

test('a hidden page loads a video from a file once the debugger sets focus emulation, and only then', async () => {
  test.setTimeout(90_000)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-awake-'))
  browser = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const url = await new Promise<string>((resolve, reject) => {
    let out = ''
    const t = setTimeout(() => reject(new Error(`Chromium did not start: ${out.slice(-500)}`)), 30_000)
    browser!.stderr!.on('data', (d) => { out += d; const m = out.match(/DevTools listening on (ws:\S+)/); if (m) { clearTimeout(t); resolve(m[1]!) } })
  })
  ws = new WebSocket(url)
  await new Promise((r, j) => { ws!.addEventListener('open', r); ws!.addEventListener('error', j) })
  let id = 0
  const waits = new Map<number, (m: { result?: any; error?: unknown }) => void>()
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); waits.get(m.id)?.(m); waits.delete(m.id) })
  const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
    const m = await new Promise<{ result?: any; error?: unknown }>((r) => { const i = ++id; waits.set(i, r); ws!.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })) })
    if (m.error) throw new Error(`${method}: ${JSON.stringify(m.error)}`)
    return m.result
  }
  // A tab behind the one in front, as an agent's tab in a covered window is.
  const probe = async (emulate: boolean) => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', background: true })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    if (emulate) await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
    const r = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true }, sessionId)
    await send('Target.closeTarget', { targetId })
    return r.result.value as { visibility: string; readyState: number; frame: boolean }
  }
  // Without it: hidden, no video, no frame (the bug).
  expect(await probe(false)).toEqual({ visibility: 'hidden', readyState: 0, frame: false })
  // With it: on screen for the page, the video loaded, frames run.
  const woke = await probe(true)
  expect(woke.visibility).toBe('visible')
  expect(woke.readyState).toBeGreaterThan(0)
  expect(woke.frame).toBe(true)
})
