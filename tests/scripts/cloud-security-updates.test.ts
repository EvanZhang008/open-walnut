/**
 * The companion's daily security updates (scripts/cloud/security-updates.sh) apply updates
 * from the latest release and reboot only when one needs it.
 *
 * 2026-11-02: a companion with dnf-automatic on for months still had every advisory open.
 * Amazon Linux 2023 pins its repositories to the AMI's release, so a plain `dnf upgrade`
 * finds nothing, and nothing ever rebooted the box into a new kernel. Run here with ROOT
 * set (files under a temp dir, nothing enabled) and the installed runner with stub tools.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(__dirname, '../..')
const SCRIPT = path.join(REPO, 'scripts/cloud/security-updates.sh')
const dirs: string[] = []
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-updates-'))
  dirs.push(d)
  return d
}

function install(pkg: 'dnf' | 'apt', env: Record<string, string> = {}): string {
  const root = tmp()
  execFileSync('bash', [SCRIPT, pkg], { env: { ...process.env, ROOT: root, ...env }, encoding: 'utf8' })
  return root
}

/** A stub tool that logs its argv and exits with `code`. */
function stub(dir: string, name: string, code: number): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${dir}/calls"\nexit ${code}\n`, { mode: 0o755 })
  return p
}

function runUpdate(root: string, dnfCode: number, needsRestartingCode: number): { status: number | null; calls: string[] } {
  const bin = tmp()
  const r = spawnSync('bash', [path.join(root, 'usr/local/sbin/walnut-security-update')], {
    env: {
      ...process.env,
      DNF: stub(bin, 'dnf', dnfCode),
      NEEDS_RESTARTING: stub(bin, 'needs-restarting', needsRestartingCode),
      SYSTEMCTL: stub(bin, 'systemctl', 0),
    },
    encoding: 'utf8',
  })
  const calls = fs.existsSync(path.join(bin, 'calls')) ? fs.readFileSync(path.join(bin, 'calls'), 'utf8').trim().split('\n') : []
  return { status: r.status, calls }
}

describe('on dnf (Amazon Linux 2023)', () => {
  it('installs a daily timer at the quiet hour and a runner that upgrades from the latest release', () => {
    const root = install('dnf', { UPDATE_AT: '09:45' })
    const timer = fs.readFileSync(path.join(root, 'etc/systemd/system/walnut-security-update.timer'), 'utf8')
    expect(timer).toContain('OnCalendar=*-*-* 09:45:00 UTC')
    expect(timer).toContain('Persistent=true')
    const service = fs.readFileSync(path.join(root, 'etc/systemd/system/walnut-security-update.service'), 'utf8')
    expect(service).toContain('ExecStart=/usr/local/sbin/walnut-security-update')
  })

  it('reboots only when an update needs it', () => {
    const root = install('dnf')
    const none = runUpdate(root, 0, 0)
    expect(none.status).toBe(0)
    expect(none.calls).toEqual(['dnf -y upgrade --security --releasever=latest', 'needs-restarting -r'])
    const due = runUpdate(root, 0, 1)
    expect(due.calls).toEqual(['dnf -y upgrade --security --releasever=latest', 'needs-restarting -r', 'systemctl reboot'])
  })

  it('a failed upgrade fails the unit and never reboots', () => {
    const failed = runUpdate(install('dnf'), 1, 1)
    expect(failed.status).toBe(1)
    expect(failed.calls).toEqual(['dnf -y upgrade --security --releasever=latest'])
  })

  it('refuses a malformed time', () => {
    const r = spawnSync('bash', [SCRIPT, 'dnf'], { env: { ...process.env, ROOT: tmp(), UPDATE_AT: '3am' }, encoding: 'utf8' })
    expect(r.status).toBe(2)
  })
})

describe('on apt (Ubuntu)', () => {
  it('keeps unattended-upgrades and gives it the reboot it lacks, at the quiet hour', () => {
    const root = install('apt', { UPDATE_AT: '11:00' })
    const reboot = fs.readFileSync(path.join(root, 'etc/apt/apt.conf.d/52walnut-reboot'), 'utf8')
    expect(reboot).toContain('Unattended-Upgrade::Automatic-Reboot "true";')
    expect(reboot).toContain('Unattended-Upgrade::Automatic-Reboot-Time "11:00";')
    expect(fs.readFileSync(path.join(root, 'etc/apt/apt.conf.d/20auto-upgrades'), 'utf8')).toContain('Unattended-Upgrade "1"')
  })
})

describe('setup.sh', () => {
  it('sets updates up through security-updates.sh, never dnf-automatic alone', () => {
    const setup = fs.readFileSync(path.join(REPO, 'scripts/cloud/setup.sh'), 'utf8')
    expect(setup).toContain('scripts/cloud/security-updates.sh" "$PKG"')
    expect(setup).not.toMatch(/enable --now "?\$AUTO_UPDATE_TIMER|dnf-automatic\.timer/)
  })
})
