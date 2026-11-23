/**
 * The fixture server's Antigravity CLI (test-server.ts): the stand-in tests/fixtures/antigravity/
 * fake-agy.mjs behind a wrapper at a path both the server and a spec know (by the fixture's port),
 * named by WALNUT_ANTIGRAVITY_PATH, so Settings' sign-in never meets a real account. The code
 * "good" signs it in. A spec "uninstalls" it by removing the wrapper (`uninstallFakeAgy`); the
 * host's Install then runs the official installer line, `curl -fsSL <url> | bash`, where a fake
 * `curl` first on PATH answers only the Antigravity installer URL, with a script that waits a
 * moment (so its progress shows) and writes the wrapper back. Every other curl is the real one.
 * That curl comes first on the daemon's PATH through the fixture HOME's rc files, which the
 * daemon reads its PATH from.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const FAKE_AGY_INSTALLER_URL = 'https://antigravity.google/cli/install.sh'
/** How long the fake installer runs before it writes the wrapper (the spec sees "Installing"). */
export const FAKE_AGY_INSTALL_SECONDS = 3

export function fakeAgyDir(port = Number(process.env.PW_TEST_PORT ?? 3457)): string {
  return path.join(os.tmpdir(), `walnut-pw-fake-agy-${port}`)
}

export const fakeAgyPath = (port?: number) => path.join(fakeAgyDir(port), 'agy')
const templatePath = (port?: number) => path.join(fakeAgyDir(port), 'agy.template')

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function realCurl(pathVar: string): string | null {
  for (const dir of pathVar.split(path.delimiter)) {
    const p = path.join(dir, 'curl')
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ }
  }
  return null
}

/** Server side: write the wrapper, its template and the fake curl; returns the env the server takes. */
export function setUpFakeAgy(opts: { runtime: string; port?: number; pathVar: string; home: string }): { WALNUT_ANTIGRAVITY_PATH: string; toolsDir: string } {
  const dir = fakeAgyDir(opts.port)
  const tools = path.join(dir, 'tools')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(tools, { recursive: true })
  const fake = path.resolve(import.meta.dirname, '../../fixtures/antigravity/fake-agy.mjs')
  const wrapper = `#!/bin/sh\nexec ${quote(opts.runtime)} ${quote(fake)} "$@"\n`
  fs.writeFileSync(templatePath(opts.port), wrapper, { mode: 0o644 })
  fs.writeFileSync(fakeAgyPath(opts.port), wrapper, { mode: 0o755 })
  // The install's environment is the daemon's engine env, which need not carry WALNUT_ANTIGRAVITY_PATH:
  // the target is written in, and a failed copy fails the installer (a last echo would hide it).
  const target = quote(fakeAgyPath(opts.port))
  const installer = `set -e\nsleep ${FAKE_AGY_INSTALL_SECONDS}\ncp ${quote(templatePath(opts.port))} ${target}\nchmod 755 ${target}\necho "Antigravity CLI installed"\n`
  fs.writeFileSync(path.join(dir, 'installer.sh'), installer)
  const real = realCurl(opts.pathVar)
  fs.writeFileSync(path.join(tools, 'curl'), [
    '#!/bin/sh',
    'for a in "$@"; do last="$a"; done',
    `if [ "$last" = ${quote(FAKE_AGY_INSTALLER_URL)} ]; then cat ${quote(path.join(dir, 'installer.sh'))}; exit 0; fi`,
    real ? `exec ${quote(real)} "$@"` : 'echo "curl: not found" >&2; exit 127',
    '',
  ].join('\n'), { mode: 0o755 })
  // The daemon builds its PATH from the login shell's rc first (host-runtime-core.ts computeDaemonPath),
  // where /usr/bin comes before anything the server inherited: the fixture HOME's rc files put the
  // fake curl first there too, or the installer line would fetch the real installer.
  for (const rc of ['.zshrc', '.bashrc']) fs.appendFileSync(path.join(opts.home, rc), `export PATH=${quote(tools)}:"$PATH"\n`)
  return { WALNUT_ANTIGRAVITY_PATH: fakeAgyPath(opts.port), toolsDir: tools }
}

/** Spec side: the host reads "Not installed" until its Install puts the CLI back. */
export function uninstallFakeAgy(port?: number): void {
  fs.rmSync(fakeAgyPath(port), { force: true })
}

/** Spec side: the CLI is there again (after a test that removed it, whatever happened). */
export function reinstallFakeAgy(port?: number): void {
  if (fs.existsSync(fakeAgyPath(port))) return
  fs.copyFileSync(templatePath(port), fakeAgyPath(port))
  fs.chmodSync(fakeAgyPath(port), 0o755)
}
