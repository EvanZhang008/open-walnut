/**
 * A type check a script runs goes under a working node when the machine has one, never under bun
 * alone (2026-11-22: web/'s `tsc --noEmit` peaked at 8.3 GB under bun and 3.7 GB under node, in about
 * the same time; two such checks and a deploy's held 11.2 GB on a 48 GB Mac whose memory was tight).
 *
 * The class: every line of a shell script under scripts/ that starts TypeScript's compiler through a
 * runtime (`<runtime> …/tsc`, `…/typescript/bin/tsc`, `…/tsc.js`, `bun x tsc`, `bunx tsc`, or a
 * variable naming one). Such a line names "$TSC_RUNTIME" (scripts/lib/tsc-runtime.sh), so a new script
 * that copies an old bun line fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.join(import.meta.dirname, '..', '..')

function shellScripts(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...shellScripts(p))
    else if (e.name.endsWith('.sh')) out.push(p)
  }
  return out
}

const RUNTIME = String.raw`(?:"?\$\{?[A-Za-z_]+\}?"?|\bbun|\bnode)`
const TSC_PATH = String.raw`"?[^\s"]*(?:\.bin\/tsc|typescript\/bin\/tsc|\/tsc\.js|\$\{?[A-Za-z_]*TSC\}?)\b`
/** A command line that runs the compiler through a runtime. */
const RUNS_TSC = new RegExp(String.raw`${RUNTIME}\s+${TSC_PATH}|\bbunx?\s+(?:x\s+)?tsc\b`)

describe('type checks in scripts run under a working node when there is one', () => {
  const lines = shellScripts(path.join(ROOT, 'scripts')).flatMap((file) =>
    fs.readFileSync(file, 'utf-8').split('\n').map((text, i) => ({ file: path.relative(ROOT, file), line: i + 1, text })))
    .filter((l) => !/^\s*#/.test(l.text) && RUNS_TSC.test(l.text))

  it('finds the deploy\'s web/ check and the committed-bundle check (the class is not empty)', () => {
    const files = new Set(lines.map((l) => l.file))
    expect(files.has('scripts/dev-prod.sh')).toBe(true)
    expect(files.has('scripts/check-committed-bundle.sh')).toBe(true)
  })

  it('the pattern catches the spellings a copied line would use', () => {
    for (const old of [
      'nice -n "$BUILD_NICE" "$JS_BIN" "$WEB_TSC" --noEmit -p tsconfig.json',
      '(cd "$TMP" && "$BUN" "$OLDPWD/$TSC" --noEmit)',
      'bun x tsc --noEmit', 'bunx tsc -p web', 'bun node_modules/typescript/bin/tsc --noEmit', '"$JS_BIN" node_modules/typescript/lib/tsc.js',
    ]) expect(RUNS_TSC.test(old), old).toBe(true)
  })

  it('names "$TSC_RUNTIME" on every such line', () => {
    const wrong = lines.filter((l) => !/"\$TSC_RUNTIME"/.test(l.text)).map((l) => `${l.file}:${l.line}: ${l.text.trim()}`)
    expect(wrong).toEqual([])
  })

  it('every script that runs one sources scripts/lib/tsc-runtime.sh', () => {
    for (const file of new Set(lines.map((l) => l.file))) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf-8'), file).toMatch(/scripts\/lib\/tsc-runtime\.sh"?\n\s*walnut_tsc_runtime /)
    }
  })

  describe('walnut_tsc_runtime', () => {
    const lib = path.join(ROOT, 'scripts', 'lib', 'tsc-runtime.sh')
    const pick = (dirs: string[]) => execFileSync('/bin/bash', ['-c', `. "${lib}"; walnut_tsc_runtime /opt/bun/bin/bun; printf %s "$TSC_RUNTIME"`], {
      env: { PATH: dirs.join(':') }, encoding: 'utf-8',
    })
    const withTmp = (fn: (dir: string) => void) => {
      const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'tsc-rt-'))
      try { fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    }
    // A stand-in node: answers the version probe with the major it is given.
    const fakeNode = (dir: string, major: number | 'broken') => {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'node'), major === 'broken'
        ? '#!/bin/sh\necho "node: /lib64/libc.so.6: version GLIBC_2.28 not found" >&2; exit 127\n'
        : `#!/bin/sh\n[ "$1" = -e ] || exit 3\n[ ${major} -ge "\${WALNUT_TSC_MIN_NODE:-18}" ]\n`, { mode: 0o755 })
    }

    it('takes a node new enough to run the compiler', () => withTmp((dir) => {
      fakeNode(path.join(dir, 'ok'), 22)
      expect(pick([path.join(dir, 'ok'), '/usr/bin', '/bin'])).toBe(path.join(dir, 'ok', 'node'))
    }))
    it('passes over a node that cannot start (a newer glibc) or is too old, and keeps bun', () => withTmp((dir) => {
      fakeNode(path.join(dir, 'broken'), 'broken')
      expect(pick([path.join(dir, 'broken'), '/usr/bin', '/bin'])).toBe('/opt/bun/bin/bun')
      fakeNode(path.join(dir, 'old'), 12)
      expect(pick([path.join(dir, 'old'), '/usr/bin', '/bin'])).toBe('/opt/bun/bin/bun')
    }))
    it('keeps bun on a machine with no node', () => withTmp((dir) => {
      fs.mkdirSync(path.join(dir, 'empty'))
      expect(pick([path.join(dir, 'empty')])).toBe('/opt/bun/bin/bun')
    }))
  })
})
