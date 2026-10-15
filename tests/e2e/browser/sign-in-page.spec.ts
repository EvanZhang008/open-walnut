/**
 * The sign-in page (spec 3, checklist C1 to C16, C89) on an iPhone 15 and on a
 * 1280x800 computer browser.
 *
 * The fixture trusts this browser (it is on the same machine), so the page is
 * reached the way a phone through a tunnel reaches it: the sign-in probe
 * (GET /api/v1/me without a token) is answered 401 not_paired by page.route.
 * Codes are real: minted on the fixture and traded at the real
 * POST /api/v1/browser-pair, which page.route only delays, aborts, or answers
 * 429. The real tunnel path (a proxy Walnut does not trust) is
 * browser-access-tunnel.spec.ts. Screenshots: /tmp/mobile-web/sign-in-*.png.
 */
import fs from 'node:fs/promises'
import { devices, expect, test, type Locator, type Page, type Route } from '@playwright/test'

const SHOTS = '/tmp/mobile-web'
const PHONE = devices['iPhone 15']
const NETWORK = 'Walnut did not answer. Check the connection, then try again.'
const STEP1 = 'On your computer, open Walnut and go to Settings > Phones & Cloud.'

test.setTimeout(120_000)
test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

/** A second phone with nothing stored (its own context). */
function pageOptions() {
  const { defaultBrowserType: _engine, ...iphone } = PHONE
  return { ...iphone, baseURL: test.info().project.use.baseURL }
}

async function shot(page: Page, name: string) {
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({ path: `${SHOTS}/sign-in-${engine}-${name}.png` })
}

/** A browser with no token gets the primary's refusal, as through a tunnel. */
async function refuseProbe(page: Page) {
  await page.route((url) => url.pathname === '/api/v1/me', (route) => {
    if (route.request().headers()['authorization']) return route.continue()
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'not paired', code: 'not_paired' }) })
  })
}

/** Every API read refused as a removed token is (token_refused). */
async function refuseToken(page: Page, token: string) {
  await page.addInitScript((t) => {
    if (sessionStorage.getItem('sign-in-seeded')) return
    sessionStorage.setItem('sign-in-seeded', '1')
    localStorage.setItem('walnut.deviceToken', t)
  }, token)
  // The code exchange is public: the server never reads a token there.
  await page.route((url) => url.pathname.startsWith('/api/') && url.pathname !== '/api/v1/browser-pair', (route) => {
    const auth = route.request().headers()['authorization'] ?? ''
    if (!auth.includes(token)) return route.continue()
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid or revoked token', code: 'token_refused' }) })
  })
}

/** A finger on the right of the code: the caret lands after its last character. */
async function tapAtEnd(input: Locator) {
  const box = (await input.boundingBox())!
  await input.click({ position: { x: box.width - 6, y: box.height / 2 } })
  await expect(input).toBeFocused()
}

async function mintCode(page: Page): Promise<string> {
  const res = await page.request.post('/api/devices/browser-code')
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { code: string }).code
}

/** Hold the code exchange for `ms`, then let it through (or run `then`). */
async function holdExchange(page: Page, ms: number, then?: (route: Route) => Promise<void>) {
  await page.route((url) => url.pathname === '/api/v1/browser-pair', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await new Promise((r) => setTimeout(r, ms))
    if (then) await then(route)
    else await route.continue().catch(() => {})
  })
}

async function openSignIn(page: Page, path = '/') {
  await page.goto(path)
  const notice = page.getByTestId('unpaired-notice')
  await expect(notice).toBeVisible({ timeout: 60_000 })
  return notice
}

/** WCAG contrast of an element's text on the page background. */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
    }
    const el = document.querySelector(sel)
    const root = document.querySelector('[data-testid="unpaired-notice"]')
    if (!el || !root) return 0
    const a = lum(parse(getComputedStyle(el).color))
    const b = lum(parse(getComputedStyle(root).backgroundColor))
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }, selector)
}

async function expectNoFocusZoom(page: Page) {
  const input = page.getByTestId('unpaired-code-input')
  const size = await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  expect(size).toBeGreaterThanOrEqual(16)
  await input.tap().catch(() => input.click())
  await expect(input).toBeFocused()
  await page.waitForTimeout(400)
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1)
}

