/**
 * Phone startup through a tunnel with 150 ms of latency (spec 5.1; C48, C49).
 *
 * A browser on another device is the fake tunnel of browser-access-tunnel
 * .spec.ts: a loopback proxy Walnut does not trust. The phone signs in once
 * with a `#pair=` code (the token lands in localStorage), then every request
 * waits 150 ms before it continues. Measured per run:
 *
 *   T_usable  navigationStart -> the first home row (a project or a task) is visible and Menu can be tapped
 *   N_before  /api/ requests started before that moment
 *   depth     serial round trips before it (index.html -> bundle -> prefs -> tasks),
 *             walked back from the first row through the request each link waited on;
 *             apiDepth is the same walk over the document and /api requests only
 *             (a dev build's module graph is the rest of depth). Run on the built
 *             SPA (PW_BUILT_SPA=1 WALNUT_WEB_STATIC_DIR=<dist/web/static>) for the
 *             numbers a phone sees.
 *
 * Cold = a new context (the token copied in), warm = a reload of the same one,
 * 5 runs each; median and worst go to /tmp/mobile-web/boot-latency.json under
 * the label in BOOT_LABEL (default `candidate`). The baseline is this spec run
 * with BOOT_LABEL=baseline against a fixture booted from `git archive 1fe1fd194`
 * (its own server and its own built SPA; the slice's foundation is not a commit
 * of its own, so the baseline holds none of the slice). BOOT_SOURCE is stored
 * with the numbers. When both are in the file and were measured on the same
 * build (both built, or both dev) the comparison is written, and a candidate
 * run fails if it starts more /api requests before the first row than the
 * baseline did. Run it alone (the machine's load moves T_usable; N_before
 * and depth do not depend on it):
 *
 *   PW_WEBKIT=1 BOOT_LABEL=candidate pw.sh <port> webkit tests/e2e/browser/phone-boot-latency.spec.ts
 *
 * C49: none of the desktop-only panes (routines, the calendar agenda, the
 * scratchpad) is fetched before the first row shows.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { test, expect, devices, type Browser, type BrowserContext, type Page } from '@playwright/test'

test.setTimeout(600_000)
test.describe.configure({ mode: 'serial' })

const WORK = '/tmp/mobile-web/boot-latency'
const OUT = '/tmp/mobile-web/boot-latency.json'
const FAKE_TUNNEL = `${WORK}/fake-tunnel.cjs`
const RUNS = Number(process.env.BOOT_RUNS ?? 5)
const LATENCY_MS = 150
const LABEL = process.env.BOOT_LABEL ?? 'candidate'
// Routines, the day agenda's events, the scratchpad (the global notes page).
const DESKTOP_ONLY = [/\/api\/routines/, /\/api\/calendar\/events/, /\/api\/notes\/global/]

const FAKE_TUNNEL_SOURCE = `
const http = require('node:http')
const net = require('node:net')
const walnutPort = Number(process.argv[2])
const pagePort = Number(process.argv[3])
const toWalnut = (url) => url.startsWith('/api') || url.startsWith('/ws')
const server = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: toWalnut(req.url) ? walnutPort : pagePort, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers)
    r.pipe(res)
  })
  up.on('error', () => { res.statusCode = 502; res.end() })
  req.pipe(up)
})
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(toWalnut(req.url) ? walnutPort : pagePort, '127.0.0.1', () => {
    let raw = req.method + ' ' + req.url + ' HTTP/1.1\\r\\n'
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\\r\\n'
    up.write(raw + '\\r\\n')
    if (head.length) up.write(head)
    socket.pipe(up).pipe(socket)
  })
  up.on('error', () => socket.destroy())
  socket.on('error', () => up.destroy())
})
server.listen(0, '127.0.0.1', () => {
  console.log('Public: http://127.0.0.1:' + server.address().port)
  setTimeout(() => console.log('Connected! Forwarding requests'), 300)
})
process.on('SIGTERM', () => process.exit(0))
`

function phoneDevice() {
  const { defaultBrowserType: _engine, ...iphone } = devices['iPhone 15']
  return iphone
}

/** In-page probe: the moment the first row is visible and Menu takes a tap. */
const PROBE = () => {
  // A dev build loads hundreds of modules: the default 250-entry buffer would
  // drop the API requests this spec counts.
  performance.setResourceTimingBufferSize?.(20_000)
  const w = window as unknown as { __usable?: number }
  const tick = () => {
    // The phone home opens on its project rows (folded), or task rows.
    const row = document.querySelector<HTMLElement>('.home-navigation-scroll .todo-group-project-header, .todo-item-title, .main-page-todo [data-task-id]')
    // "Toggle sidebar" is the same button on the baseline commit, before it was named Menu.
    const menu = document.querySelector<HTMLElement>('.phone-topbar button[aria-label="Menu"], .phone-topbar button[aria-label="Toggle sidebar"]')
    if (row && menu && row.getBoundingClientRect().height > 0) {
      const r = menu.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (hit && menu.contains(hit)) { w.__usable = performance.now(); return }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

interface Run { tUsable: number; nBefore: number; depth: number; apiDepth: number; desktopOnly: string[] }

/** Read one boot's numbers from the page's own timing records. */
async function readRun(page: Page): Promise<Run> {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __usable?: number }).__usable ?? 0), { timeout: 120_000 }).toBeGreaterThan(0)
  return page.evaluate((patterns) => {
    const usable = (window as unknown as { __usable: number }).__usable
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const before = res.filter((r) => r.startTime < usable)
    const api = before.filter((r) => new URL(r.name).pathname.startsWith('/api/'))
    // Serial depth, walked back from the first row: the request that ended last before
    // the row showed is the link the screen waited on, the one that ended last before
    // that link started is the link before it, and so on back to the document. Requests
    // that ran beside a link are not links (counting every later start as one made a
    // dev build read ~100 and the API alone ~20, N31).
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
    const chain = (list: PerformanceResourceTiming[]) => {
      const byEnd = [...list].sort((a, b) => b.responseEnd - a.responseEnd)
      let depth = 1
      let cutoff = usable
      for (;;) {
        const link = byEnd.find((r) => r.responseEnd <= cutoff && r.startTime >= nav.responseEnd - 1)
        if (!link) break
        depth += 1
        cutoff = link.startTime
      }
      return depth
    }
    const desktopOnly = api.map((r) => new URL(r.name).pathname).filter((p) => patterns.some((s) => new RegExp(s, 'i').test(p)))
    // depth: every resource (a dev build's module graph included); apiDepth: the document, then /api only.
    return { tUsable: Math.round(usable), nBefore: api.length, depth: chain(before), apiDepth: chain(api), desktopOnly }
  }, DESKTOP_ONLY.map((r) => r.source))
}

