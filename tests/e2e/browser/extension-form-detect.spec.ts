/**
 * The extension's form reading (packages/browser-extension/src/form-detect.ts) in a real
 * browser, so layout counts (a hidden honeypot field, a zero-size input): the shapes login,
 * sign-up, password-change, two-step and one-time-code pages come in, and the look-alikes that
 * are none of them (a newsletter box, a search box). Each case says what a person sees.
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
  fs.writeFileSync(entry, `import * as fd from ${JSON.stringify(src)}\n;(globalThis as any).walnutFormDetect = fd\n`)
  execFileSync(bunRuntime(), ['build', entry, '--format', 'iife', '--target', 'browser', '--outfile', path.join(dir, 'fd.js')], { stdio: 'pipe' })
  bundle = fs.readFileSync(path.join(dir, 'fd.js'), 'utf8')
})

interface Seen { kind: string; username?: string; password?: string; newPasswords: string[]; totp?: string }

async function detect(page: Page, html: string): Promise<Seen[]> {
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`)
  await page.addScriptTag({ content: bundle })
  return page.evaluate(() => {
    const fd = (globalThis as unknown as { walnutFormDetect: { findLoginGroups(d: Document): Array<{ kind: string; username?: HTMLInputElement; password?: HTMLInputElement; newPasswords: HTMLInputElement[]; totp?: HTMLInputElement }> } }).walnutFormDetect
    return fd.findLoginGroups(document).map((g) => ({
      kind: g.kind,
      ...(g.username ? { username: g.username.id } : {}),
      ...(g.password ? { password: g.password.id } : {}),
      newPasswords: g.newPasswords.map((p) => p.id),
      ...(g.totp ? { totp: g.totp.id } : {}),
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