test.describe('on an iPhone', () => {
  test.use({
    viewport: PHONE.viewport,
    screen: PHONE.screen,
    deviceScaleFactor: PHONE.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    userAgent: PHONE.userAgent,
  })

  test('C1 C2 C3 C11 C12: a full-screen page with the exact words and nothing of the console', async ({ page }) => {
    await refuseProbe(page)
    const notice = await openSignIn(page)
    const vp = page.viewportSize()!
    const box = (await notice.boundingBox())!
    expect(box).toMatchObject({ x: 0, y: 0, width: vp.width })
    expect(box.height).toBeGreaterThanOrEqual(vp.height - 1)
    expect(await page.locator('.app-shell').count()).toBe(0)
    const bg = await notice.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bg).toBe('rgb(255, 255, 255)')

    await expect(notice.locator('h1')).toHaveText('Sign in to Walnut')
    await expect(notice.locator('.unpaired-notice-tagline')).toHaveText('Your tasks, AI sessions and notes, from the computer Walnut runs on.')
    await expect(notice.locator('.unpaired-notice-steps li')).toHaveText([
      `1${STEP1}`,
      "2Click Show QR code, then scan it with this phone's camera.",
    ])
    await expect(notice.locator('h2')).toHaveText("Can't scan it?")
    await expect(notice.locator('.unpaired-notice-hint')).toHaveText('Type the 8-character code shown with the QR code.')
    await expect(notice.locator('.unpaired-notice-more')).toHaveText('On the computer Walnut runs on? Open Walnut there; it needs no code.')
    await expect(page.getByTestId('unpaired-code-input')).toHaveAttribute('aria-label', 'Sign-in code')
    await expect(page.getByTestId('unpaired-code-input')).toHaveAttribute('placeholder', 'XXXX-XXXX')
    await expect(page.getByTestId('unpaired-code-submit')).toHaveText('Sign in')
    await expect(notice.locator('img.unpaired-notice-icon')).toHaveAttribute('alt', '')

    const text = await notice.innerText()
    expect(text).not.toMatch(/ssh|localhost|-L\b|:\d{2,5}\b|pair the Walnut app/i)
    expect(await notice.locator('code').count()).toBe(0)
    const overflow = await page.evaluate(() => document.querySelector('[data-testid="unpaired-notice"]')!.scrollWidth - innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await shot(page, 'phone-light')

    await expectNoFocusZoom(page)
    await page.keyboard.press('Escape').catch(() => {})
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    // A notch of 47 px and a home indicator of 34 px (Playwright draws neither).
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--wn-safe-top', '47px')
      document.documentElement.style.setProperty('--wn-safe-bottom', '34px')
    })
    await page.evaluate(() => document.querySelector('[data-testid="unpaired-notice"]')!.scrollTo(0, 0))
    const icon = (await notice.locator('.unpaired-notice-icon').boundingBox())!
    expect(icon.y).toBeGreaterThanOrEqual(47 + 40)
    const intoNotch = await page.evaluate(() => [...document.querySelectorAll('[data-testid="unpaired-notice"] *')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < 47 })
      .map((el) => el.className))
    expect(intoNotch).toEqual([])
    await page.evaluate(() => { const n = document.querySelector('[data-testid="unpaired-notice"]')!; n.scrollTo(0, n.scrollHeight) })
    const footer = (await notice.locator('.unpaired-notice-more').boundingBox())!
    expect(footer.y + footer.height).toBeLessThanOrEqual(vp.height - 34)
    await shot(page, 'phone-safe-area')
  })

  test('C4 C89: the field formats what is typed or pasted and never submits on its own', async ({ page }) => {
    await refuseProbe(page)
    await openSignIn(page)
    const input = page.getByTestId('unpaired-code-input')
    const submit = page.getByTestId('unpaired-code-submit')
    await expect(input).toHaveAttribute('autocomplete', 'off')
    await expect(input).toHaveAttribute('enterkeyhint', 'go')
    await expect(input).toHaveAttribute('autocapitalize', 'characters')
    expect(await input.getAttribute('maxlength')).toBeNull()

    await input.fill('abc')
    await expect(input).toHaveValue('ABC')
    await expect(submit).toBeDisabled()
    await input.fill('abcd efgh')
    await expect(input).toHaveValue('ABCD-EFGH')
    await expect(submit).toBeEnabled()
    await input.fill('https://x.example/#pair=ab2c-de3f')
    await expect(input).toHaveValue('AB2C-DE3F')
    await input.fill('ABCDEFGHJK')
    await expect(input).toHaveValue('ABCD-EFGH')
    // Typing one key at a time puts the dash in and keeps the caret at the end.
    await input.fill('')
    await input.pressSequentially('abcde')
    await expect(input).toHaveValue('ABCD-E')
    expect(await input.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(6)

    await input.fill('abcd-ef0h')
    await expect(input).toHaveValue('ABCD-EF0H')
    await expect(page.getByTestId('unpaired-code-error')).toHaveText('Codes never use 0, 1, I, L or O.')
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(submit).toBeDisabled()
    await shot(page, 'phone-bad-chars')
    await input.fill('abcd-efgh')
    await expect(page.getByTestId('unpaired-code-error')).toHaveCount(0)
  })

  test('C5 C9 C15: busy in the same frame, then each refusal says why and keeps the code', async ({ page }) => {
    await refuseProbe(page)
    let mode: 'hold' | 'abort' | 'rate' | 'wrong' = 'hold'
    await page.route((url) => url.pathname === '/api/v1/browser-pair', async (route) => {
      if (mode === 'hold') { await new Promise((r) => setTimeout(r, 2_000)); return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_code', message: 'That code is wrong or has expired. Make a new one in Walnut on your computer.' } }) }) }
      if (mode === 'abort') return route.abort('failed')
      if (mode === 'rate') return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 'rate_limited', message: 'Too many wrong codes. Wait a minute, then try again.' } }) })
      return route.continue()
    })
    await openSignIn(page)
    const input = page.getByTestId('unpaired-code-input')
    const submit = page.getByTestId('unpaired-code-submit')
    const error = page.getByTestId('unpaired-code-error')
    await input.fill('zzzz-zzzz')
    const busy = await page.evaluate(async () => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="unpaired-code-submit"]')!
      const field = document.querySelector<HTMLInputElement>('[data-testid="unpaired-code-input"]')!
      const t0 = performance.now()
      btn.click()
      await new Promise((r) => requestAnimationFrame(r))
      return { ms: performance.now() - t0, text: btn.textContent, disabled: field.disabled, ariaBusy: btn.getAttribute('aria-busy') }
    })
    expect(busy.text).toBe('Signing in...')
    expect(busy.disabled).toBe(true)
    expect(busy.ariaBusy).toBe('true')
    expect(busy.ms).toBeLessThanOrEqual(100)
    await shot(page, 'phone-submitting')
    await expect(error).toHaveText('That code is wrong or has expired. Make a new one in Walnut on your computer.')
    await expect(input).toHaveValue('ZZZZ-ZZZZ')
    await expect(input).toBeEnabled()
    await expect(input).toHaveAttribute('aria-describedby', await error.getAttribute('id') ?? 'missing')
    await expect(input).not.toBeFocused()
    await shot(page, 'phone-wrong-code')
    // N23: the refused code cannot be sent again as is, and it reads at 22 px.
    await expect(submit).toBeDisabled()
    expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(22)
    // A finger edits from the end of the code.
    await tapAtEnd(input)
    await input.press('Backspace')
    await expect(input).toHaveValue('ZZZZ-ZZZ')
    await expect(error).toHaveCount(0)

    mode = 'abort'
    await input.fill('zzzz-zzzz')
    await submit.click()
    await expect(error).toHaveText(NETWORK)
    await expect(input).toHaveValue('ZZZZ-ZZZZ')
    await shot(page, 'phone-network')

    mode = 'rate'
    await input.press('Enter')
    await expect(error).toHaveText('Too many wrong codes. Wait a minute, then try again.')
    await shot(page, 'phone-rate-limited')
  })

  test('C7 C8: a scanned link says Signing in, then lands in the console; the same link again shows why', async ({ page, browser }) => {
    const code = await mintCode(page)
    await refuseProbe(page)
    // Held until the 6 s slow line shows, then let through. A fixed 20 s hold
    // outlived the exchange's own 15 s deadline, which WebKit enforces on a
    // held request ("Walnut did not answer"); the slow line's clock starts at
    // mount, so a fixed shorter hold could end before it on a loaded machine.
    let release: () => void = () => {}
    const released = new Promise<void>((r) => { release = r })
    await holdExchange(page, 0, async (route) => {
      await Promise.race([released, new Promise((r) => setTimeout(r, 14_000))])
      await route.continue().catch(() => {})
    })
    await page.goto(`/#pair=${code}`)
    const notice = page.getByTestId('unpaired-notice')
    await expect(notice.locator('h1')).toHaveText('Signing in...', { timeout: 30_000 })
    await expect(notice).toContainText('Checking the code from your QR scan.')
    await expect(page.getByTestId('unpaired-code-form')).toHaveCount(0)
    await expect(page.getByTestId('unpaired-pending-ring')).toBeVisible()
    await shot(page, 'phone-pending')
    await expect(page.getByTestId('unpaired-pending-slow')).toHaveText('Still waiting for Walnut. The connection may be slow.', { timeout: 16_000 })
    await shot(page, 'phone-pending-slow')
    release()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('walnut.deviceToken')).catch(() => null), { timeout: 30_000 }).toMatch(/.{20,}/)
    await expect(page.locator('.app-shell').first()).toBeVisible({ timeout: 30_000 })
    await expect(notice).toHaveCount(0)
    expect(page.url()).not.toContain('#pair')

    const again = await browser.newPage({ ...pageOptions() })
    await refuseProbe(again)
    await again.goto(`/#pair=${code}`)
    await expect(again.getByTestId('unpaired-code-error')).toHaveText('That code is wrong or has expired. Make a new one in Walnut on your computer.', { timeout: 30_000 })
    await expect(again.getByTestId('unpaired-code-input')).toHaveValue(code)
    await expect(again.getByTestId('unpaired-notice').locator('h1')).toHaveText('Sign in to Walnut')
    // N23: the scan worked, so the code section no longer asks "Can't scan it?".
    await expect(again.locator('#unpaired-code-heading')).toHaveText('Sign-in code')
    await expect(again.getByTestId('unpaired-code-submit')).toBeDisabled()
    await shot(again, 'phone-used-link')
    await again.close()
  })

  test('C10: a refused token covers the console with This phone was signed out', async ({ page }) => {
    await refuseToken(page, 'stale-token-0123456789abcdef')
    await page.goto('/')
    const notice = page.getByTestId('unpaired-notice')
    await expect(notice.locator('h1')).toHaveText('This phone was signed out', { timeout: 30_000 })
    await expect(notice.locator('.unpaired-notice-tagline')).toHaveText('Walnut no longer accepts this sign-in. It may have been removed on your computer. Sign in again below.')
    const retry = page.getByTestId('unpaired-retry')
    await expect(retry).toHaveText('Try again')
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    const vp = page.viewportSize()!
    const box = (await notice.boundingBox())!
    expect(box).toMatchObject({ x: 0, y: 0, width: vp.width })
    // Nothing under it takes a tap.
    const covered = await page.evaluate(() => [[0.5, 0.5], [0.05, 0.02], [0.95, 0.98]].every(([x, y]) =>
      !!document.elementFromPoint(innerWidth * x!, innerHeight * y!)?.closest('[data-testid="unpaired-notice"]')))
    expect(covered).toBe(true)
    await shot(page, 'phone-revoked')
    await retry.click()
    await expect(notice.locator('h1')).toHaveText('This phone was signed out', { timeout: 30_000 })
  })

  test('signed out by itself: Signed out, no Try again; a new code clears the mark', async ({ page }) => {
    const code = await mintCode(page)
    await page.addInitScript(() => {
      if (sessionStorage.getItem('signed-out-seeded')) return
      sessionStorage.setItem('signed-out-seeded', '1')
      sessionStorage.setItem('walnut.signedOut', 'self')
    })
    await refuseToken(page, 'signed-out-token-0123456789')
    await page.goto('/')
    const notice = page.getByTestId('unpaired-notice')
    await expect(notice.locator('h1')).toHaveText('Signed out', { timeout: 30_000 })
    await expect(notice.locator('.unpaired-notice-tagline')).toHaveText('This phone no longer has access to Walnut. Sign in again below.')
    await expect(page.getByTestId('unpaired-retry')).toHaveCount(0)
    await shot(page, 'phone-signed-out')
    await page.getByTestId('unpaired-code-input').fill(code.toLowerCase())
    await page.getByTestId('unpaired-code-submit').click()
    await expect(notice).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('.app-shell').first()).toBeVisible({ timeout: 30_000 })
    expect(await page.evaluate(() => sessionStorage.getItem('walnut.signedOut'))).toBeNull()
  })

  test('C13: light and dark both read at 4.5:1 and the field edge shows', async ({ page }) => {
    await refuseProbe(page)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await openSignIn(page)
      await page.getByTestId('unpaired-code-input').fill('abcd-ef0h')
      await expect(page.getByTestId('unpaired-code-error')).toBeVisible()
      for (const sel of ['.unpaired-notice-title', '.unpaired-notice-tagline', '.unpaired-notice-steps li', '.unpaired-notice-hint', '.unpaired-notice-more', '.unpaired-notice-error']) {
        expect(await contrastOf(page, `[data-testid="unpaired-notice"] ${sel}`), `${scheme} ${sel}`).toBeGreaterThanOrEqual(4.5)
      }
      const edge = await page.getByTestId('unpaired-code-input').evaluate((el) => {
        const s = getComputedStyle(el)
        return { border: s.borderTopColor, width: s.borderTopWidth, bg: getComputedStyle(el.closest('[data-testid="unpaired-notice"]')!).backgroundColor }
      })
      expect(edge.width).toBe('1px')
      expect(edge.border).not.toBe(edge.bg)
      const bg = await page.getByTestId('unpaired-notice').evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(bg).toBe(scheme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)')
      await shot(page, `phone-${scheme}`)
    }
  })

  test('C14: a Home Screen app puts the code field before the steps', async ({ page }) => {
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window)
      window.matchMedia = (q: string) => {
        if (!q.includes('display-mode: standalone')) return real(q)
        const noop = () => {}
        return { matches: true, media: q, onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: () => false } as unknown as MediaQueryList
      }
    })
    await refuseProbe(page)
    const notice = await openSignIn(page)
    const order = await page.evaluate(() => {
      const code = document.querySelector('[data-testid="unpaired-code-section"]')!
      const steps = document.querySelector('[data-testid="unpaired-steps"]')!
      return !!(code.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(order).toBe(true)
    await expect(notice.locator('.unpaired-notice-steps li').nth(1)).toHaveText('2Type the code shown with the QR code in the field above. Scanning the QR code opens Safari, not this app.')
    // N2-20: "above" is true: the field sits before the steps on screen.
    const fieldY = (await page.getByTestId('unpaired-code-input').boundingBox())!.y
    const stepsY = (await notice.locator('.unpaired-notice-steps').boundingBox())!.y
    expect(fieldY).toBeLessThan(stepsY)
    // N2-24: a step number is a white digit on the solid accent, in both themes.
    const num = await notice.locator('.unpaired-notice-step-n').first().evaluate((el) => ({ c: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }))
    expect(num.c).toBe('rgb(255, 255, 255)')
    expect(num.bg).not.toMatch(/rgba\(.*, 0(\.\d+)?\)$/)
    expect(await notice.locator('.unpaired-notice-title').evaluate((el) => getComputedStyle(el).getPropertyValue('text-wrap') || 'balance')).toMatch(/balance/)
    await expect(notice.locator('h2')).toHaveText('Sign-in code')
    await expect(notice.locator('.unpaired-notice-hint')).toHaveCount(0)
    await shot(page, 'phone-standalone')
  })
})

