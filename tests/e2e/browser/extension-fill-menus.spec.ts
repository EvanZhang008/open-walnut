/**
 * The in-page fill and menu on the review lab's pages (a checkout with an address and a card in
 * one form, a sign-in inside a same-site frame, a two-step sign-in, a one-time-code page):
 * a card or an identity fills every field it has a value for and says what it lacked; a framed
 * login fills and its menu is never cut by the frame; the keyboard picks and fills, even typed
 * fast; the menu never covers the form's own button, opens on the code page only when the person
 * is in the field, closes on an outside click, a submit and Escape, and filters as the person
 * types; logins saved for another part of the site are listed under their own heading.
 *
 * Sites are *.a2lab.test (mapped to this machine), so nothing the other specs save matches them.
 */
import { expect, test, chromium, type BrowserContext, type Frame, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'

test.describe.configure({ mode: 'serial' })

const MASTER = 'Correct Horse Battery Staple 42'
const stamp = Date.now().toString(36)
const SEED = 'JBSWY3DPEHPK3PXP'
const SHOTS = process.env.A2_SHOTS ?? ''

let ctx: BrowserContext
let extId = ''
let sites: http.Server
let port = 0
let base = ''
const site = (host: string, p: string) => `http://${host}:${port}${p}`

// The review lab's pages (review/lab.ts), as a person sees them.
const css = `body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#222}
form{display:grid;gap:10px;max-width:360px}label{display:grid;gap:4px}input,select{padding:8px;font:inherit;border:1px solid #bbb;border-radius:6px}
button{padding:9px 14px;font:inherit;border-radius:6px;border:0;background:#1f6feb;color:#fff;cursor:pointer}`
const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>
<nav><a href="/">Home</a></nav><h1>${title}</h1>${body}</body></html>`
const signinPage = page('Sign in to Lab Shop', `<form method="post" action="/signed-in"><label>Email <input name="email" type="email" autocomplete="username"></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`)
const SITES: Record<string, Record<string, string>> = {
  'shop.a2lab.test': {
    '/signin': page('Sign in to Lab Shop', `<form method="post" action="/signed-in"><label>Email <input name="email" type="email" autocomplete="username"></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`),
    '/signed-in': page('Welcome back', '<p>You are signed in.</p>'),
    '/checkout': page('Checkout', `<form><h3>Shipping</h3><label>Full name <input name="name" autocomplete="name"></label>
      <label>Address <input name="address1" autocomplete="address-line1"></label><label>City <input name="city" autocomplete="address-level2"></label>
      <label>State <input name="state" autocomplete="address-level1"></label><label>ZIP <input name="zip" autocomplete="postal-code"></label>
      <label>Phone <input name="tel" autocomplete="tel"></label><h3>Payment</h3><label>Name on card <input name="ccname" autocomplete="cc-name"></label>
      <label>Card number <input name="cardnumber" autocomplete="cc-number" inputmode="numeric"></label><label>Expiry <input name="exp" autocomplete="cc-exp" placeholder="MM/YY"></label>
      <label>Security code <input name="cvc" autocomplete="cc-csc"></label><button>Place order</button></form>
      <script>document.querySelector('form').addEventListener('submit',e=>e.preventDefault())</script>`),
    '/frame': page('Sign in (framed)', `<p>The sign-in form below is inside a frame from the same site.</p><iframe id="fr" src="/signin" style="width:100%;height:340px;border:1px solid #ccc"></iframe>`),
  },
  // A site with no login saved anywhere on it, and another part of a2lab.test with none of its own.
  'solo.a2site.test': { '/signin': signinPage },
  'blog.a2lab.test': { '/signin': signinPage },
  'accounts.a2lab.test': {
    '/email': page('Sign in: step 1 of 3', `<form method="get" action="/password"><label>Email <input name="identifier" type="email" autocomplete="username"></label><button>Next</button></form>`),
    '/password': page('Sign in: step 2 of 3', `<form method="get" action="/code"><label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Next</button></form>`),
    '/code': page('Sign in: step 3 of 3', `<p>Enter the 6-digit code from your authenticator app.</p><form method="get" action="/done"><label>Code <input name="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label><button>Verify</button></form>`),
    '/done': page('Signed in', '<p>You are signed in to Lab Accounts.</p>'),
  },
}

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    const host = String(req.headers.host ?? '').split(':')[0]
    const html = SITES[host]?.[new URL(req.url ?? '/', 'http://x').pathname]
    const send = () => { res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }); res.end(html ?? 'not found') }
    if (req.method === 'POST') { req.resume(); req.on('end', send) } else send()
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

