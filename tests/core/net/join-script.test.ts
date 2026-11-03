/**
 * The invite script on a new machine, run for real with stand-in Walnuts: the release is
 * older than the Walnut that made the invite (2026-11-02: 0.6.23 has no `net join`, answers
 * `net join --help` with its top-level help and exit 0, so the script took it for one that
 * joins and stopped at "unknown option '--steps'"). It must take the preview build then,
 * and say what to run when even that does not install. The preview build can be numbered
 * below the release (2026-11-03: 0.6.24-nightly.* after 0.6.24), where `update --channel
 * nightly` does nothing: then it comes straight from npm (a stand-in registry here).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { joinScript } from '../../../src/core/net/net-join-script.js'
import { guardedPath } from '../../setup/exec-guard.js'

let dir = ''
let home = ''
const INSTALLED = '.local/share/open-walnut/bin/walnut'

// A stand-in `walnut`: `old` has no `net join` (0.6.23), `new` joins; `update --channel
// nightly` puts `new` in its place unless the preview build is unreachable.
type Nightly = 'ok' | 'fails' | 'lower'

function fake(kind: 'old' | 'new', nightly: Nightly = 'ok'): string {
  const help = kind === 'new'
    ? `Usage: walnut net join [options] <companion-or-ticket> [code]\\nthe ticket of a Mac with no companion\\n  --steps  Continue the numbered steps`
    : `Usage: walnut [options] [command]\\nOpen Walnut`
  return `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$1" in
  --version) echo "${kind === 'new' ? '0.6.24-nightly.1' : '0.6.23'}" ;;
  net) if [ "$3" = "--help" ]; then printf '${help}\\n'; exit 0; fi
       ${kind === 'new' ? `echo "JOINED $*"; exit 0` : `echo "error: unknown option '--steps'" >&2; exit 1`} ;;
  update) # The real one answers "the check is off" and exits 0 under these switches.
          if [ -n "$WALNUT_NO_UPDATE_CHECK$NO_UPDATE_NOTIFIER" ]; then echo "the update check is off"; exit 0; fi
          if [ "$2" = "--channel" ] && [ "$3" = "nightly" ]; then
            ${nightly === 'ok' ? `cp "${dir}/new" "$0"` : nightly === 'lower' ? 'echo "Open Walnut 0.6.23 is the newest on the nightly channel."' : 'echo "npm ERR! registry unreachable" >&2; exit 1'}
          fi ;;
esac
`
}

/**
 * A stand-in npm registry (curl reads `%2f` in a file URL as `/`): the preview build is
 * `new`, packed the way npm packs @open-walnut/<target>, with its sha512 as npm gives it.
 * `integrity: 'wrong'` names another file's.
 */
function registry(opts: { preview?: boolean; integrity?: 'right' | 'wrong'; binary?: 'new' | 'old' } = {}): void {
  const npm = path.join(dir, 'npm')
  fs.rmSync(npm, { recursive: true, force: true })
  if (opts.preview === false) return
  const pkg = path.join(dir, 'pkg', 'package')
  fs.mkdirSync(pkg, { recursive: true })
  fs.copyFileSync(path.join(dir, opts.binary ?? 'new'), path.join(pkg, 'walnut'))
  const tgz = path.join(npm, 't', 'linux-x64-0.6.24-nightly.1.tgz')
  fs.mkdirSync(path.dirname(tgz), { recursive: true })
  expect(spawnSync('tar', ['-czf', tgz, '-C', path.join(dir, 'pkg'), 'package']).status).toBe(0)
  const body = opts.integrity === 'wrong' ? Buffer.from('another file') : fs.readFileSync(tgz)
  const integrity = `sha512-${crypto.createHash('sha512').update(body).digest('base64')}`
  fs.mkdirSync(path.join(npm, '-/package/@open-walnut/linux-x64'), { recursive: true })
  fs.writeFileSync(path.join(npm, '-/package/@open-walnut/linux-x64/dist-tags'), JSON.stringify({ latest: '0.6.24', nightly: '0.6.24-nightly.1' }))
  fs.mkdirSync(path.join(npm, '@open-walnut/linux-x64'), { recursive: true })
  fs.writeFileSync(path.join(npm, '@open-walnut/linux-x64/0.6.24-nightly.1'), JSON.stringify({
    name: '@open-walnut/linux-x64', version: '0.6.24-nightly.1',
    dist: { shasum: 'x', tarball: `file://${tgz}`, fileCount: 2, integrity },
  }))
}