async function slowNetwork(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route) => {
    await new Promise((r) => setTimeout(r, LATENCY_MS))
    await route.continue().catch(() => undefined)
  })
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)] ?? 0 }
const summary = (runs: Run[]) => ({
  runs,
  tUsable: { median: median(runs.map((r) => r.tUsable)), worst: Math.max(...runs.map((r) => r.tUsable)) },
  nBefore: { median: median(runs.map((r) => r.nBefore)), worst: Math.max(...runs.map((r) => r.nBefore)) },
  depth: { median: median(runs.map((r) => r.depth)), worst: Math.max(...runs.map((r) => r.depth)) },
  apiDepth: { median: median(runs.map((r) => r.apiDepth)), worst: Math.max(...runs.map((r) => r.apiDepth)) },
})

function record(label: string, data: Record<string, unknown>): { build?: string; warm?: { nBefore: { median: number } } } | undefined {
  mkdirSync('/tmp/mobile-web', { recursive: true })
  const all = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown> : {}
  all[label] = { ...data, at: new Date().toISOString(), latencyMs: LATENCY_MS }
  const base = all.baseline as { build?: string; cold?: { tUsable: { median: number }; nBefore: { median: number } }; warm?: { tUsable: { median: number }; nBefore: { median: number } } } | undefined
  const cand = all.candidate as typeof base
  // A dev build fetches its module graph and starts more requests than a built SPA: only like compares with like.
  if (base?.warm && cand?.warm && base.build === cand.build) {
    all.comparison = {
      warmMedianDeltaMs: cand.warm.tUsable.median - base.warm.tUsable.median,
      warmNBeforeDelta: cand.warm.nBefore.median - base.warm.nBefore.median,
      coldMedianDeltaMs: (cand.cold?.tUsable.median ?? 0) - (base.cold?.tUsable.median ?? 0),
      warmNotSlower: cand.warm.tUsable.median <= base.warm.tUsable.median,
      nBeforeNotMore: cand.warm.nBefore.median <= base.warm.nBefore.median,
    }
  }
  writeFileSync(OUT, JSON.stringify(all, null, 2))
  return base
}

