/**
 * run-ui-tests.sh writes the runner's environment into the .xctestrun with
 * plistlib, and picks a python whose plistlib loads. 2026-11-03 on a fleet Mac:
 * the first python3 on PATH was a Homebrew build whose pyexpat did not load
 * ("Symbol not found: _XML_SetAllocTrackerActivationThreshold"), and every UI run
 * there died at "xctestrun injection failed". The system python always has it.
 *
 * The lines that pick it are cut out of the real script and run in sh with a fake
 * python3 first on PATH; nothing else of the script runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard-core.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const RUN_UI = path.join(REPO, 'ios-native/tests/ui/run-ui-tests.sh')
const SYSTEM_PY = fs.existsSync('/usr/bin/python3')

/** The script's own lines, from `PLIST_PY=""` through the line that refuses with none. */
function pickLines(): string {
  const lines = fs.readFileSync(RUN_UI, 'utf-8').split('\n')
  const from = lines.findIndex((l) => l.trim() === 'PLIST_PY=""')
  const to = lines.findIndex((l, i) => i > from && l.includes('die "no python3 here can load plistlib'))
  expect(from).toBeGreaterThan(-1)
  expect(to).toBeGreaterThan(from)
  return lines.slice(from, to + 1).join('\n')
}

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-plist-py-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function fakePython(exitCode: number): void {
  fs.writeFileSync(path.join(dir, 'python3'), `#!/bin/sh\necho "fake python3 $*" >&2\nexit ${exitCode}\n`, { mode: 0o755 })
}

function pick(): { out: string; code: number | null } {
  const script = `die() { echo "DIE: $*"; exit 3; }\n${pickLines()}\necho "PICKED=$PLIST_PY"\n`
  const r = spawnSync('/bin/sh', ['-c', script], { env: { PATH: guardedPath([dir], '/usr/bin:/bin'), HOME: dir }, encoding: 'utf-8' })
  return { out: r.stdout, code: r.status }
}

describe('run-ui-tests.sh picks a python whose plistlib loads', () => {
  it('the first python3 on PATH when its plistlib loads', () => {
    fakePython(0)
    expect(pick()).toEqual({ out: 'PICKED=python3\n', code: 0 })
  })

  it.runIf(SYSTEM_PY)('the system python when the one on PATH cannot load plistlib', () => {
    fakePython(1)
    expect(pick()).toEqual({ out: 'PICKED=/usr/bin/python3\n', code: 0 })
  })

  it('carries the isolated demo opt-in to the actual runner', () => {
    const text = fs.readFileSync(RUN_UI, 'utf-8')
    expect(text).toContain('[ "${WALNUT_UITEST_MAY_ERASE_APP_DATA:-}" = 1 ]')
    expect(text).toContain("'WALNUT_UITEST_MAY_ERASE_APP_DATA'):")
  })

  it('injects with the python it picked, never a bare python3', () => {
    const text = fs.readFileSync(RUN_UI, 'utf-8')
    expect(text).toMatch(/"\$PLIST_PY" - "\$XCTESTRUN"/)
    expect(text).not.toMatch(/^\s*python3 - "\$XCTESTRUN"/m)
  })
})
