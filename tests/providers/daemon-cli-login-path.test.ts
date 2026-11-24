/**
 * `<daemon> walnut daemon ...` runs with the account's login-shell PATH, as it did before the CLI
 * was dispatched ahead of the daemon runtime.
 *
 * The service config the install writes takes its PATH from the CLI's own
 * (daemon-service-cli.ts servicePath(process.env.PATH, home)), and the commands it runs
 * (systemctl, launchctl, crontab) are looked up on it. The daemon runtime used to set that PATH
 * (computeDaemonPath: the login shell's PATH first) before the CLI ran; with the CLI dispatched
 * first (it sets no daemon up), a host whose tools live in a login-shell dir (nvm, a toolbox bin)
 * lost them from the unit's PATH (review of the 2026-11-24 drill fixes, S1). Here a dir only the
 * login shell adds holds the service tools; `walnut daemon status` must run them from there.
 *
 * WALNUT_INSTALL_HOME's bin dir ends that PATH, as it ends the daemon's own. The compiled walnut
 * file's `walnut daemon ...` never computed a login PATH (trunk) and still does not: its unit's
 * PATH is the CLI's own (review round 2, S-b).
 *
 * MACHINE SAFETY: HOME and every dir are temp paths; the inherited PATH is an empty dir, so no real
 * service tool can run; the only processes are the CLI this file starts and the fakes it runs.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testBun } from '../helpers/bun-runtime.js'
import { applyCliLoginPath } from '../../src/providers/daemon-cli-path.js'

const BUN = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')

describe.skipIf(!BUN || process.platform !== 'linux' || !fs.existsSync('/bin/sh'))('the walnut CLI\'s daemon commands see the login-shell PATH', () => {
  it('`walnut daemon status` runs the service tools a login-shell dir holds', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cli-login-path-')))
    try {
      const home = path.join(root, 'home')
      const loginBin = path.join(home, 'login-bin')
      const nobin = path.join(root, 'nobin')
      const marks = path.join(root, 'ran.txt')
      for (const d of [loginBin, nobin, path.join(root, 'tmp'), path.join(root, 'rt')]) fs.mkdirSync(d, { recursive: true })
      // Only a login shell puts this dir on PATH (dash and bash read ~/.profile as a login shell).
      fs.writeFileSync(path.join(home, '.profile'), `PATH="${loginBin}:$PATH"; export PATH\n`)
      for (const tool of ['systemctl', 'loginctl', 'crontab']) {
        fs.writeFileSync(path.join(loginBin, tool), `#!/bin/sh\necho "${tool} $*" >> "${marks}"\nexit 1\n`, { mode: 0o755 })
      }
      const r = status(root, home, nobin)
      const ran = fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8') : ''
      expect(ran, `${r.stdout}\n${r.stderr}`).toMatch(/^systemctl --user/m)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  it('WALNUT_INSTALL_HOME\'s bin ends the CLI\'s PATH, as it ends the daemon\'s own', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cli-install-home-')))
    try {
      const env: NodeJS.ProcessEnv = { HOME: root, SHELL: '/bin/sh', PATH: '/usr/bin:/bin', WALNUT_INSTALL_HOME: path.join(root, 'install') }
      applyCliLoginPath(['daemon', 'status'], env)
      expect(env.PATH!.split(':').at(-1)).toBe(path.join(root, 'install', '.local', 'bin'))
      // A command that needs no login PATH keeps the one it was given.
      const tools: NodeJS.ProcessEnv = { ...env, PATH: '/usr/bin:/bin' }
      applyCliLoginPath(['tools', 'list'], tools)
      expect(tools.PATH).toBe('/usr/bin:/bin')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

function status(root: string, home: string, pathDir: string) {
  return spawnSync(BUN!, [STANDALONE, 'walnut', 'daemon', 'status'], {
    cwd: home, encoding: 'utf8', timeout: 60_000,
    env: {
      HOME: home, SHELL: '/bin/sh', PATH: pathDir, TMPDIR: path.join(root, 'tmp'), LANG: 'C',
      WALNUT_DAEMON_DIR: path.join(root, 'rt'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CONFIG_HOME: path.join(home, '.config'),
    },
  })
}

describe('the compiled walnut file\'s `walnut daemon ...` keeps the PATH it was given, as on trunk', () => {
  it('its walnut branch dispatches the CLI and nothing else (no login-shell PATH)', () => {
    const main = fs.readFileSync(path.resolve(__dirname, '../../src/binary/main.ts'), 'utf8')
    const at = main.indexOf("} else if (first === 'walnut' || first === 'wn') {")
    expect(at).toBeGreaterThan(-1)
    const branch = main.slice(at, main.indexOf('} else if', at + 10)).split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))
    expect(branch).toEqual([
      "const { runWalnutCli } = await import('../providers/wn-cli.js')",
      'process.exit(await runWalnutCli(userArgs.slice(1)))',
    ])
  })
})