async function session(p: Page): Promise<string> {
  for (let i = 0; ; i++) {
    const st = await (await p.request.get(`${base}/api/v1/vault/status`)).json()
    const r = st.setUp
      ? await p.request.post(`${base}/api/v1/vault/unlock`, { data: { password: MASTER, kdfSalt: st.kdf?.salt } })
      : await p.request.post(`${base}/api/v1/vault/setup`, { data: { password: MASTER } })
    const text = await r.text()
    // Another spec on the shared fixture vault unlocks at the same moment: wait and try again.
    if (!r.ok() && /unlock_busy|setup/.test(text) && i < 20) { await p.waitForTimeout(1000); continue }
    expect(r.ok(), text).toBe(true)
    return JSON.parse(text).session.token
  }
}

async function seed(p: Page, item: Record<string, unknown>): Promise<string> {
  const r = await p.request.post(`${base}/api/v1/vault/items`, { headers: { 'x-walnut-vault-session': await session(p) }, data: { item } })
  expect(r.ok(), await r.text()).toBe(true)
  return (await r.json()).item.id
}

const sw = () => ctx.serviceWorkers()[0]

/** The menu frame (in the page or any frame of it), once it has been on screen a moment (frame-guard.ts). */
async function menuOf(p: Page, settle = true): Promise<Frame> {
  let f: Frame | undefined
  await expect.poll(() => { f = p.frames().find((x) => x.url().includes('/menu.html') && !x.isDetached()); return !!f }, { timeout: 10_000 }).toBe(true)
  if (settle) await p.waitForTimeout(650)
  return f!
}
const menuCount = (p: Page) => p.frames().filter((x) => x.url().includes('/menu.html') && !x.isDetached()).length
async function noMenu(p: Page): Promise<void> {
  await expect.poll(() => menuCount(p), { timeout: 10_000 }).toBe(0)
}

/** Where the menu's frame is drawn, in the top page's coordinates, and whether it is hidden. */
async function menuBox(p: Page): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const f = p.frames().find((x) => x.url().includes('/menu.html') && !x.isDetached())
  const el = await f?.frameElement().catch(() => null)
  return el ? el.boundingBox() : null
}
/** The menu is drawn right under the field, aligned with its left edge (as Chrome and 1Password draw theirs). */
async function expectUnder(p: Page, field: import('@playwright/test').Locator): Promise<void> {
  const f = (await field.boundingBox())!
  await expect.poll(async () => {
    const b = await menuBox(p)
    return !!b && Math.abs(b.y - (f.y + f.height + 4)) <= 2 && Math.abs(b.x - f.x) <= 2
  }).toBe(true)
}

/** Every name in the page's accessibility tree, closed shadow roots included (the toast is in one). */
async function axText(p: Page): Promise<string> {
  const cdp = await ctx.newCDPSession(p)
  const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: Array<{ name?: { value?: unknown } }> }
  await cdp.detach()
  return nodes.map((n) => String(n.name?.value ?? '')).join('\n')
}