async function startTunnel(page: Page, baseURL: string | undefined): Promise<string> {
  mkdirSync(WORK, { recursive: true })
  writeFileSync(FAKE_TUNNEL, FAKE_TUNNEL_SOURCE)
  const pagePort = new URL(baseURL ?? 'http://localhost:3457').port || '80'
  const put = await page.request.put('/api/config', { data: { expose: {
    enabled: false, provider: 'command',
    command: { command: process.execPath, args: [FAKE_TUNNEL, '{port}', pagePort], url_pattern: 'http://127\\.0\\.0\\.1:\\d+', ready_pattern: 'connected!' },
  } } })
  expect(put.ok()).toBe(true)
  const on = await page.request.put('/api/expose', { data: { enabled: true } })
  expect(on.ok(), await on.text()).toBe(true)
  let url = ''
  await expect.poll(async () => {
    // GET /api/expose answers { status: ExposeStatus, providers, settings }.
    const s = await (await page.request.get('/api/expose')).json() as { status?: { state?: string; url?: string } }
    url = s.status?.state === 'connected' ? s.status.url ?? '' : ''
    return url
  }, { timeout: 60_000 }).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)
  return url.replace(/\/$/, '')
}

/** A phone that signed in through the tunnel once: its storage, to start contexts from. */
async function signedInPhone(browser: Browser, page: Page, tunnelUrl: string): Promise<Awaited<ReturnType<BrowserContext['storageState']>>> {
  const res = await page.request.post('/api/devices/browser-code')
  expect(res.ok()).toBe(true)
  const { code } = await res.json() as { code: string }
  const ctx = await browser.newContext(phoneDevice())
  const phone = await ctx.newPage()
  await phone.goto(`${tunnelUrl}/#pair=${code}`)
  await expect(phone.locator('.phone-topbar')).toBeVisible({ timeout: 90_000 })
  const state = await ctx.storageState()
  await ctx.close()
  return state
}

test('boot through a 150 ms tunnel: cold and warm, 5 runs each (C48), no desktop-only fetch (C49)', async ({ page, browser, baseURL }) => {
  const tunnelUrl = await startTunnel(page, baseURL)
  try {
    const storageState = await signedInPhone(browser, page, tunnelUrl)
    const cold: Run[] = []
    for (let i = 0; i < RUNS; i++) {
      const ctx = await browser.newContext({ ...phoneDevice(), storageState })
      await slowNetwork(ctx)
      await ctx.addInitScript(PROBE)
      const p = await ctx.newPage()
      await p.goto(`${tunnelUrl}/`)
      cold.push(await readRun(p))
      await ctx.close()
    }
    const warm: Run[] = []
    const ctx = await browser.newContext({ ...phoneDevice(), storageState })
    await slowNetwork(ctx)
    await ctx.addInitScript(PROBE)
    const p = await ctx.newPage()
    await p.goto(`${tunnelUrl}/`)
    await readRun(p)
    for (let i = 0; i < RUNS; i++) {
      await p.reload()
      warm.push(await readRun(p))
    }
    await ctx.close()
    const data = { cold: summary(cold), warm: summary(warm), build: process.env.PW_BUILT_SPA === '1' ? 'built' : 'dev', source: process.env.BOOT_SOURCE ?? 'this tree' }
    const base = record(LABEL, data)
    // N_before does not move with the machine's load, so it is the one budget a run can hold (spec 5.1).
    if (LABEL === 'candidate' && base?.warm && base.build === data.build) expect(data.warm.nBefore.median, 'no more API requests before the first row than the baseline').toBeLessThanOrEqual(base.warm.nBefore.median)
    test.info().annotations.push({ type: 'boot-latency', description: JSON.stringify({ cold: data.cold.tUsable, warm: data.warm.tUsable, nBefore: data.warm.nBefore, depth: data.warm.depth, apiDepth: data.warm.apiDepth }) })
    for (const r of [...cold, ...warm]) {
      expect(r.desktopOnly, 'desktop-only fetch before the first row').toEqual([])
      expect(r.nBefore, 'the API requests before the first row were recorded').toBeGreaterThan(0)
    }
  } finally {
    await page.request.put('/api/expose', { data: { enabled: false } }).catch(() => undefined)
    await page.request.put('/api/config', { data: { expose: {} } }).catch(() => undefined)
  }
})
