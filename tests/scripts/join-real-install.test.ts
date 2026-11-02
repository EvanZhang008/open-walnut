/**
 * A machine that joins with the invite command keeps the Walnut it had, checked with the REAL
 * scripts/join.sh running the REAL scripts/install.sh (tests/core/net/join-script.test.ts and
 * tests/scripts/install-sh.test.ts each run one of them with a stand-in for the other).
 *
 * 2026-11-02 (.github/workflows/fresh-mac-join.yml, "existing Mac"): an older Walnut's `walnut` in
 * ~/.local/bin was pointed at the new install by the join. The last block guards the class: the
 * only write either script makes into the PATH directory is install.sh's link after ours_on_path,
 * so a new write that could replace another Walnut's command fails here.
 *
 * Runs against a local server laid out like GitHub Releases, with stand-in files (shell scripts).
 */
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { serveReleases } from '../../scripts/release-rehearsal/runtime.mjs'
import { guardedPath } from '../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../..')
const INSTALL_SH = path.join(ROOT, 'scripts/install.sh')
const JOIN_SH = path.join(ROOT, 'scripts/join.sh')
const HOST = `${process.platform}-${process.arch}`
const TICKET = 'wn1-eyJ2IjoxfQ'
const NPM_TARGET = '../lib/node_modules/open-walnut/bin/open-walnut.js'
let scratch = ''
let releases = ''
let server: { url: string; close: () => Promise<void> }

const sha = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex')

/** The release's file: prints its version, and joins (`net join --help` names the ticket). */
const NEW_WALNUT = `#!/bin/sh
case "$1" in
  --version) echo '0.8.0 (abc12345, 2026-11-02)' ;;
  net) if [ "$3" = "--help" ]; then echo 'Usage: walnut net join <companion-or-ticket>'; echo 'the ticket of a Mac with no companion'; exit 0; fi
       echo "JOINED $*" ;;
esac
`

function releaseFile(version: string, script: string): void {
  const dir = path.join(releases, `v${version}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = Buffer.from(script)
  const name = `walnut-${version}-${HOST}`
  const gz = zlib.gzipSync(file)
  fs.writeFileSync(path.join(dir, `${name}.gz`), gz)
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sha(gz)}  ${name}.gz\n${sha(file)}  ${name}\n`)
  fs.writeFileSync(path.join(releases, 'latest'), `${version}\n`)
}

/**
 * An older Walnut installed with npm under the prefix ~/.local: the package in lib/node_modules,
 * `walnut` and `open-walnut` in ~/.local/bin linked into it. Every run of it is written to `calls`,
 * so a test sees whether anything ran or updated it.
 */
function npmWalnut(home: string): { bin: string; file: string; calls: string } {
  const pkg = path.join(home, '.local/lib/node_modules/open-walnut/bin')
  const calls = path.join(home, 'npm-walnut-calls')
  fs.mkdirSync(pkg, { recursive: true })
  const file = path.join(pkg, 'open-walnut.js')
  fs.writeFileSync(file, `#!/bin/sh\necho "$*" >> '${calls}'\necho '0.6.5 (npm)'\n`, { mode: 0o755 })
  const bin = path.join(home, '.local/bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const name of ['walnut', 'open-walnut']) fs.symlinkSync(NPM_TARGET, path.join(bin, name))
  return { bin, file, calls }
}

function join(home: string, extraPath: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('/bin/sh', [JOIN_SH, TICKET], {
      env: {
        PATH: guardedPath(extraPath, '/usr/bin:/bin:/usr/sbin:/sbin'), HOME: home,
        OPEN_WALNUT_RELEASE_BASE_URL: server.url,
        OPEN_WALNUT_RELEASES_API: `${server.url}/api.json`,
        WALNUT_JOIN_INSTALL_URL: `file://${INSTALL_SH}`,
      },
      timeout: 30_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` }))
  })
}

beforeAll(async () => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'join-real-install-')))
  releases = path.join(scratch, 'releases')
  fs.mkdirSync(releases)
  server = await serveReleases(releases)
})
afterAll(async () => {
  await server.close()
  fs.rmSync(scratch, { recursive: true, force: true })
})
beforeEach(() => {
  fs.rmSync(releases, { recursive: true, force: true })
  fs.mkdirSync(releases)
  releaseFile('0.8.0', NEW_WALNUT)
})

describe('the invite script with the real installer, on a machine with an older npm Walnut', () => {
  it('joins with the file install.sh puts down, and never runs, updates or relinks the npm one', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'home-'))
    const npm = npmWalnut(home)
    const before = fs.readFileSync(npm.file, 'utf8')
    const r = await join(home, [npm.bin])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`JOINED net join ${TICKET} --steps`)
    for (const name of ['walnut', 'open-walnut']) expect(fs.readlinkSync(path.join(npm.bin, name)), name).toBe(NPM_TARGET)
    expect(fs.readFileSync(npm.file, 'utf8')).toBe(before)
    expect(fs.existsSync(npm.calls) ? fs.readFileSync(npm.calls, 'utf8') : '').toBe('')
    expect(fs.existsSync(path.join(home, '.local/share/open-walnut/bin/walnut'))).toBe(true)
  })

  it('on a machine with no Walnut, links walnut into ~/.local/bin as before', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'home-'))
    const r = await join(home, [])
    expect(r.code, r.out).toBe(0)
    expect(fs.readlinkSync(path.join(home, '.local/bin/walnut'))).toBe(path.join(home, '.local/share/open-walnut/bin/walnut'))
  })
})

/** Code lines of a shell script that change a path naming `dir` (a command, or a redirect into it). */
function writesInto(file: string, dir: RegExp): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => new RegExp(`(^|[;&|]\\s*|\\b(then|do|else)\\s+)(ln|mv|cp|rm|install|tee|touch|chmod|unlink)\\s[^#]*${dir.source}`).test(l)
      || new RegExp(`>>?\\s*"?${dir.source}`).test(l))
}

describe('the class: what the join and the installer write into the PATH directory', () => {
  it("install.sh's only write there is the link finish() makes after ours_on_path", () => {
    const text = fs.readFileSync(INSTALL_SH, 'utf8')
    // A new one fails here: route it through ours_on_path (another Walnut's command is never replaced).
    expect(writesInto(INSTALL_SH, /\$\{?bin_dir/)).toEqual(['ln -sfn "$install_dir/bin/walnut" "$bin_dir/$name"'])
    const at = text.indexOf('ln -sfn "$install_dir/bin/walnut" "$bin_dir/$name"')
    expect(text.slice(Math.max(0, at - 260), at)).toContain('if ! ours_on_path "$bin_dir/$name"; then')
  })

  it('join.sh writes nothing there itself: it only names the directory to the installer', () => {
    expect(writesInto(JOIN_SH, /(\$\{?walnut_join_bin|\$HOME\/\.local\/bin|~\/\.local\/bin)/)).toEqual([])
  })
})