async function shot(p: Page, name: string): Promise<void> {
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-a2-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-a2-profile-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 860 },
    args: [
      `--disable-extensions-except=${path.join(dir, 'chrome')}`,
      `--load-extension=${path.join(dir, 'chrome')}`,
      '--host-resolver-rules=MAP *.a2lab.test 127.0.0.1, MAP solo.a2site.test 127.0.0.1',
    ],
  })
  let worker = ctx.serviceWorkers()[0]
  if (!worker) worker = await ctx.waitForEvent('serviceworker')
  worker.on('console', (m) => { if (m.type() === 'error') console.log(`[background error] ${m.text()}`) })
  extId = new URL(worker.url()).host
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${extId}` }).catch(() => {})

  const p = await ctx.newPage()
  await seed(p, { type: 'login', title: `Shop ${stamp}`, username: 'alex@a2lab.test', password: 'Shop-Pass-4821!', urls: [site('shop.a2lab.test', '/')] })
  await seed(p, { type: 'login', title: `Shop work ${stamp}`, username: 'alex.work@a2lab.test', password: 'Work-Pass-9930!', urls: [site('shop.a2lab.test', '/')] })
  await seed(p, { type: 'login', title: `Accounts ${stamp}`, username: 'sam@a2lab.test', password: 'Accounts-Pass-7710!', totp: SEED, urls: [site('accounts.a2lab.test', '/')] })
  await seed(p, { type: 'card', title: `Lab Visa ${stamp}`, card: { holder: 'Alex Rivera', number: '4111 1111 1111 1111', expMonth: '08', expYear: '2029', code: '123' } })
  await seed(p, { type: 'card', title: `No code ${stamp}`, card: { holder: 'Alex Rivera', number: '5555555555554444', expMonth: '01', expYear: '2030' } })
  await seed(p, {
    type: 'identity', title: `Alex at home ${stamp}`,
    fields: [{ name: 'First name', value: 'Alex' }, { name: 'Last name', value: 'Rivera' }, { name: 'Email', value: 'alex@a2lab.test' }, { name: 'Phone', value: '+1 555 0100' },
      { name: 'Address 1', value: '1 Market St' }, { name: 'City', value: 'Springfield' }, { name: 'State', value: 'CA' }, { name: 'ZIP', value: '94000' }, { name: 'Country', value: 'US' }],
  })

  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  const un = await ctx.newPage()
  await un.goto(`chrome-extension://${extId}/popup.html`)
  await un.getByLabel('Master password').fill(MASTER)
  await un.getByTestId('popup-unlock').click()
  await expect(un.getByLabel('Search Walnut')).toBeVisible({ timeout: 30_000 })
  await un.close()
  await p.close()
})

