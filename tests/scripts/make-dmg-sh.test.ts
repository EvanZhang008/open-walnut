/**
 * desktop/make-dmg.sh against a stand-in `hdiutil` that answers each call from a
 * script. 2026-10-31: the arm64 app of 0.6.21 was signed and notarized, then
 * `hdiutil create` failed with "No space left on device" on a runner with
 * gigabytes free (its own size estimate ran short). The image is sized from the
 * folder with room to spare, and a failed create is tried again, larger.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guardedPath } from '../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../..')
const SCRIPT = path.join(ROOT, 'desktop/make-dmg.sh')
const FULL = 'hdiutil: create failed - No space left on device'

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'make-dmg-sh-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** Run make_dmg with `hdiutil` exiting codes[N] on call N (writing the image on 0). */
function run(codes: number[], tries = 3) {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const src = path.join(dir, 'staging')
  fs.mkdirSync(src)
  fs.writeFileSync(path.join(src, 'app.bin'), Buffer.alloc(2 * 1024 * 1024))
  codes.forEach((code, i) => fs.writeFileSync(path.join(dir, `code-${i}`), String(code)))
  fs.writeFileSync(path.join(bin, 'hdiutil'), `#!/bin/bash
n=$(cat "${dir}/n" 2>/dev/null || echo 0); echo $((n + 1)) > "${dir}/n"
echo "$*" >> "${dir}/calls"
code=$(cat "${dir}/code-$n" 2>/dev/null || echo 99)
if [ "$code" = 0 ]; then out="\${@: -1}"; echo dmg > "$out"; else echo "${FULL}" >&2; fi
exit "$code"
`, { mode: 0o755 })
  const out = path.join(dir, 'Walnut.dmg')
  const r = spawnSync('bash', ['-c', `set -euo pipefail; source "${SCRIPT}"; make_dmg Walnut "${src}" "${out}"`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: guardedPath([bin], '/usr/bin:/bin'), MAKE_DMG_TRIES: String(tries), MAKE_DMG_RETRY_SECS: '0' },
  })
  const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : []
  return { code: r.status, stderr: r.stderr, calls, made: fs.existsSync(out) }
}

const sizeOf = (call: string) => Number(/-size (\d+)m/.exec(call)?.[1])

describe('make_dmg', () => {
  it('names a size with room over the folder, and makes the image in one call', () => {
    const r = run([0])
    expect(r.code).toBe(0)
    expect(r.made).toBe(true)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]).toContain('-format UDZO')
    expect(r.calls[0]).toContain('-volname Walnut')
    // 2 MB of files: at least the 50 MB floor above them.
    expect(sizeOf(r.calls[0])).toBeGreaterThanOrEqual(52)
  })

  it('a create that runs out of room is tried again, larger, and the image is made', () => {
    const r = run([1, 1, 0])
    expect(r.code).toBe(0)
    expect(r.made).toBe(true)
    expect(r.calls).toHaveLength(3)
    expect(sizeOf(r.calls[1])).toBeGreaterThan(sizeOf(r.calls[0]))
    expect(sizeOf(r.calls[2])).toBeGreaterThan(sizeOf(r.calls[1]))
    expect(r.stderr).toContain('try 1 of 3 failed')
  })

  it('fails after its tries with hdiutil\'s words, the sizes and the free space', () => {
    const r = run([1, 1, 1])
    expect(r.code).not.toBe(0)
    expect(r.calls).toHaveLength(3)
    expect(r.stderr).toContain(FULL)
    expect(r.stderr).toMatch(/the folder holds \d+ KB, the image was \d+ MB; free space/)
    expect(r.made).toBe(false)
  })

  it('build-release.sh makes its DMG through make_dmg, never a bare hdiutil create', () => {
    const src = fs.readFileSync(path.join(ROOT, 'desktop/build-release.sh'), 'utf8')
    expect(src).toContain('make_dmg "$APP_NAME" "$DMG_TEMP" "$DMG_OUT"')
    expect(src).not.toMatch(/^\s*hdiutil create/m)
  })
})
