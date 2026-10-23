/**
 * desktop/notarize.sh against a stand-in `xcrun` that answers each call from a
 * script. 2026-10-23: the x64 app of 0.6.17 was uploaded, then one poll of its
 * submission timed out on the network ("NSURLErrorDomain -1001") and the build
 * failed as "not accepted". A request that never reached Apple is not Apple's
 * answer: the same submission is waited on again, and nothing is submitted twice.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guardedPath } from '../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../..')
const SCRIPT = path.join(ROOT, 'desktop/notarize.sh')
const ID = '3763f34f-df88-45ec-aa87-4d387e80ec35'
const LOST = `Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1001 "The request timed out." UserInfo={NSErrorFailingURLStringKey=https://appstoreconnect.apple.com/notary/v2/submissions/${ID}?})`
const answer = (status: string) => `{"id":"${ID}","status":"${status}","message":"Processing complete"}`

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notarize-sh-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** Run `notarize app.zip` with `xcrun` answering call N with replies[N] ([exit, output]). */
function run(replies: Array<[number, string]>, env: Record<string, string> = {}) {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  replies.forEach(([code, out], i) => {
    fs.writeFileSync(path.join(dir, `reply-${i}`), out)
    fs.writeFileSync(path.join(dir, `code-${i}`), String(code))
  })
  fs.writeFileSync(path.join(bin, 'xcrun'), `#!/bin/bash
n=$(cat "${dir}/n" 2>/dev/null || echo 0); echo $((n + 1)) > "${dir}/n"
echo "$*" >> "${dir}/calls"
[ -f "${dir}/reply-$n" ] || { echo "no reply scripted for call $n" >&2; exit 99; }
cat "${dir}/reply-$n"; exit "$(cat "${dir}/code-$n")"
`, { mode: 0o755 })
  const r = spawnSync('bash', ['-c', `source "${SCRIPT}"; notarize "${dir}/app.zip"`], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: guardedPath([bin]),
      WALNUT_NOTARY_KEY: '/k.p8', WALNUT_NOTARY_KEY_ID: 'KEYID', WALNUT_NOTARY_ISSUER: 'ISSUER',
      NOTARIZE_RETRY_SECS: '0', ...env,
    },
  })
  const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : []
  return { status: r.status, out: r.stdout + r.stderr, calls }
}

describe('desktop/notarize.sh', () => {
  it('waits on the same submission again when a poll never reached Apple, and passes once it is accepted', () => {
    const r = run([[1, LOST], [0, answer('Accepted')]])
    expect(r.status).toBe(0)
    expect(r.calls).toHaveLength(2)
    expect(r.calls[0]).toMatch(/^notarytool submit .*app\.zip .*--wait/)
    expect(r.calls[1]).toMatch(new RegExp(`^notarytool wait ${ID} `))
    expect(r.out).toContain(`No answer from Apple about submission ${ID}`)
  })

  it('keeps waiting through several lost polls', () => {
    const r = run([[1, LOST], [1, LOST], [1, 'Error: The network connection was lost. submissions/' + ID], [0, answer('Accepted')]])
    expect(r.status).toBe(0)
    expect(r.calls.filter((c) => c.startsWith('notarytool submit'))).toHaveLength(1)
    expect(r.calls.filter((c) => c.startsWith(`notarytool wait ${ID}`))).toHaveLength(3)
  })

  it('passes at once when the first answer is Accepted', () => {
    const r = run([[0, answer('Accepted')]])
    expect(r.status).toBe(0)
    expect(r.calls).toHaveLength(1)
  })

  it('fails on a rejection and prints its log, without waiting again', () => {
    const r = run([[1, answer('Invalid')], [0, '{"issues":[{"message":"The binary is not signed."}]}']])
    expect(r.status).toBe(1)
    expect(r.calls[1]).toMatch(new RegExp(`^notarytool log ${ID} `))
    expect(r.out).toContain('The binary is not signed.')
    expect(r.out).toContain('was not accepted')
  })

  it('names the submission as unfinished, not rejected, when Apple never answers within the budget', () => {
    const r = run([[1, LOST], [1, LOST], [1, LOST]], { NOTARIZE_BUDGET_SECS: '1', NOTARIZE_RETRY_SECS: '1' })
    expect(r.status).toBe(1)
    expect(r.calls.filter((c) => c.startsWith('notarytool submit'))).toHaveLength(1)
    expect(r.out).toContain(`had not finished notarizing app.zip`)
    expect(r.out).toContain(`submission ${ID}, not rejected`)
    expect(r.out).not.toContain('was not accepted')
  })

  it('fails without waiting when the upload itself never made a submission', () => {
    const r = run([[1, 'Error: HTTPError(statusCode: 401, error: unauthorized)']])
    expect(r.status).toBe(1)
    expect(r.calls).toHaveLength(1)
    expect(r.out).toContain('was not accepted')
  })

  it('is what build-release.sh notarizes with, for the app and the DMG', () => {
    const build = fs.readFileSync(path.join(ROOT, 'desktop/build-release.sh'), 'utf8')
    expect(build).toContain('source "$SCRIPT_DIR/notarize.sh"')
    expect(build).not.toMatch(/^notarize\(\) \{/m)
    expect(build.indexOf('source "$SCRIPT_DIR/notarize.sh"')).toBeLessThan(build.indexOf('notarize "$APP_ZIP"'))
    expect(build).toContain('notarize "$DMG_OUT"')
  })
})