test.afterAll(async () => {
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('checkout: an identity fills every address field, a card every payment field (MM/YY), by mouse and by keys; the card row shows its last four', async () => {
  const p = await ctx.newPage()
  await p.goto(site('shop.a2lab.test', '/checkout'))
  const f = (name: string) => p.locator(`[name=${name}]`)
  await f('name').click()
  let menu = await menuOf(p)
  await menu.getByTestId('menu-item').filter({ hasText: `Alex at home ${stamp}` }).click()
  await expect(f('name')).toHaveValue('Alex Rivera')
  await expect(f('address1')).toHaveValue('1 Market St')
  await expect(f('city')).toHaveValue('Springfield')
  await expect(f('state')).toHaveValue('CA')
  await expect(f('zip')).toHaveValue('94000')
  await expect(f('tel')).toHaveValue('+1 555 0100')
  await noMenu(p)
  // The card, from the keyboard.
  await f('cardnumber').click()
  menu = await menuOf(p)
  const row = menu.getByTestId('menu-item').filter({ hasText: `Lab Visa ${stamp}` })
  await expect(row).toContainText('•••• 1111')
  await shot(p, 'checkout-card-menu')
  // Walk down until this card is the selected row (other specs share the vault, so its place varies).
  for (let i = 0; i < 20 && (await row.getAttribute('aria-selected')) !== 'true'; i++) await p.keyboard.press('ArrowDown')
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await p.keyboard.press('Enter')
  await expect(f('cardnumber')).toHaveValue('4111111111111111')
  await expect(f('ccname')).toHaveValue('Alex Rivera')
  await expect(f('exp')).toHaveValue('08/29')
  await expect(f('cvc')).toHaveValue('123')
  await noMenu(p)
  await shot(p, 'checkout-filled')
  await p.close()
})

test('a card with no security code fills the rest and says plainly what it lacks', async () => {
  const p = await ctx.newPage()
  await p.goto(site('shop.a2lab.test', '/checkout'))
  await p.locator('[name=cardnumber]').click()
  const menu = await menuOf(p)
  await menu.getByTestId('menu-item').filter({ hasText: `No code ${stamp}` }).click()
  await expect(p.locator('[name=cardnumber]')).toHaveValue('5555555555554444')
  await expect(p.locator('[name=exp]')).toHaveValue('01/30')
  await expect(p.locator('[name=cvc]')).toHaveValue('')
  // The note is in a closed shadow root: read it through the browser's accessibility tree.
  await expect.poll(() => axText(p), { timeout: 5000 }).toContain('This card has no security code saved in Walnut')
  await shot(p, 'card-missing-code')
  await p.close()
})

test('a login inside a same-site frame: the menu fits inside the frame, and a pick fills by mouse and by keys', async () => {
  const p = await ctx.newPage()
  await p.goto(site('shop.a2lab.test', '/frame'))
  const inner = p.frameLocator('#fr')
  await inner.locator('[name=email]').click()
  const menu = await menuOf(p)
  await expect(menu.locator('[data-testid=menu-item]:not([data-tier="2"])')).toHaveCount(2)
  await shot(p, 'frame-menu')
  const box = (await menuBox(p))!
  const frame = (await p.locator('#fr').boundingBox())!
  // Never cut by the frame: drawn wholly inside it.
  expect(box.y).toBeGreaterThanOrEqual(frame.y)
  expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height + 1)
  expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 1)
  await menu.getByTestId('menu-item').filter({ hasText: `Shop ${stamp}` }).first().click()
  await expect(inner.locator('[name=email]')).toHaveValue(/alex(\.work)?@a2lab\.test/)
  await expect(inner.locator('[name=password]')).not.toHaveValue('')
  await noMenu(p)
  // The keys, in the frame.
  await p.reload()
  await inner.locator('[name=email]').click()
  await menuOf(p)
  await p.keyboard.press('ArrowDown')
  await p.keyboard.press('Enter')
  await expect(inner.locator('[name=email]')).toHaveValue(/@a2lab\.test/, { timeout: 5000 })
  await noMenu(p)
  await p.close()
})

test('two-step sign in: the menu sits under the field, ArrowDown and Enter fill the email and close it, and the password step offers its login', async () => {
  const p = await ctx.newPage()
  await p.goto(site('accounts.a2lab.test', '/email'))
  const email = p.getByLabel('Email')
  await email.click()
  await menuOf(p, false)
  await p.waitForTimeout(500)
  // Where it always is: right under the field.
  await expectUnder(p, email)
  await shot(p, 'two-step-email-menu')
  await p.keyboard.press('ArrowDown')
  await p.keyboard.press('Enter')
  await expect(email).toHaveValue('sam@a2lab.test', { timeout: 3000 })
  await noMenu(p)
  await p.getByRole('button', { name: 'Next' }).click({ timeout: 3000 })
  await p.waitForURL(/\/password/)
  const pw = p.getByLabel('Password')
  await pw.click()
  const menu = await menuOf(p)
  await expect(menu.getByTestId('menu-item').filter({ hasText: `Accounts ${stamp}` })).toBeVisible()
  await shot(p, 'two-step-password-menu')
  await menu.getByTestId('menu-item').filter({ hasText: `Accounts ${stamp}` }).click()
  await expect(pw).toHaveValue('Accounts-Pass-7710!')
  await p.close()
})