test.describe('on a computer browser', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false })

  test('C16: the same page, a centred 400 px column, no card', async ({ page }) => {
    await refuseProbe(page)
    const notice = await openSignIn(page)
    const box = (await notice.boundingBox())!
    expect(box).toMatchObject({ x: 0, y: 0, width: 1280 })
    expect(box.height).toBeGreaterThanOrEqual(799)
    const col = (await notice.locator('.unpaired-notice-column').boundingBox())!
    expect(col.width).toBeLessThanOrEqual(400)
    expect(Math.abs(col.x + col.width / 2 - 640)).toBeLessThanOrEqual(1)
    const shadows = await page.evaluate(() => ['[data-testid="unpaired-notice"]', '.unpaired-notice-column']
      .map((s) => getComputedStyle(document.querySelector(s)!).boxShadow))
    expect(shadows).toEqual(['none', 'none'])
    // 12vh from the top on a wide window.
    const icon = (await notice.locator('.unpaired-notice-icon').boundingBox())!
    expect(Math.abs(icon.y - 96)).toBeLessThanOrEqual(1)
    await expect(notice.locator('h1')).toHaveText('Sign in to Walnut')
    await expect(notice.locator('.unpaired-notice-steps li').nth(1)).toHaveText('2Click Show QR code, then type the code shown with it below.')
    await expect(notice.locator('h2')).toHaveText('Sign-in code')
    await expect(notice.locator('.unpaired-notice-hint')).toHaveCount(0)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await shot(page, 'desktop-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await shot(page, 'desktop-dark')
  })

  test('C10: a refused token on a computer says This browser was signed out', async ({ page }) => {
    await refuseToken(page, 'stale-desk-token-0123456789')
    await page.goto('/')
    await expect(page.getByTestId('unpaired-notice').locator('h1')).toHaveText('This browser was signed out', { timeout: 30_000 })
    await expect(page.getByTestId('unpaired-retry')).toBeVisible()
    await shot(page, 'desktop-revoked')
  })
})
