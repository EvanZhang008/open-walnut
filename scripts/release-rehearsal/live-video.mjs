#!/usr/bin/env bun
/**
 * A real browser on Walnut's Home page through a live update, recorded
 * (live.mjs --live-video starts it; Playwright's chromium, so it runs on Node).
 *
 *   node scripts/release-rehearsal/live-video.mjs --url <base> --out <dir> [--collapsed]
 *
 * It opens the page ONCE and never touches it again: no mouse, no keys, so the
 * page sends no time heartbeat and the server's idle gate sees nobody. Every
 * 200 ms it reads the update notice (`.stale-build-pill`: its words and
 * data-status) and prints a JSON line when that changes, with a still cropped
 * around the notice (<out>/shots/live-<n>-<status>.png). It also prints the
 * page's WebSocket closes and opens (the restart drops the socket, the page
 * reconnects). A line `stop` on stdin ends it: the video is saved as
 * <out>/live-update.webm and, with ffmpeg on PATH, <out>/live-update.mp4.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const url = arg('--url')
const out = path.resolve(arg('--out') ?? '.')
if (!url) { process.stderr.write('usage: live-video.mjs --url <base> --out <dir>\n'); process.exit(2) }
const shots = path.join(out, 'shots')
const raw = path.join(out, 'raw')
for (const d of [out, shots, raw]) fs.mkdirSync(d, { recursive: true })

const SIZE = { width: 1280, height: 800 }
const t0 = Date.now()
const emit = (o) => process.stdout.write(`${JSON.stringify({ t: Date.now() - t0, at: new Date().toISOString(), ...o })}\n`)

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: raw, size: SIZE } })
// The sidebar open, so the notice shows its words (a first visit opens it collapsed: the rail shows only the short label).
// Set before the app reads it, never by a click: an input would be a person's activity to the idle gate.
if (!args.includes('--collapsed')) await context.addInitScript(() => { try { localStorage.setItem('open-walnut-sidebar-collapsed', 'false') } catch { /* no storage */ } })
const page = await context.newPage()
page.on('websocket', (ws) => {
  emit({ ws: 'open', url: ws.url() })
  ws.on('close', () => emit({ ws: 'close', url: ws.url() }))
})
page.on('pageerror', (e) => emit({ pageerror: String(e?.message ?? e).slice(0, 300) }))
page.on('framenavigated', (f) => { if (f === page.mainFrame()) emit({ navigated: f.url() }) })
await page.goto(url, { waitUntil: 'domcontentloaded' })

let stopping = false
readline.createInterface({ input: process.stdin }).on('line', (l) => { if (l.trim() === 'stop') stopping = true })

let last = ''
let n = 0
while (!stopping) {
  let now = null
  try {
    now = await page.evaluate(() => {
      const el = document.querySelector('.stale-build-pill')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { text: el.textContent?.replace(/\s+/g, ' ').trim() ?? '', status: el.getAttribute('data-status'), kind: el.getAttribute('data-update-kind'), box: { x: r.x, y: r.y, w: r.width, h: r.height } }
    })
  } catch { /* the page is between documents */ }
  const key = now ? `${now.kind}|${now.status}|${now.text}` : 'none'
  if (key !== last) {
    last = key
    let still = null
    if (now) {
      n += 1
      still = path.join(shots, `live-${n}-${now.status ?? now.kind ?? 'pill'}.png`)
      // The notice and what is around it, inside the viewport.
      const pad = 60
      const x = Math.max(0, now.box.x - pad)
      const y = Math.max(0, now.box.y - pad * 2)
      const clip = { x, y, width: Math.min(SIZE.width - x, now.box.w + pad * 2 + 200), height: Math.min(SIZE.height - y, now.box.h + pad * 3) }
      await page.screenshot({ path: still, clip }).catch(() => { still = null })
    }
    emit({ pill: now ? { text: now.text, status: now.status, kind: now.kind } : null, still })
  }
  await new Promise((r) => setTimeout(r, 200))
}
await page.screenshot({ path: path.join(shots, 'live-final-page.png') }).catch(() => {})
const video = page.video()
await context.close()
await browser.close()
const webm = path.join(out, 'live-update.webm')
if (video) fs.renameSync(await video.path(), webm)
let mp4 = null
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) {
  const target = path.join(out, 'live-update.mp4')
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:-2', '-movflags', '+faststart', target], { encoding: 'utf8' })
  if (r.status === 0) mp4 = target
  else emit({ ffmpeg: (r.stderr || '').slice(-400) })
}
emit({ done: true, webm, mp4 })
