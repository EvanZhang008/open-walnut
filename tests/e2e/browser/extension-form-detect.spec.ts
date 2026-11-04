/**
 * The extension's form reading (packages/browser-extension/src/form-detect.ts) in a real
 * browser, so layout counts (a hidden honeypot field, a zero-size input): the shapes login,
 * sign-up, password-change, two-step and one-time-code pages come in, and the look-alikes that
 * are none of them (a newsletter box, a search box), and the card and address forms
 * (wallet-detect.ts). Each case says what a person sees.
 */
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'

let bundle = ''

test.beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fd-'))
  const entry = path.join(dir, 'entry.ts')
  const src = path.resolve('packages/browser-extension/src/form-detect.ts')
  const wallet = path.resolve('packages/browser-extension/src/wallet-detect.ts')
  fs.writeFileSync(entry, `import * as fd from ${JSON.stringify(src)}\nimport * as wd from ${JSON.stringify(wallet)}\n;(globalThis as any).walnutFormDetect = fd\n;(globalThis as any).walnutWalletDetect = wd\n`)
  execFileSync(bunRuntime(), ['build', entry, '--format', 'iife', '--target', 'browser', '--outfile', path.join(dir, 'fd.js')], { stdio: 'pipe' })
  bundle = fs.readFileSync(path.join(dir, 'fd.js'), 'utf8')
})

interface Seen { kind: string; username?: string; password?: string; newPasswords: string[]; totp?: string; totpBoxes?: string[] }

async function detect(page: Page, html: string): Promise<Seen[]> {
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`)
  await page.addScriptTag({ content: bundle })
  return page.evaluate(() => {
    const fd = (globalThis as unknown as { walnutFormDetect: { findLoginGroups(d: Document): Array<{ kind: string; username?: HTMLInputElement; password?: HTMLInputElement; newPasswords: HTMLInputElement[]; totp?: HTMLInputElement; totpBoxes?: HTMLInputElement[] }> } }).walnutFormDetect
    return fd.findLoginGroups(document).map((g) => ({
      kind: g.kind,
      ...(g.username ? { username: g.username.id } : {}),
      ...(g.password ? { password: g.password.id } : {}),
      newPasswords: g.newPasswords.map((p) => p.id),
      ...(g.totp ? { totp: g.totp.id } : {}),
      ...(g.totpBoxes ? { totpBoxes: g.totpBoxes.map((b) => b.id) } : {}),
    }))
  })
}

const CASES: Array<{ name: string; html: string; want: Seen[] }> = [
  {
    name: 'a plain sign-in form',
    html: `<form><input id="u" type="email" name="email"><input id="p" type="password" name="password"><button>Sign in</button></form>`,
    want: [{ kind: 'login', username: 'u', password: 'p', newPasswords: [] }],
  },
  {
    name: 'a sign in with no <form>, a search box above it',
    html: `<input id="q" type="search" placeholder="Search"><div><div><input id="u" placeholder="Username"></div><div><input id="p" type="password"></div><button>Log in</button></div>`,
    want: [{ kind: 'login', username: 'u', password: 'p', newPasswords: [] }],
  },
  {
    name: 'a username field labelled only by <label>',
    html: `<form><label for="a">Phone or email</label><input id="a"><label>Password <input id="p" type="password"></label></form>`,
    want: [{ kind: 'login', username: 'a', password: 'p', newPasswords: [] }],
  },
  {
    name: 'step one of a two-step sign in',
    html: `<form><input id="u" type="email" name="identifier" autocomplete="username"><button>Next</button></form>`,
    want: [{ kind: 'username-step', username: 'u', newPasswords: [] }],
  },
  {
    name: 'step two: the password alone',
    html: `<form><input id="p" type="password" autocomplete="current-password"><button>Sign in</button></form>`,
    want: [{ kind: 'login', password: 'p', newPasswords: [] }],
  },
  {
    name: 'a sign-up with autocomplete new-password and a confirmation',
    html: `<form><input id="u" type="email"><input id="n1" type="password" autocomplete="new-password"><input id="n2" type="password" autocomplete="new-password"><button>Create account</button></form>`,
    want: [{ kind: 'signup', username: 'u', newPasswords: ['n1', 'n2'] }],
  },
  {
    name: 'a sign-up with two password fields and no autocomplete',
    html: `<form><input id="u" name="email"><input id="n1" type="password" placeholder="Password"><input id="n2" type="password" placeholder="Confirm password"><button>Sign up</button></form>`,
    want: [{ kind: 'signup', username: 'u', newPasswords: ['n1', 'n2'] }],
  },
  {
    name: 'a sign-up with ONE password field, said by the field',
    html: `<form><input id="u" type="email"><input id="n1" type="password" placeholder="Create a password"><button>Continue</button></form>`,
    want: [{ kind: 'signup', username: 'u', newPasswords: ['n1'] }],
  },
  {
    name: 'a sign-up with ONE password field, said by its button',
    html: `<form><input id="u" type="email"><input id="n1" type="password" name="password"><button type="submit">Create account</button></form>`,
    want: [{ kind: 'signup', username: 'u', newPasswords: ['n1'] }],
  },
  {
    name: 'a password change with current, new and confirm',
    html: `<form><input id="c" type="password" autocomplete="current-password"><input id="n1" type="password" autocomplete="new-password"><input id="n2" type="password" autocomplete="new-password"></form>`,
    want: [{ kind: 'change', password: 'c', newPasswords: ['n1', 'n2'] }],
  },
  {
    name: 'a password change with old and new, words only',
    html: `<form><input id="c" type="password" placeholder="Old password"><input id="n1" type="password" placeholder="New password"><button>Change password</button></form>`,
    want: [{ kind: 'change', password: 'c', newPasswords: ['n1'] }],
  },
  {
    name: 'a one-time code by autocomplete',
    html: `<form><input id="t" autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form>`,
    want: [{ kind: 'totp', totp: 't', newPasswords: [] }],
  },
  {
    name: 'a one-time code by its words',
    html: `<form><label>Verification code <input id="t" name="otp" maxlength="6"></label><button>Verify</button></form>`,
    want: [{ kind: 'totp', totp: 't', newPasswords: [] }],
  },
  {
    name: 'a one-time code in six boxes of one digit each',
    html: `<form><div>${[1, 2, 3, 4, 5, 6].map((i) => `<input id="b${i}" maxlength="1" inputmode="numeric">`).join('')}</div><button>Verify</button></form>`,
    want: [{ kind: 'totp', totp: 'b1', totpBoxes: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'], newPasswords: [] }],
  },
  {
    name: 'code boxes with autocomplete="one-time-code" on the first box only',
    html: `<form>${[1, 2, 3, 4, 5, 6].map((i) => `<input id="b${i}" maxlength="1" ${i === 1 ? 'autocomplete="one-time-code"' : ''}>`).join('')}</form>`,
    want: [{ kind: 'totp', totp: 'b1', totpBoxes: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'], newPasswords: [] }],
  },
  {
    name: 'a newsletter box is no sign in',
    html: `<form><input id="e" type="email" placeholder="Your email"><button>Subscribe</button></form>`,
    want: [],
  },
  {
    name: 'a search box is no sign in',
    html: `<form role="search"><input id="q" name="q" placeholder="Search"><button>Go</button></form>`,
    want: [],
  },
  {
    name: 'a hidden honeypot password is never a login',
    html: `<form><input id="q" name="q" placeholder="Search"><input id="h" type="password" style="position:absolute;left:-9999px;width:1px;height:1px"><input id="h2" type="password" style="display:none"></form>`,
    want: [],
  },
]

for (const c of CASES) {
  test(`form-detect: ${c.name}`, async ({ page }) => {
    expect(await detect(page, c.html)).toEqual(c.want)
  })
}

interface WalletSeen { kind: string; fields: string[] }

async function detectWallet(page: Page, html: string): Promise<WalletSeen[]> {
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`)
  await page.addScriptTag({ content: bundle })
  return page.evaluate(() => {
    const wd = (globalThis as unknown as { walnutWalletDetect: { findWalletGroups(d: Document): Array<{ kind: string; fields: Array<{ el: HTMLElement; part: string }> }> } }).walnutWalletDetect
    return wd.findWalletGroups(document).map((g) => ({ kind: g.kind, fields: g.fields.map((f) => `${f.el.id}:${f.part}`) }))
  })
}