function setup(installed: 'none' | 'old' | 'new', nightly: Nightly = 'ok'): void {
  fs.writeFileSync(path.join(dir, 'new'), fake('new'), { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'old'), fake('old', nightly), { mode: 0o755 })
  // install.sh puts the release (old) where the real one does, and links walnut to it in
  // OPEN_WALNUT_BIN_DIR (~/.local/bin), over whatever is there, as the 0.6.23 one does.
  // With OPEN_WALNUT_VERSION and a release laid out at OPEN_WALNUT_RELEASE_BASE_URL, it
  // installs that version's plain file instead (as the real one takes from a file:// release),
  // after checking SHA256SUMS lists it.
  fs.writeFileSync(path.join(dir, 'install.sh'), `d="$HOME/.local/share/open-walnut/bin"; b="\${OPEN_WALNUT_BIN_DIR:-$HOME/.local/bin}"; mkdir -p "$d" "$b" || exit 1
if [ -n "\${OPEN_WALNUT_VERSION:-}" ] && [ -n "\${OPEN_WALNUT_RELEASE_BASE_URL:-}" ]; then
  r="\${OPEN_WALNUT_RELEASE_BASE_URL#file://}/v$OPEN_WALNUT_VERSION"; f="walnut-$OPEN_WALNUT_VERSION-$OPEN_WALNUT_TARGET"
  grep -q " $f\$" "$r/SHA256SUMS" || { echo "no $f in SHA256SUMS" >&2; exit 1; }
  cp "$r/$f" "$d/walnut" && chmod 755 "$d/walnut" || exit 1
else
  cp "${dir}/old" "$d/walnut" || exit 1
fi
ln -sfn "$d/walnut" "$b/walnut"\n`)
  registry()
  if (installed !== 'none') {
    fs.mkdirSync(path.join(home, INSTALLED, '..'), { recursive: true })
    fs.copyFileSync(path.join(dir, installed), path.join(home, INSTALLED))
  }
}

function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const file = path.join(dir, 'join.sh')
  fs.writeFileSync(file, script)
  const r = spawnSync('sh', [file, ...args], {
    encoding: 'utf8',
    env: {
      HOME: home, PATH: guardedPath([], '/usr/bin:/bin'), WALNUT_JOIN_INSTALL_URL: `file://${path.join(dir, 'install.sh')}`,
      WALNUT_JOIN_NPM_REGISTRY: `file://${path.join(dir, 'npm')}`, OPEN_WALNUT_TARGET: 'linux-x64', TMPDIR: tmp(), ...env,
    },
  })
  const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8') : ''
  return { ...r, calls }
}

const TICKET = 'wn1-eyJ2IjoxfQ'

