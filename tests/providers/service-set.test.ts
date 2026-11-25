/**
 * A host's service sets (src/providers/service-set.ts): the default set is exactly today's names and
 * dirs, a Walnut's own set has its own of each, and every consumer (the config table, the renderers,
 * the cron lines, the handover check, the server's production-dir check, the update shell) follows the
 * set it is given and never reads another's.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  DAEMON_CRON_TAG, DAEMON_SERVICE_LABEL, DAEMON_SERVICE_PLIST_NAME, DAEMON_SERVICE_UNIT_NAME, SET_SOCKET_MAX_BYTES,
  isServiceInstallRoot, isServiceSetRuntimeDir, parseServiceSetLine, serviceSet, serviceSetIdOf, serviceSetLine,
  withServiceSetExport,
} from '../../src/providers/service-set.js'
import {
  daemonInstallRoot, daemonServiceConfigFiles, renderDaemonLaunchAgent, renderDaemonSystemdUnit, type DaemonServiceConfig,
} from '../../src/providers/daemon-service-config.js'
import { daemonServiceConfigPath } from '../../src/providers/daemon-service-manager.js'
import {
  cronLineState, crontabWithDaemonLine, crontabWithoutDaemonLine, daemonCronLine, renderDaemonBootScript,
} from '../../src/providers/daemon-service-boot-script.js'
import { createLauncherControl } from '../../src/providers/service-launcher-control.js'
import { renderLauncherScript } from '../../src/providers/service-launcher-script.js'
import { SHARED_DAEMON_DIR, isProductionDaemonDir } from '../../src/lib/daemon-dir.js'
import { walnutDirKey } from '../../src/core/host-server/install.js'
import { prepareDaemonServiceHandover } from '../../src/providers/daemon-service-handover.js'
import { installRootLine, loadedLines, servicePreamble } from '../../src/providers/daemon-update-shell.js'
import { installedDaemonServiceScope } from '../../src/providers/daemon-service-scope.js'

const HOME = '/home/walnut'
const WALNUT = '0123456789abcdef0123456789abcdef'
const ID = '0123456789abcdef'
const R = `${HOME}/.open-walnut-host/walnuts/${ID}`

describe('serviceSet: the default set is today', () => {
  it('id "" gives the default install root, the given runtime dir and the constant names, on both platforms', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const set = serviceSet(platform, HOME, '', { runtimeDir: '/home/walnut/.cache/open-walnut' })
      expect(set).toEqual({
        id: '', installRoot: daemonInstallRoot(platform, HOME), runtimeDir: '/home/walnut/.cache/open-walnut',
        unit: 'open-walnut-daemon.service', label: 'dev.openwalnut.session-daemon', plist: 'dev.openwalnut.session-daemon.plist',
        cronTag: '# open-walnut-daemon',
      })
      expect([set.unit, set.label, set.plist, set.cronTag]).toEqual([DAEMON_SERVICE_UNIT_NAME, DAEMON_SERVICE_LABEL, DAEMON_SERVICE_PLIST_NAME, DAEMON_CRON_TAG])
    }
    expect(daemonInstallRoot('linux', HOME)).toBe('/home/walnut/.local/share/open-walnut/daemon')
    expect(daemonInstallRoot('darwin', HOME)).toBe('/home/walnut/Library/Application Support/Open Walnut/Daemon')
    // With no runtime dir named: the shared one, lib/daemon-dir.ts's.
    expect(serviceSet('linux', HOME).runtimeDir).toBe(SHARED_DAEMON_DIR)
  })

  it('the default config table and config paths are the ones before sets', () => {
    expect(daemonServiceConfigFiles('linux', HOME)).toEqual([
      '/home/walnut/.config/systemd/user/open-walnut-daemon.service',
      '/etc/systemd/system/open-walnut-daemon.service',
      '/home/walnut/.local/share/open-walnut/daemon/daemon-boot.sh',
    ])
    expect(daemonServiceConfigFiles('darwin', HOME)).toEqual(['/home/walnut/Library/LaunchAgents/dev.openwalnut.session-daemon.plist'])
    // The remote probe's literal $HOME still works.
    expect(daemonServiceConfigFiles('linux', '$HOME')[2]).toBe('$HOME/.local/share/open-walnut/daemon/daemon-boot.sh')
    expect(daemonServiceConfigPath('linux', HOME, 'cron')).toBe('/home/walnut/.local/share/open-walnut/daemon/daemon-boot.sh')
    expect(daemonServiceConfigPath('linux', HOME, 'system')).toBe('/etc/systemd/system/open-walnut-daemon.service')
  })
})

describe('serviceSet: a Walnut\'s own set', () => {
  it('lives under ~/.open-walnut-host/walnuts/<id16>, with its own names', () => {
    const set = serviceSet('linux', HOME, ID, { uid: 1000 })
    expect(set).toEqual({
      id: ID, installRoot: `${R}/daemon`, runtimeDir: `${R}/rt`,
      unit: `open-walnut-daemon-${ID}.service`, label: `dev.openwalnut.session-daemon.${ID}`,
      plist: `dev.openwalnut.session-daemon.${ID}.plist`, cronTag: `# open-walnut-daemon ${ID}`,
    })
    expect(serviceSet('darwin', '/Users/w', ID, { uid: 501 }).installRoot).toBe(`/Users/w/.open-walnut-host/walnuts/${ID}/daemon`)
    // The follower's run dir R/run is a sibling of R/rt, never nested (replica/boot-guard.ts).
    expect(path.dirname(set.runtimeDir)).toBe(R)
  })

  it('its id is the head of the walnut id, as the host dir names it, and only 16 hex digits name a set', () => {
    expect(serviceSetIdOf(WALNUT)).toBe(ID)
    expect(serviceSetIdOf(WALNUT)).toBe(walnutDirKey(WALNUT))
    for (const bad of ['', 'short', 'ZZZZZZZZZZZZZZZZaaaa', '0123456789ABCDEF0000', '../../etc/passwd/xx']) {
      expect(() => serviceSetIdOf(bad), bad).toThrow(/16 hex/)
    }
    expect(() => serviceSet('linux', HOME, 'nothex')).toThrow()
    expect(() => serviceSet('linux', 'relative', ID)).toThrow(/absolute home/)
  })

  it('its runtime dir moves to /tmp when R/rt\'s longest socket would pass the sun_path room', () => {
    const fits = '/h'.padEnd(10, 'x')
    expect(serviceSet('linux', fits, ID, { uid: 1000 }).runtimeDir).toBe(`${fits}/.open-walnut-host/walnuts/${ID}/rt`)
    const long = `/home/${'a'.repeat(60)}`
    const far = serviceSet('darwin', long, ID, { uid: 501 })
    expect(far.runtimeDir).toBe(`/tmp/open-walnut-set-501-${ID}`)
    // The boundary: a home one byte shorter than the limit allows keeps R/rt.
    const rest = Buffer.byteLength(`/.open-walnut-host/walnuts/${ID}/rt/host-call/0123456789abcdef.sock`)
    const edge = `/${'b'.repeat(SET_SOCKET_MAX_BYTES - rest - 1)}`
    expect(serviceSet('linux', edge, ID, { uid: 1 }).runtimeDir).toBe(`${edge}/.open-walnut-host/walnuts/${ID}/rt`)
    expect(serviceSet('linux', `${edge}c`, ID, { uid: 1 }).runtimeDir).toBe(`/tmp/open-walnut-set-1-${ID}`)
  })

  it('its config table and config paths never name the default\'s files', () => {
    const set = serviceSet('linux', HOME, ID, { uid: 1000 })
    const mine = daemonServiceConfigFiles('linux', HOME, set)
    expect(mine).toEqual([
      `${HOME}/.config/systemd/user/open-walnut-daemon-${ID}.service`,
      `/etc/systemd/system/open-walnut-daemon-${ID}.service`,
      `${R}/daemon/daemon-boot.sh`,
    ])
    expect(mine.filter((f) => daemonServiceConfigFiles('linux', HOME).includes(f))).toEqual([])
    expect(daemonServiceConfigFiles('darwin', HOME, serviceSet('darwin', HOME, ID))).toEqual([`${HOME}/Library/LaunchAgents/dev.openwalnut.session-daemon.${ID}.plist`])
    expect(daemonServiceConfigPath('linux', HOME, 'user', set)).toBe(mine[0])
    expect(daemonServiceConfigPath('linux', HOME, 'cron', set)).toBe(mine[2])
  })

  it('the scope a set has installed is read from its own files only', async () => {
    const set = serviceSet('linux', HOME, ID, { uid: 1000 })
    const defaults = new Set(daemonServiceConfigFiles('linux', HOME))
    // Only the default set is installed (its user unit): the set has none, the default reads user.
    const present = async (file: string) => defaults.has(file) && file.endsWith('.service') && file.startsWith(HOME)
    expect(await installedDaemonServiceScope({ platform: 'linux', home: HOME, present })).toBe('user')
    expect(await installedDaemonServiceScope({ platform: 'linux', home: HOME, present, set })).toBe(null)
    const mineOnly = async (file: string) => file === daemonServiceConfigFiles('linux', HOME, set)[2]
    expect(await installedDaemonServiceScope({ platform: 'linux', home: HOME, present: mineOnly, set })).toBe('cron')
    expect(await installedDaemonServiceScope({ platform: 'linux', home: HOME, present: mineOnly })).toBe(null)
  })
})

describe('what the server and the handover accept as a service\'s dirs', () => {
  it('isServiceInstallRoot: the default root or a set\'s R/daemon, nothing else', () => {
    expect(isServiceInstallRoot('linux', HOME, daemonInstallRoot('linux', HOME))).toBe(true)
    expect(isServiceInstallRoot('darwin', HOME, daemonInstallRoot('darwin', HOME))).toBe(true)
    expect(isServiceInstallRoot('linux', HOME, `${R}/daemon`)).toBe(true)
    expect(isServiceInstallRoot('linux', HOME, `${R}/daemon/`)).toBe(true)
    for (const bad of [`${R}`, `${R}/rt`, `${R}/daemon/x`, `${HOME}/.open-walnut-host/walnuts/nothex/daemon`, '/tmp/x/daemon', `/other${R}/daemon`]) {
      expect(isServiceInstallRoot('linux', HOME, bad), bad).toBe(false)
    }
  })

  it('isServiceSetRuntimeDir: R/rt under this home, or the /tmp fallback of this account only', () => {
    expect(isServiceSetRuntimeDir(`${R}/rt`, HOME, 1000)).toBe(true)
    expect(isServiceSetRuntimeDir(`/tmp/open-walnut-set-1000-${ID}`, HOME, 1000)).toBe(true)
    expect(isServiceSetRuntimeDir(`/tmp/open-walnut-set-1001-${ID}`, HOME, 1000)).toBe(false)
    expect(isServiceSetRuntimeDir(`/tmp/open-walnut-set-1000-${ID}`, HOME, null)).toBe(false)
    for (const bad of ['/tmp/open-walnut', `${R}/run`, `${R}/daemon`, `/elsewhere${R}/rt`, `${HOME}/.open-walnut-host/walnuts/xyz/rt`]) {
      expect(isServiceSetRuntimeDir(bad, HOME, 1000), bad).toBe(false)
    }
  })

  it('isServiceSetRuntimeDir on macOS: the /tmp fallback read through its realpath (/private/tmp) is the same dir; elsewhere it is not', () => {
    expect(isServiceSetRuntimeDir(`/private/tmp/open-walnut-set-501-${ID}`, HOME, 501, 'darwin')).toBe(true)
    expect(isServiceSetRuntimeDir(`/tmp/open-walnut-set-501-${ID}`, HOME, 501, 'darwin')).toBe(true)
    expect(isServiceSetRuntimeDir(`/private/tmp/open-walnut-set-502-${ID}`, HOME, 501, 'darwin')).toBe(false)
    expect(isServiceSetRuntimeDir(`/x/private/tmp/open-walnut-set-501-${ID}`, HOME, 501, 'darwin')).toBe(false)
    expect(isServiceSetRuntimeDir(`/private/tmp/open-walnut-set-501-${ID}`, HOME, 501, 'linux')).toBe(false)
  })

  it('isProductionDaemonDir counts a set\'s runtime dir as production (its sessions outlive it), and only that', () => {
    const env = { HOME }
    expect(isProductionDaemonDir(`${R}/rt`, env)).toBe(true)
    expect(isProductionDaemonDir(`${R}/run`, env)).toBe(false)
    expect(isProductionDaemonDir(`/tmp/open-walnut-test-${ID}`, env)).toBe(false)
    const uid = process.getuid!()
    expect(isProductionDaemonDir(`/tmp/open-walnut-set-${uid}-${ID}`, env)).toBe(true)
    expect(isProductionDaemonDir(`/tmp/open-walnut-set-${uid + 1}-${ID}`, env)).toBe(false)
  })

  it('the service handover takes a set\'s root, and still refuses any other dir', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-set-handover-'))
    try {
      const base = { home: tmp, platform: 'linux' as const, uid: process.getuid!(), instanceId: 'i', pid: 1, startTime: 's', entries: {}, registryFile: '/x/sessions.json', hooks: null }
      await expect(prepareDaemonServiceHandover({ ...base, stateDir: path.join(tmp, 'elsewhere') })).rejects.toThrow(/requires a host service directory/)
      const setRoot = serviceSet('linux', tmp, ID).installRoot
      fs.mkdirSync(setRoot, { recursive: true, mode: 0o700 })
      // Past the dir check: the next refusal is the registry's, not the dir's.
      await expect(prepareDaemonServiceHandover({ ...base, stateDir: setRoot })).rejects.toThrow(/current private registry/)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  })
})

describe('the files a set renders name its set', () => {
  const config = (set: ReturnType<typeof serviceSet>, platform: 'linux' | 'darwin' = 'linux'): DaemonServiceConfig => ({
    platform, home: HOME, executable: `${set.installRoot}/versions/abc/daemon`, args: ['--service'],
    runtimeDir: set.runtimeDir, stateDir: set.installRoot, path: '/usr/bin:/bin', ...(set.id ? { serviceSet: set.id } : {}),
  })
  const set = serviceSet('linux', HOME, ID, { uid: 1000 })

  it('the unit and the LaunchAgent carry WALNUT_SERVICE_SET and the set\'s label and description', () => {
    const unit = renderDaemonSystemdUnit(config(set), 'user', { launcher: `${set.installRoot}/walnut-launcher.sh` })
    expect(unit).toContain(`Description=Open Walnut session daemon ${ID} (its launcher)`)
    expect(unit).toContain(`Environment="WALNUT_SERVICE_SET=${ID}"`)
    expect(unit).toContain(`Environment="WALNUT_DAEMON_DIR=${R}/rt"`)
    expect(unit).toContain(`Environment="WALNUT_DAEMON_STATE_DIR=${R}/daemon"`)
    expect(unit).toContain(`Environment="WALNUT_RUNTIME_DIR=${R}/daemon/runtime"`)
    const mac = serviceSet('darwin', HOME, ID, { uid: 501 })
    const plist = renderDaemonLaunchAgent(config(mac, 'darwin'))
    expect(plist).toContain(`<string>dev.openwalnut.session-daemon.${ID}</string>`)
    expect(plist).toMatch(new RegExp(`<key>WALNUT_SERVICE_SET</key>\\s*<string>${ID}</string>`))
    expect(() => renderDaemonSystemdUnit({ ...config(set), serviceSet: 'NOPE' }, 'user')).toThrow(/serviceSet must be 16 hex/)
  })

  it('the boot script and the launcher (every backend) export the set themselves: cron gives them no unit environment', () => {
    const boot = renderDaemonBootScript(config(set))
    expect(boot.split('\n')).toContain(`export WALNUT_SERVICE_SET='${ID}'`)
    for (const backend of ['systemd', 'launchd', 'cron'] as const) {
      const L = createLauncherControl({ stateDir: set.installRoot, backend })
      const lines = L.render(config(set), `${set.installRoot}/versions/abc/daemon`).split('\n')
      const at = lines.findIndex((l) => l.startsWith('export WALNUT_DAEMON_STATE_DIR='))
      expect(lines[at + 1], backend).toBe(`export WALNUT_SERVICE_SET='${ID}'`)
      // The walnut file's runtime trees in the set's own root, never the default Walnut's data home (R1).
      expect(lines[at + 2], backend).toBe(`export WALNUT_RUNTIME_DIR='${R}/daemon/runtime'`)
    }
    expect(boot.split('\n')).toContain(`export WALNUT_RUNTIME_DIR='${R}/daemon/runtime'`)
    expect(() => withServiceSetExport('#!/bin/sh\n', ID, set.installRoot)).toThrow(/WALNUT_DAEMON_STATE_DIR/)
    expect(withServiceSetExport('anything', '', set.installRoot)).toBe('anything')
  })

  it('the cron lines carry the set\'s tag: neither set reads the other\'s line as its own or as foreign', () => {
    const def = serviceSet('linux', HOME)
    const defScript = `${def.installRoot}/daemon-boot.sh`
    const setScript = `${set.installRoot}/daemon-boot.sh`
    expect(daemonCronLine(setScript, set.cronTag)).toBe(`@reboot /bin/sh '${setScript}' >/dev/null 2>&1 # open-walnut-daemon ${ID}`)
    const both = crontabWithDaemonLine(crontabWithDaemonLine('MAILTO=""\n', defScript), setScript, { tag: set.cronTag, everyMinute: true })
    expect(cronLineState(both, defScript)).toBe('ours')
    expect(cronLineState(both, setScript, { tag: set.cronTag, everyMinute: true })).toBe('ours')
    // Taking one set's lines out leaves the other's.
    const noSet = crontabWithoutDaemonLine(both, setScript, set.cronTag)
    expect(noSet).toBe(crontabWithDaemonLine('MAILTO=""\n', defScript))
    expect(cronLineState(noSet, setScript, { tag: set.cronTag })).toBe('none')
    const noDefault = crontabWithoutDaemonLine(both, defScript)
    expect(cronLineState(noDefault, defScript)).toBe('none')
    expect(cronLineState(noDefault, setScript, { tag: set.cronTag, everyMinute: true })).toBe('ours')
  })

  it('the update shell names the set\'s root, unit and label when given one, and the default\'s otherwise', () => {
    expect(installRootLine()).toBe('case "$(uname -s)" in Darwin) tb="$HOME/Library/Application Support/Open Walnut/Daemon";; *) tb="$HOME/.local/share/open-walnut/daemon";; esac')
    expect(installRootLine(ID)).toBe(`case "$(uname -s)" in Darwin) tb="$HOME/.open-walnut-host/walnuts/${ID}/daemon";; *) tb="$HOME/.open-walnut-host/walnuts/${ID}/daemon";; esac`)
    expect(servicePreamble('user')).toContain('  Darwin) tk=launchd; tb="$HOME/Library/Application Support/Open Walnut/Daemon"; tc="$HOME/Library/LaunchAgents/dev.openwalnut.session-daemon.plist";;')
    expect(servicePreamble('user', ID).join('\n')).toContain(`tc="$HOME/.config/systemd/user/open-walnut-daemon-${ID}.service"`)
    expect(loadedLines(ID).join('\n')).toContain(`"gui/$tu/dev.openwalnut.session-daemon.${ID}"`)
    expect(loadedLines().join('\n')).not.toContain(ID)
  })

  it('the `service set:` line reads back, and an older host\'s output names none', () => {
    expect(serviceSetLine('')).toBe('service set: default')
    expect(serviceSetLine(ID)).toBe(`service set: ${ID}`)
    expect(parseServiceSetLine(`${serviceSetLine(ID)}\n{"ok":true}`)).toBe(ID)
    expect(parseServiceSetLine('service set: default\n{}')).toBe('')
    expect(parseServiceSetLine('{"ok":true}')).toBe(null)
  })
})

describe('flag off: the default set\'s files are byte for byte what they were', () => {
  // sha256 of each file as the renderers before service sets wrote it, for one fixed config: HEAD 12758251e7, and
  // the same again from the branch's merge-base with trunk, 2e0ddc8935 (review round 2, H-L5: `git archive`, rendered
  // by the task's notes/ab-leader/render-files-mb.ts). The three launcher hashes were recorded again on 2026-11-25,
  // when the launcher itself changed (its clock is read again before each verdict on elapsed time): the set's
  // render is still checked to be exactly renderLauncherScript's below.
  const GOLDEN = {
    unit: 'b8ff0f68dca72e2a7566f2b35cb1d85a92a7ea994248c54b28744f9082c19838',
    unitLauncher: 'fcc4edd6641c2dac43bfad5c60f6a67e06d852d90e48afcbd0e61b3a16d01fbc',
    unitSystem: 'da9b1b84f71eaef04d17ffb6a95d730711b1392975d1d7df57634553d6a9fc2f',
    plist: '7c0be1ddb5772095ba63ee533601e196e272248875b91518ef2f801b4c97a8d0',
    plistLauncher: 'b758bb2e54d3b2e0774077686487b93c474debfc06011635b1954d5358e89c1d',
    bootScript: 'dfbcb9e426b60b1bf9124ddd487e618081610d286af2ac06f53c62293206b195',
    // The launcher script (createLauncherControl().render): systemd and launchd write the same text.
    launcherSystemd: '670f2baf4fdfe795efd509c2b8bcadacfd3fc5289d2f28578bee794cec4c1598',
    launcherLaunchd: '670f2baf4fdfe795efd509c2b8bcadacfd3fc5289d2f28578bee794cec4c1598',
    launcherCron: '7468cbddf1b37d029e5fa08eb2cee1a1264177e54d889bcb9292af4fa5b5b93b',
  }
  const linux: DaemonServiceConfig = { platform: 'linux', home: '/home/walnut', executable: '/home/walnut/.local/share/open-walnut/daemon/versions/abc/daemon', args: ['--service'], runtimeDir: '/tmp/open-walnut', stateDir: '/home/walnut/.local/share/open-walnut/daemon', path: '/usr/local/bin:/usr/bin:/bin' }
  const mac: DaemonServiceConfig = { ...linux, platform: 'darwin', home: '/Users/walnut', stateDir: '/Users/walnut/Library/Application Support/Open Walnut/Daemon', executable: '/Users/walnut/Library/Application Support/Open Walnut/Daemon/versions/abc/daemon' }
  const h = (t: string) => createHash('sha256').update(t).digest('hex')

  it('unit, LaunchAgent and boot script', () => {
    const L = '/home/walnut/.local/share/open-walnut/daemon/walnut-launcher.sh'
    // Also with serviceSet '' (a default set passed on): the same bytes.
    for (const c of [linux, { ...linux, serviceSet: '' }]) {
      expect(h(renderDaemonSystemdUnit(c, 'user'))).toBe(GOLDEN.unit)
      expect(h(renderDaemonSystemdUnit(c, 'user', { launcher: L }))).toBe(GOLDEN.unitLauncher)
      expect(h(renderDaemonSystemdUnit({ ...c, user: 'walnut' }, 'system'))).toBe(GOLDEN.unitSystem)
      expect(h(renderDaemonBootScript(c))).toBe(GOLDEN.bootScript)
    }
    expect(h(renderDaemonLaunchAgent(mac))).toBe(GOLDEN.plist)
    expect(h(renderDaemonLaunchAgent(mac, { launcher: '/Users/walnut/Library/Application Support/Open Walnut/Daemon/walnut-launcher.sh' }))).toBe(GOLDEN.plistLauncher)
  })

  it('the cron lines', () => {
    const C = '/home/walnut/.local/share/open-walnut/daemon/daemon-boot.sh'
    expect(daemonCronLine(C)).toBe("@reboot /bin/sh '/home/walnut/.local/share/open-walnut/daemon/daemon-boot.sh' >/dev/null 2>&1 # open-walnut-daemon")
    expect(crontabWithDaemonLine('', C, { everyMinute: true })).toBe([
      "@reboot /bin/sh '/home/walnut/.local/share/open-walnut/daemon/daemon-boot.sh' >/dev/null 2>&1 # open-walnut-daemon",
      "* * * * * /bin/sh '/home/walnut/.local/share/open-walnut/daemon/daemon-boot.sh' >/dev/null 2>&1 # open-walnut-daemon",
      '',
    ].join('\n'))
  })

  it('the launcher script, for every backend, is byte for byte the merge-base\'s', () => {
    const want = { systemd: GOLDEN.launcherSystemd, launchd: GOLDEN.launcherLaunchd, cron: GOLDEN.launcherCron }
    for (const backend of ['systemd', 'launchd', 'cron'] as const) {
      const L = createLauncherControl({ stateDir: linux.stateDir, backend })
      expect(h(L.render(linux, linux.executable)), backend).toBe(want[backend])
      expect(L.render(linux, linux.executable)).toBe(renderLauncherScript(linux, { backend, self: L.script }))
    }
  })
})

describe('walnut daemon … --walnut <id>', () => {
  it('names the Walnut a service is for; without it the options are as before', async () => {
    const { parseDaemonServiceArgs } = await import('../../src/providers/daemon-service-cli.js')
    const words = ['update', '--yes', '--scope', 'user', '--executable', '/x/daemon', '--serve', '/home/walnut/.open-walnut']
    expect(parseDaemonServiceArgs(words)).toEqual({ action: 'update', options: { yes: true, scope: 'user', executable: '/x/daemon', serve: { home: '/home/walnut/.open-walnut', on: true } } })
    expect(parseDaemonServiceArgs([...words, '--walnut', WALNUT]).options.walnut).toBe(WALNUT)
    expect(parseDaemonServiceArgs(['status', '--walnut', WALNUT])).toEqual({ action: 'status', options: { walnut: WALNUT } })
    expect(() => parseDaemonServiceArgs(['status', '--walnut'])).toThrow(/walnut id/)
    expect(() => parseDaemonServiceArgs(['status', '--walnut', 'nothex'])).toThrow(/16 hex/)
  })
})
