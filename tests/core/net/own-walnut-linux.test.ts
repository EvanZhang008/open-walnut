/**
 * The Linux half of the Windows app's own Walnut (net-join-ps1.ts ownWalnutLinuxScript), run by
 * sh as the app runs it inside the OpenWalnut Linux, against stand-ins for curl, systemctl,
 * journalctl and sleep: it installs Walnut once, makes its console a systemd user service, and
 * returns only when the console answers. A real Windows PC runs it in windows-app.yml.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { APP_CONSOLE_PORT, ownWalnutLinuxScript } from '../../../src/core/net/net-join-ps1.js'
import { guardedPath } from '../../setup/exec-guard.js'

let dir = ''
const home = () => path.join(dir, 'home')
const unit = () => path.join(home(), '.config/systemd/user/open-walnut-web.service')
const walnut = () => path.join(home(), '.local/share/open-walnut/bin/walnut')

function standIns(opts: { download?: 'ok' | 'fail'; install?: 'ok' | 'fail'; upAfter?: number; listener?: 'ours' | 'another Linux' } = {}): void {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const up = opts.upAfter ?? 2
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
d="${dir}"
echo "$*" >> "$d/curl"
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*|file*) url="$1" ;; esac; shift; done
case "$url" in
  */api/config) n=$(grep -c api/config "$d/curl"); [ ${up} -ge 0 ] && [ "$n" -gt ${up} ] && exit 0; exit 7 ;;
esac
${opts.download === 'fail' ? 'echo "curl: (6) Could not resolve host" >&2; exit 6' : `cat > "$out" <<'SH'
${opts.install === 'fail' ? 'echo "install.sh: no space left" ; exit 2' : `mkdir -p "$HOME/.local/share/open-walnut/bin"
printf '#!/bin/sh\\necho "walnut 0.6.24"\\n' > "$HOME/.local/share/open-walnut/bin/walnut"
chmod +x "$HOME/.local/share/open-walnut/bin/walnut"
echo "MODIFY_PATH=$OPEN_WALNUT_MODIFY_PATH" >> "${dir}/installer"`}
SH
exit 0`}
`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> "${dir}/systemctl"\nexit 0\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'journalctl'), '#!/bin/sh\necho "walnut[42]: listen EADDRINUSE 127.0.0.1:3456"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  // Who holds the port: this unit's server (its pid, in the unit's cgroup), or a Walnut in
  // another WSL Linux, whose process this Linux cannot see (no pid on the line).
  const users = (opts.listener ?? 'ours') === 'ours' ? ' users:(("walnut",pid=4242,fd=20))' : ''
  fs.writeFileSync(path.join(bin, 'ss'), `#!/bin/sh\necho "$*" >> "${dir}/ss"\necho 'LISTEN 0 511 127.0.0.1:3456 0.0.0.0:*${users}'\n`, { mode: 0o755 })
  fs.mkdirSync(path.join(dir, 'proc/4242'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'proc/4242/cgroup'), '0::/user.slice/user-1500.slice/user@1500.service/app.slice/open-walnut-web.service\n')
}

function run() {
  const r = spawnSync('sh', ['-c', ownWalnutLinuxScript()], {
    encoding: 'utf8',
    env: { PATH: guardedPath([path.join(dir, 'bin')], '/usr/bin:/bin'), HOME: home(), XDG_RUNTIME_DIR: path.join(dir, 'run'), WALNUT_PROC_DIR: path.join(dir, 'proc') },
  })
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n') : [])
  return { ...r, out: `${r.stdout}${r.stderr}`, systemctl: read('systemctl'), curl: read('curl') }
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own-walnut-')))
  fs.mkdirSync(home())
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('the app\'s own Walnut, in the Linux', () => {
  it('installs Walnut, makes its console a service, and returns once the console answers', () => {
    standIns()
    const r = run()
    expect(r.status, r.out).toBe(0)
    expect(r.out).toBe('  Walnut ............ installing\n  Walnut ............ installed (walnut 0.6.24)\n  Walnut ............ running\n')
    // No rc file is told to change PATH: the service names the file itself.
    expect(fs.readFileSync(path.join(dir, 'installer'), 'utf8').trim()).toBe('MODIFY_PATH=0')
    expect(fs.readFileSync(unit(), 'utf8')).toBe(`[Unit]
Description=Walnut (its console shows in the Walnut app on Windows)

[Service]
ExecStart=${walnut()} web --port ${APP_CONSOLE_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`)
    expect(r.systemctl).toEqual(['--user daemon-reload', '--user enable open-walnut-web.service', '--user restart open-walnut-web.service'])
    expect(fs.readFileSync(path.join(dir, 'ss'), 'utf8').trim()).toBe('-ltnpH sport = :3456')
    expect(r.curl.filter((c) => c.includes('/api/config'))).toHaveLength(3)
    expect(r.curl[0]).toContain('https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh')
  })

  it('a second run keeps the Walnut and the service it has', () => {
    standIns()
    expect(run().status).toBe(0)
    fs.rmSync(path.join(dir, 'systemctl'))
    fs.rmSync(path.join(dir, 'curl'))
    const r = run()
    expect(r.status, r.out).toBe(0)
    expect(r.out).toBe('  Walnut ............ installed (walnut 0.6.24)\n  Walnut ............ running\n')
    expect(r.curl.every((c) => c.includes('/api/config'))).toBe(true)
    // An unchanged unit is not reloaded or restarted; start brings back one that stopped.
    expect(r.systemctl).toEqual(['--user enable open-walnut-web.service', '--user start open-walnut-web.service'])
    expect(fs.existsSync(unit() + '.new')).toBe(false)
  })

  it('a download that fails stops before anything is made', () => {
    standIns({ download: 'fail' })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.out).toContain("Could not download Walnut's installer (above). Check this PC is online, then try again.")
    expect(fs.existsSync(unit())).toBe(false)
    expect(r.systemctl).toEqual([])
  })

  it('an installer that fails shows what it said', () => {
    standIns({ install: 'fail' })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.out).toContain('install.sh: no space left')
    expect(r.out).toContain('Walnut did not install (above).')
    expect(fs.existsSync(unit())).toBe(false)
  })

  it('a console that never answers: the service\'s own log, then a stop', () => {
    standIns({ upAfter: -1 })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.out).toContain('walnut[42]: listen EADDRINUSE 127.0.0.1:3456')
    expect(r.out).toContain('Walnut did not start (above).')
    expect(r.curl.filter((c) => c.includes('/api/config'))).toHaveLength(300)
  })

  it('another Walnut on the port (one in the PC\'s own Linux): stops this one and says so', () => {
    standIns({ listener: 'another Linux' })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.out).toContain('Port 3456 is taken by another program on this PC (another Walnut, in a WSL Linux or on Windows). Stop it, then try again.')
    expect(r.out).not.toContain('running')
    // Not left to restart every 5 seconds against a port it can never have.
    expect(r.systemctl.at(-1)).toBe('--user disable --now open-walnut-web.service')
  })
})