const WALLET_CASES: Array<{ name: string; html: string; want: WalletSeen[] }> = [
  {
    name: 'a card form by autocomplete, with expiry selects',
    html: `<form><input id="n" autocomplete="cc-name"><input id="c" autocomplete="cc-number"><select id="m" autocomplete="cc-exp-month"><option>01</option></select><select id="y" autocomplete="cc-exp-year"><option>2030</option></select><input id="v" autocomplete="cc-csc"></form>`,
    want: [{ kind: 'card', fields: ['n:cc-name', 'c:cc-number', 'm:cc-exp-month', 'y:cc-exp-year', 'v:cc-csc'] }],
  },
  {
    name: 'a card form by its words only',
    html: `<form><input id="c" name="cardnumber" placeholder="Card number"><input id="e" name="exp" placeholder="MM / YY"><input id="v" name="cvc" placeholder="CVC"></form>`,
    want: [{ kind: 'card', fields: ['c:cc-number', 'e:cc-exp', 'v:cc-csc'] }],
  },
  {
    name: 'a shipping address form',
    html: `<form><input id="f" autocomplete="shipping given-name"><input id="a" autocomplete="shipping address-line1"><input id="t" name="city"><input id="z" name="zip"><select id="k" name="country"><option>US</option></select></form>`,
    want: [{ kind: 'identity', fields: ['f:given-name', 'a:address-line1', 't:city', 'z:postal-code', 'k:country'] }],
  },
  {
    name: 'a sign in is no card or address form',
    html: `<form><input id="u" type="email" name="email" autocomplete="username"><input id="p" type="password"><button>Sign in</button></form>`,
    want: [],
  },
  {
    name: 'a newsletter email box is no address form',
    html: `<form><input id="e" type="email" name="email" placeholder="Your email"><button>Subscribe</button></form>`,
    want: [],
  },
]

for (const c of WALLET_CASES) {
  test(`wallet-detect: ${c.name}`, async ({ page }) => {
    expect(await detectWallet(page, c.html)).toEqual(c.want)
  })
}
