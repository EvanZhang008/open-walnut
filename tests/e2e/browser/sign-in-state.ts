/**
 * The fixture server's sign-in state: its one tunnel and the browsers signed in with a code.
 *
 * The tunnel is the built-in `command` provider running a fake tunnel: an HTTP proxy on its
 * own loopback port that sends /api and /ws to Walnut's tunnel port (which this server does
 * not trust) and the page to the fixture, with no proxy header. A browser that opens its
 * address is a phone on another network.
 *
 * Both are one per server, so every spec that calls these helpers runs one at a time with
 * the others (one-at-a-time-specs.ts, SIGN_IN_CALL), and a spec that writes that state any
 * other way fails tests/web/browser-spec-isolation-guard.test.ts. A test still names its
 * own phone by what its sign-in answered (signInWithCode), never "the newest browser".
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { putExactSection } from './config-section-helpers'

const WORK = '/tmp/walnut-fake-tunnel'
/** The fake tunnel's script: `node fake-tunnel.cjs <walnut tunnel port> <page port>`. */
export const FAKE_TUNNEL = `${WORK}/fake-tunnel.cjs`

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

/** Write the script whole (a rename), so a tunnel starting now never reads half of it. */
function writeFakeTunnel(): void {
  mkdirSync(WORK, { recursive: true })
  const part = `${FAKE_TUNNEL}.${process.pid}.part`
  writeFileSync(part, FAKE_TUNNEL_SOURCE)
  renameSync(part, FAKE_TUNNEL)
}

function pagePort(baseURL: string | undefined): string {
  return new URL(baseURL ?? 'http://localhost:3457').port || '80'
}

/** Point the server's tunnel at the fake one, left off (`command`: another program to run instead). */
export async function useServerTunnel(request: APIRequestContext, baseURL: string | undefined, command = process.execPath): Promise<void> {
  writeFakeTunnel()
  const res = await request.put('/api/config', { data: { expose: {
    enabled: false,
    provider: 'command',
    command: { command, args: [FAKE_TUNNEL, '{port}', pagePort(baseURL)], url_pattern: 'http://127\\.0\\.0\\.1:\\d+', ready_pattern: 'connected!' },
  } } })
  expect(res.ok(), await res.text()).toBe(true)
}

/** Turn the fake tunnel on and wait until it connects: its public address, no trailing slash. */
export async function startServerTunnel(request: APIRequestContext, baseURL: string | undefined): Promise<string> {
  await useServerTunnel(request, baseURL)
  const on = await request.put('/api/expose', { data: { enabled: true, provider: 'command' } })
  expect(on.ok(), await on.text()).toBe(true)
  let url = ''
  await expect.poll(async () => {
    // GET /api/expose answers { status: ExposeStatus, providers, settings }.
    const body = await (await request.get('/api/expose')).json() as { status?: { state?: string; url?: string } }
    url = body.status?.state === 'connected' ? body.status.url ?? '' : ''
    return url
  }, { timeout: 60_000 }).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)
  return url.replace(/\/+$/, '')
}

/** Turn the tunnel off and leave config.yaml's `expose` empty, as the fixture started. */
export async function endServerTunnel(request: APIRequestContext): Promise<void> {
  await request.put('/api/expose', { data: { enabled: false } }).catch(() => {})
  await putExactSection(request, 'expose', {}).catch(() => {})
}

/** A one-time browser sign-in code, minted by the computer (and its `#pair=` link when there is a tunnel). */
export async function mintBrowserCode(request: APIRequestContext): Promise<{ code: string; link?: string }> {
  const res = await request.post('/api/devices/browser-code')
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

/**
 * Type `code` on the sign-in page `phone` shows and sign in. Answers the name the server gave
 * this sign-in (browser-<6 hex>), as the server names this phone's own token (GET /api/v1/me):
 * another test's browser can sign in at any moment, so the newest one on the list is not
 * always this one. (The exchange's own answer is no use here: the page boots the console at
 * once, and Chromium drops that answer's body before a test can read it.)
 */
export async function signInWithCode(phone: Page, code: string, timeout = 30_000): Promise<string> {
  await phone.getByTestId('unpaired-code-input').fill(code)
  await phone.getByTestId('unpaired-code-submit').click()
  await expect(phone.getByTestId('unpaired-notice')).toHaveCount(0, { timeout })
  let name = ''
  // Polled: right after another test's refused tokens, the tunnel's address is answered 429 a while.
  await expect.poll(async () => {
    name = await phone.evaluate(async () => {
      const res = await fetch('/api/v1/me', { cache: 'no-store' })
      return res.ok ? ((await res.json()) as { device?: { name?: string } }).device?.name ?? '' : ''
    }).catch(() => '')
    return name
  }, { timeout: 90_000, intervals: [1_000, 3_000] }).toMatch(/^browser-[0-9a-f]{6}$/)
  return name
}

/**
 * The server rate-limits refused tokens per address (10 a minute), and every
 * tunnel client shares the tunnel's address: right after another test's
 * refusals, a fresh sign-in is answered 429 until the minute is over. Wait
 * that out, then start the console again with nothing failed.
 */
export async function settleSignedIn(phone: Page) {
  let limited = false
  await expect.poll(async () => {
    const status = await phone.evaluate(async () => (await fetch('/api/tasks', { cache: 'no-store' })).status).catch(() => 0)
    if (status === 429) limited = true
    return status
  }, { timeout: 90_000, intervals: [3_000] }).toBe(200)
  if (limited) {
    await phone.reload()
    await expect(phone.locator('.app-shell').first()).toBeVisible({ timeout: 60_000 })
  }
}
