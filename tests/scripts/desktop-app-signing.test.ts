/**
 * Every signature the Mac app's build scripts put on Walnut.app with a real identity keeps the
 * hardened runtime and the app's entitlements. Walnut takes the Mac app's Touch ID key only from a
 * process running the signed app under the hardened runtime (src/core/approvals/mac-app-proof.ts).
 * 2026-11-08 desktop/build.sh began signing the app a second time, after embedding Demo, with a plain
 * `codesign --force --sign`, which drops both; every app it built since ran without the runtime and
 * read as "not the Mac app" (found 2026-11-18). Enumerated from the scripts: every codesign that signs
 * the app bundle with an identity, a new one included.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** Each command of a shell script on one line (backslash continuations joined), with its line number. */
function commands(text: string): Array<{ line: number; cmd: string }> {
  const out: Array<{ line: number; cmd: string }> = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const start = i
    let cmd = lines[i]!
    while (cmd.endsWith('\\') && i + 1 < lines.length) cmd = cmd.slice(0, -1) + ' ' + lines[++i]!
    out.push({ line: start + 1, cmd })
  }
  return out
}

const scripts = fs.readdirSync(path.join(ROOT, 'desktop')).filter((f) => f.endsWith('.sh')).map((f) => `desktop/${f}`)

/** codesign calls that sign Walnut.app ("$APP_BUNDLE", or the bundle by name) with an identity, not ad hoc (`--sign -`). */
const appSignings = scripts.flatMap((file) => commands(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  .filter(({ cmd }) => /\bcodesign\b[^;|&]*(--sign|\s-s)\s/.test(cmd) && !/(--sign|\s-s)\s+-(\s|$)/.test(cmd)
    && /"\$APP_BUNDLE"|\/Walnut\.app"?(\s|$)/.test(cmd))
  .map((c) => ({ file, ...c })))

describe('the Mac app is always signed with the hardened runtime and its entitlements', () => {
  it('finds the signings of both build scripts', () => {
    expect(appSignings.map((s) => s.file)).toEqual(expect.arrayContaining(['desktop/build.sh', 'desktop/build-release.sh']))
  })

  it.each(appSignings.map((s) => [`${s.file}:${s.line}`, s] as const))('%s', (_where, { cmd }) => {
    expect(cmd, 'sign Walnut.app with --options runtime').toMatch(/--options[ =]runtime\b/)
    expect(cmd, 'sign Walnut.app with its entitlements').toMatch(/--entitlements\s/)
  })

  it('desktop/build.sh refuses an app that came out without the runtime', () => {
    const text = fs.readFileSync(path.join(ROOT, 'desktop/build.sh'), 'utf8')
    const last = text.lastIndexOf('--options runtime --entitlements')
    expect(last).toBeGreaterThan(text.indexOf('build-demo.sh'))
    expect(text.slice(last)).toMatch(/codesign -dvvv "\$APP_BUNDLE"[\s\S]*runtime[\s\S]*exit 1/)
  })
})