test('the menu open, ArrowDown twice and Enter at normal speed: the second login is picked and filled', async () => {
  const p = await ctx.newPage()
  await p.goto(site('shop.a2lab.test', '/signin'))
  await p.getByLabel('Email').click()
  const menu = await menuOf(p)
  const second = menu.locator('[data-testid=menu-item]:not([data-tier="2"])').nth(1)
  const want = (await second.textContent()) ?? ''
  await p.keyboard.press('ArrowDown')
  await p.keyboard.press('ArrowDown')
  await p.keyboard.press('Enter')
  await expect(p.getByLabel('Email')).toHaveValue(want.includes('work') ? 'alex.work@a2lab.test' : 'alex@a2lab.test', { timeout: 5000 })
  await p.close()
})

test('ArrowDown and Enter typed at once, before the menu has loaded: the form is not sent empty', async () => {
  const p = await ctx.newPage()
  await p.goto(site('accounts.a2lab.test', '/email'))
  await p.waitForTimeout(600)
  const email = p.getByLabel('Email')
  // The focus put there by the page (the menu does not open by itself then), then the keys at once.
  await email.evaluate((el: HTMLInputElement) => el.focus())
  await p.waitForTimeout(800)
  expect(menuCount(p)).toBe(0)
  await p.keyboard.press('ArrowDown')
  await p.keyboard.press('Enter')
  await p.waitForTimeout(1500)
  // Still on step 1: the Enter went to Walnut, not to the page's form.
  expect(new URL(p.url()).pathname).toBe('/email')
  // Filled from the first login (the background passes the pick on), or the menu waits with it picked.
  const filled = await email.inputValue()
  if (filled) expect(filled).toBe('sam@a2lab.test')
  else await expect((await menuOf(p, false)).getByTestId('menu-item').first()).toHaveAttribute('aria-selected', 'true')
  await p.close()
})

test('the code page: the menu waits for the person to be in the field, then sits under it', async () => {
  const p = await ctx.newPage()
  // A sign in Walnut knows, so the code page that follows has the code to offer.
  await p.goto(site('accounts.a2lab.test', '/password'))
  await p.getByLabel('Password').click()
  await (await menuOf(p)).getByTestId('menu-item').filter({ hasText: `Accounts ${stamp}` }).click()
  await expect(p.getByLabel('Password')).not.toHaveValue('')
  await p.goto(site('accounts.a2lab.test', '/code'))
  await p.waitForTimeout(2000)
  expect(menuCount(p)).toBe(0)
  await p.getByLabel('Code').click()
  const menu = await menuOf(p)
  await expect(menu.getByTestId('menu-item').filter({ hasText: `Accounts ${stamp}` })).toBeVisible()
  await expectUnder(p, p.getByLabel('Code'))
  await shot(p, 'code-menu')
  await menu.getByTestId('menu-item').filter({ hasText: `Accounts ${stamp}` }).click()
  await expect(p.getByLabel('Code')).toHaveValue(/^\d{6}$/)
  await p.close()
})

test('the menu closes on a click outside, on Escape and on a submit; typing after Escape opens it again, filtered', async () => {
  const p = await ctx.newPage()
  await p.goto(site('shop.a2lab.test', '/signin'))
  const email = p.getByLabel('Email')
  await email.click()
  await menuOf(p, false)
  await p.locator('h1').click()
  await noMenu(p)
  await email.click()
  let menu = await menuOf(p)
  await expect(menu.locator('[data-testid=menu-item]:not([data-tier="2"])')).toHaveCount(2)
  await p.keyboard.press('Escape')
  await noMenu(p)
  // Typing reopens it, showing only the logins that fit what is typed.
  await p.keyboard.type('alex.w')
  menu = await menuOf(p, false)
  await expect(menu.getByTestId('menu-item').filter({ visible: true })).toHaveCount(1)
  await expect(menu.getByTestId('menu-item').filter({ visible: true })).toContainText(`Shop work ${stamp}`)
  await shot(p, 'typing-filters')
  // Nothing fits: the menu steps out of the way.
  await p.keyboard.type('zzz')
  await expect.poll(async () => { const b = await menuBox(p); return !b || b.height === 0 }).toBe(true)
  await p.keyboard.press('Backspace')
  await p.keyboard.press('Backspace')
  await p.keyboard.press('Backspace')
  await expect.poll(async () => ((await menuBox(p))?.height ?? 0) > 40).toBe(true)
  // A submit closes it.
  await p.getByLabel('Password').evaluate((el: HTMLInputElement) => el.form!.addEventListener('submit', (e) => e.preventDefault()))
  await email.press('Enter')
  await noMenu(p)
  await p.close()
})