/** The script's own TMPDIR: whatever it leaves there is a leftover. */
function tmp(): string {
  const t = path.join(dir, 'tmp')
  fs.mkdirSync(t, { recursive: true })
  return t
}
const companion = () => joinScript({ origin: 'https://wn.example', code: 'AAAA-BBBB-CCCC' })

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'join-script-')))
  home = path.join(dir, 'home')
  fs.mkdirSync(home)
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('the invite script when the release cannot join yet', () => {
  for (const [name, script, args, joined] of [
    ['a companion invite', companion, [], 'JOINED net join https://wn.example AAAA-BBBB-CCCC --steps'],
    ['a ticket (scripts/join.sh)', () => joinScript({ ticket: true }), [TICKET], `JOINED net join ${TICKET} --steps`],
  ] as const) {
    it(`${name}: a new machine gets the preview build and joins`, () => {
      setup('none')
      const r = run(script(), [...args])
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('1/3  Walnut ............ installing')
      expect(r.stdout).toContain('the release cannot join yet, installing the preview build')
      expect(r.stdout).toContain('1/3  Walnut ............ installed (0.6.24-nightly.1)')
      expect(r.stdout).toContain(joined)
      expect(r.calls).toContain('update --channel nightly')
    })

    it(`${name}: an old Walnut already there is moved to the preview build`, () => {
      setup('old')
      const r = run(script(), [...args])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain(joined)
    })

    it(`${name}: says what happened when the preview build does not install`, () => {
      setup('none', 'fails')
      registry({ preview: false })
      const r = run(script(), [...args])
      expect(r.status).toBe(1)
      expect(r.stdout).not.toContain('JOINED')
      expect(r.stderr).toContain('npm ERR! registry unreachable')
      expect(r.stderr).toContain("npm did not answer for Walnut's preview build (linux-x64).")
      expect(r.stderr).toContain('This Walnut (0.6.23) is too old to join, and the preview build did not install (above). Run this again in a few minutes.')
    })

    it(`${name}: a preview build numbered below the release comes straight from npm`, () => {
      setup('none', 'lower')
      const r = run(script(), [...args])
      expect(r.status, r.stderr).toBe(0)
      expect(r.calls).toContain('update --channel nightly')
      expect(r.stdout).toContain('1/3  Walnut ............ installing the preview build 0.6.24-nightly.1 from npm')
      expect(r.stdout).toContain('1/3  Walnut ............ installed (0.6.24-nightly.1)')
      expect(r.stdout).toContain(joined)
      // The file install.sh put down is the preview build, and nothing is left behind in TMPDIR.
      expect(fs.readFileSync(path.join(home, INSTALLED), 'utf8')).toBe(fs.readFileSync(path.join(dir, 'new'), 'utf8'))
      expect(fs.readdirSync(tmp())).toEqual([])
    })

    it(`${name}: a preview build that cannot join either is never installed`, () => {
      setup('old', 'lower')
      registry({ binary: 'old' })
      const r = run(script(), [...args])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('The preview build 0.6.24-nightly.1 cannot join either; nothing was installed.')
      expect(fs.readFileSync(path.join(home, INSTALLED), 'utf8')).toBe(fs.readFileSync(path.join(dir, 'old'), 'utf8'))
    })

    it(`${name}: a preview build the installer refuses leaves nothing behind in TMPDIR`, () => {
      setup('none', 'lower')
      // The installer takes the release, then refuses the preview build.
      fs.writeFileSync(path.join(dir, 'install.sh'), `d="$HOME/.local/share/open-walnut/bin"; mkdir -p "$d" || exit 1
if [ -n "\${OPEN_WALNUT_VERSION:-}" ]; then echo "open-walnut install: no room left on this disk" >&2; exit 1; fi
cp "${dir}/old" "$d/walnut"\n`)
      const r = run(script(), [...args])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('open-walnut install: no room left on this disk')
      expect(r.stderr).toContain('the preview build did not install (above). Run this again in a few minutes.')
      expect(fs.readdirSync(tmp())).toEqual([])
    })

    it(`${name}: a preview build that does not match npm's sha512 is never installed`, () => {
      setup('old', 'lower')
      registry({ integrity: 'wrong' })
      const r = run(script(), [...args])
      expect(r.status).toBe(1)
      expect(r.stdout).not.toContain('JOINED')
      expect(r.stderr).toContain('The preview build did not match the sha512 npm gives for it')
      expect(fs.readFileSync(path.join(home, INSTALLED), 'utf8')).toBe(fs.readFileSync(path.join(dir, 'old'), 'utf8'))
    })

    it(`${name}: the update check's off switches do not stop the preview build`, () => {
      setup('none')
      const r = run(script(), [...args], { WALNUT_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' })
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain(joined)
    })

    it(`${name}: another Walnut on PATH (an npm install, an older server's) is never used, nor updated`, () => {
      setup('none')
      const npm = path.join(dir, 'npm-bin')
      fs.mkdirSync(npm)
      fs.copyFileSync(path.join(dir, 'new'), path.join(npm, 'walnut'))
      fs.chmodSync(path.join(npm, 'walnut'), 0o755)
      const before = fs.readFileSync(path.join(npm, 'walnut'), 'utf8')
      const r = run(script(), [...args], { PATH: guardedPath([npm], '/usr/bin:/bin') })
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain('the release cannot join yet')
      expect(r.stdout).toContain(joined)
      expect(fs.readFileSync(path.join(npm, 'walnut'), 'utf8')).toBe(before)
      // Every call went to the file install.sh put down.
      expect(fs.readFileSync(path.join(home, INSTALLED), 'utf8')).toBe(fs.readFileSync(path.join(dir, 'new'), 'utf8'))
    })

    it(`${name}: another Walnut's walnut in ~/.local/bin (a wrapper, an npm link) stays as it is`, () => {
      setup('none')
      const bin = path.join(home, '.local/bin')
      fs.mkdirSync(bin, { recursive: true })
      const wrapper = '#!/bin/sh\nexec /opt/elsewhere/walnut "$@"\n'
      fs.writeFileSync(path.join(bin, 'walnut'), wrapper, { mode: 0o755 })
      const r = run(script(), [...args])
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toContain(joined)
      expect(fs.readFileSync(path.join(bin, 'walnut'), 'utf8')).toBe(wrapper)
      // This install's own link went inside the install.
      expect(fs.readlinkSync(path.join(home, '.local/share/open-walnut/links/walnut'))).toBe(path.join(home, INSTALLED))
    })

    it(`${name}: the session daemon's walnut script stays when it hands over to another Walnut, and is replaced when it does not`, () => {
      setup('none')
      const bin = path.join(home, '.local/bin')
      fs.mkdirSync(bin, { recursive: true })
      const shim = '#!/bin/sh\n# walnut-user-shim v1 \u2014 installed by the Walnut session daemon. Safe to delete.\n'
      fs.writeFileSync(path.join(bin, 'walnut'), shim, { mode: 0o755 })
      const npm = path.join(dir, 'npm-bin')
      fs.mkdirSync(npm)
      fs.writeFileSync(path.join(npm, 'walnut'), '#!/bin/sh\necho npm walnut\n', { mode: 0o755 })
      const kept = run(script(), [...args], { PATH: guardedPath([npm], '/usr/bin:/bin') })
      expect(kept.status, kept.stderr).toBe(0)
      expect(fs.readFileSync(path.join(bin, 'walnut'), 'utf8')).toBe(shim)
      expect(fs.readlinkSync(path.join(home, '.local/share/open-walnut/links/walnut'))).toBe(path.join(home, INSTALLED))
      // No other walnut: the script would run only the daemon's own, so the install takes its place.
      fs.rmSync(path.join(home, '.local/share/open-walnut'), { recursive: true })
      const taken = run(script(), [...args])
      expect(taken.status, taken.stderr).toBe(0)
      expect(fs.readlinkSync(path.join(bin, 'walnut'))).toBe(path.join(home, INSTALLED))
    })

    it(`${name}: with nothing else there, walnut is linked into ~/.local/bin as usual`, () => {
      setup('none')
      const r = run(script(), [...args])
      expect(r.status, r.stderr).toBe(0)
      expect(fs.readlinkSync(path.join(home, '.local/bin/walnut'))).toBe(path.join(home, INSTALLED))
      expect(fs.existsSync(path.join(home, '.local/share/open-walnut/links'))).toBe(false)
    })

    it(`${name}: an installer that does not download says so, and is never run empty`, () => {
      setup('none')
      const r = run(script(), [...args], { WALNUT_JOIN_INSTALL_URL: `file://${path.join(dir, 'no-such-install.sh')}` })
      expect(r.status).toBe(1)
      expect(r.stdout).not.toContain('JOINED')
      expect(r.stderr).toContain("Could not download Walnut's installer (above). Check this machine is online, then run this again.")
      expect(r.stderr).not.toContain('Walnut installed, but not in')
    })

    it(`${name}: an installer that fails shows why`, () => {
      setup('none')
      fs.writeFileSync(path.join(dir, 'install.sh'), 'echo "error: this machine is not supported" >&2; exit 1\n')
      const r = run(script(), [...args])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('error: this machine is not supported')
      expect(r.stderr).toContain('Walnut did not install (above). Run this again, or install it by hand: curl -fsSL ')
    })

    it(`${name}: a Walnut that joins is used as it is`, () => {
      setup('new')
      const r = run(script(), [...args])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('1/3  Walnut ............ installed (0.6.24-nightly.1)')
      expect(r.stdout).not.toContain('installing')
      expect(r.calls).not.toContain('update')
      expect(r.stdout).toContain(joined)
    })
  }
})