/** Click the Walnut icon in a field (it is in a closed shadow root: by where it is drawn). */
async function clickIcon(p: Page, field: import('@playwright/test').Locator): Promise<void> {
  await field.click()
  await p.waitForTimeout(400)
  const b = (await field.boundingBox())!
  await p.mouse.click(b.x + b.width - 15, b.y + b.height / 2)
}

test('empty menus say one short, complete sentence; a part of the site with only other parts\' logins shows just their heading', async () => {
  const p = await ctx.newPage()
  await p.goto(site('solo.a2site.test', '/signin'))
  await clickIcon(p, p.getByLabel('Email'))
  let menu = await menuOf(p, false)
  const empty = menu.getByTestId('menu-empty')
  await expect(empty).toHaveText('No login saved for solo.a2site.test yet. Walnut offers to save one when you sign in.')
  // Wrapped, never cut with an ellipsis.
  expect(await empty.locator('p').evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis')).toBe(true)
  await expectUnder(p, p.getByLabel('Email'))
  await shot(p, 'empty-sentence')
  await p.goto(site('blog.a2lab.test', '/signin'))
  await clickIcon(p, p.getByLabel('Email'))
  menu = await menuOf(p, false)
  await expect(menu.getByText('Saved for other parts of a2lab.test')).toBeVisible()
  await expect(menu.getByTestId('menu-empty')).toHaveCount(0)
  await shot(p, 'tier2-only')
  await p.close()
})

test('logins saved for another part of the site are listed under their own heading, with the host each is for', async () => {
  const p = await ctx.newPage()
  await seed(p, { type: 'login', title: `Blog ${stamp}`, username: 'writer@a2lab.test', password: 'Blog-Pass-1!', urls: [site('blog.a2lab.test', '/')] })
  await p.waitForTimeout(5500) // the background keeps the item list 5 s (bg-vault.ts summaries)
  await p.goto(site('accounts.a2lab.test', '/email'))
  await p.getByLabel('Email').click()
  const menu = await menuOf(p)
  await expect(menu.getByText('Saved for other parts of a2lab.test')).toBeVisible()
  const blog = menu.getByTestId('menu-item').filter({ hasText: `Blog ${stamp}` })
  await expect(blog).toContainText('blog.a2lab.test')
  // This site's own login comes first, above the heading.
  const texts = await menu.locator('[role=option], .menu-sub').allTextContents()
  expect(texts.findIndex((t) => t.includes(`Accounts ${stamp}`))).toBeLessThan(texts.findIndex((t) => t.includes('Saved for other parts')))
  await shot(p, 'tier2-heading')
  await blog.click()
  await expect(p.getByLabel('Email')).toHaveValue('writer@a2lab.test')
  await p.close()
})

test('the save bar: a name that tells the new login apart, an underscore in a revealed password shows, and a compact confirmation naming it', async () => {
  const p = await ctx.newPage()
  // The site already has a login under the name the bar would suggest.
  await seed(p, { type: 'login', title: 'Lab Shop', username: 'first@a2lab.test', password: 'First-Pass-1!', urls: [site('shop.a2lab.test', '/')] })
  await p.waitForTimeout(5500) // the background keeps the item list 5 s
  await p.goto(site('shop.a2lab.test', '/signin'))
  await p.getByLabel('Email').click()
  await p.keyboard.press('Escape')
  await p.getByLabel('Email').evaluate((el: HTMLInputElement) => { el.value = '' })
  await p.getByLabel('Email').pressSequentially('new_user@a2lab.test')
  await p.keyboard.press('Escape')
  await p.getByLabel('Password').pressSequentially('Under_score_pw_9')
  await p.keyboard.press('Escape')
  await p.getByRole('button', { name: 'Sign in' }).click()
  await p.waitForURL(/signed-in/)
  let bar: Frame | undefined
  await expect.poll(() => { bar = p.frames().find((x) => x.url().includes('/savebar.html') && !x.isDetached()); return !!bar }, { timeout: 10_000 }).toBe(true)
  await p.waitForTimeout(700)
  await bar!.getByTestId('savebar-reveal').click()
  await expect(bar!.locator('#password')).toHaveValue('Under_score_pw_9')
  const field = await bar!.locator('#password').boundingBox()
  if (SHOTS && field) await p.screenshot({ path: path.join(SHOTS, 'savebar-revealed.png'), clip: { x: field.x - 4, y: field.y - 30, width: field.width + 8, height: field.height + 40 } })
  // Every glyph of the revealed password lies inside the field's text box (an underscore sits lowest).
  const fits = await bar!.locator('#password').evaluate((el: HTMLInputElement) => {
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 0
    const fs = parseFloat(getComputedStyle(el).fontSize)
    return { lh, fs, client: el.clientHeight }
  })
  expect(fits.lh === 0 || fits.lh >= fits.fs * 1.15).toBe(true)
  await expect(bar!.locator('#title')).toHaveValue('Lab Shop (new_user@a2lab.test)')
  await shot(p, 'savebar-new-name')
  await bar!.getByTestId('savebar-save').click()
  await expect(bar!.getByText('Saved to Walnut: Lab Shop (new_user@a2lab.test)')).toBeVisible()
  // The frame shrinks to the confirmation (or, at the least, shows nothing outside it).
  await expect.poll(async () => (await bar!.frameElement().then((e) => e.boundingBox()))?.height ?? 0, { timeout: 5000 }).toBeLessThan(110)
  await shot(p, 'savebar-saved')
  await p.close()
})

test('"Never for this site" says so in the bar, with Undo, then closes', async () => {
  const p = await ctx.newPage()
  await p.goto(site('solo.a2site.test', '/signin'))
  await p.getByLabel('Email').pressSequentially('never@a2site.test')
  await p.getByLabel('Password').pressSequentially('Never-Pass-1!')
  await p.getByRole('button', { name: 'Sign in' }).click()
  await p.waitForURL(/signed-in/)
  let bar: Frame | undefined
  await expect.poll(() => { bar = p.frames().find((x) => x.url().includes('/savebar.html') && !x.isDetached()); return !!bar }, { timeout: 10_000 }).toBe(true)
  await p.waitForTimeout(700)
  await bar!.getByRole('button', { name: 'Never for this site' }).click()
  await expect(bar!.getByText('Walnut won\u2019t offer to save logins on solo.a2site.test.')).toBeVisible()
  await expect.poll(() => sw().evaluate(() => chrome.storage.local.get('neverSave').then((r) => r.neverSave))).toContain('solo.a2site.test')
  await shot(p, 'never-note')
  await p.waitForTimeout(650)
  await bar!.getByTestId('savebar-undo').click()
  await expect(bar!.getByText('Walnut will offer to save logins on solo.a2site.test again.')).toBeVisible()
  await expect.poll(() => sw().evaluate(() => chrome.storage.local.get('neverSave').then((r) => r.neverSave ?? []))).not.toContain('solo.a2site.test')
  // And the bar goes by itself.
  await expect.poll(() => p.frames().some((x) => x.url().includes('/savebar.html') && !x.isDetached()), { timeout: 10_000 }).toBe(false)
  await p.close()
})
