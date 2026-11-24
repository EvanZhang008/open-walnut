/**
 * Two Walnuts' services on one account (service sets, src/providers/service-set.ts): the default
 * set's and a second Walnut's own, under one fake HOME with real files. systemd, launchd and cron
 * are played by one shared fake machine, as the init system would be: one unit or job table, one
 * crontab. Each Walnut installs, restarts, updates (upgrades) and rolls back a failed update, and
 * neither manager ever names, lists or reads the other's unit, plist, cron line, launcher or
 * registry as its own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDaemonServiceManager, type DaemonServiceCommandResult, type DaemonServiceManager } from '../../src/providers/daemon-service-manager.js'
import { createCronDaemonServiceManager } from '../../src/providers/daemon-service-cron.js'
import { CRON_BOOT_PROBE_SCRIPT, readDaemonBootExecutable } from '../../src/providers/daemon-service-boot-script.js'
import { daemonServiceConfigFiles } from '../../src/providers/daemon-service-config.js'
import { serviceSet, type ServiceSet } from '../../src/providers/service-set.js'

const B = 'bbbbbbbbbbbbbbbb'
const UID = 1000
const ok = (stdout = ''): DaemonServiceCommandResult => ({ code: 0, stdout, stderr: '' })

let home = ''
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-two-sets-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

/** One machine's init systems and crontab, shared by every manager on it. */
function machine() {
  const units = new Map<string, { enabled: boolean; active: boolean; starts: number }>()
  const jobs = new Map<string, string>()
  const log: { who: string; line: string }[] = []
  let crontab = ''
  const unitFile = (name: string) => path.join(home, '.config', 'systemd', 'user', name)
  const unit = (name: string) => { if (!units.has(name)) units.set(name, { enabled: false, active: false, starts: 0 }); return units.get(name)! }
  const run = (who: string) => async (program: string, args: string[], input?: string): Promise<DaemonServiceCommandResult> => {
    if (program === '/bin/sh' && args[1] === CRON_BOOT_PROBE_SCRIPT) return ok('enabled cron.service\n')
    const line = [program, ...args].join(' ')
    log.push({ who, line })
    if (line === 'systemctl --user show-environment') return ok('HOME=/x\n')
    if (line.startsWith('loginctl show-user')) return ok('Linger=yes\n')
    if (line === 'crontab -l') return ok(crontab)
    if (line === 'crontab -') { crontab = input ?? ''; return ok() }
    if (program === 'systemctl') {
      const [, verb, ...rest] = args
      const name = rest.find((w) => w.endsWith('.service'))!
      if (verb === 'daemon-reload') return ok()
      const u = unit(name)
      switch (verb) {
        case 'is-active': return u.active ? ok('active\n') : { code: 3, stdout: 'inactive\n', stderr: '' }
        case 'is-enabled': return u.enabled ? ok('enabled\n') : { code: 1, stdout: 'disabled\n', stderr: '' }
        case 'show': return ok(`FragmentPath=${fs.existsSync(unitFile(name)) ? unitFile(name) : ''}\nDropInPaths=\n`)
        case 'enable': if (rest.includes('--now')) { u.active = true; u.starts++ } u.enabled = true; return ok()
        case 'disable': u.enabled = false; if (rest.includes('--now')) u.active = false; return ok()
        case 'restart': u.active = true; u.starts++; return ok()
        case 'stop': u.active = false; return ok()
        case 'reset-failed': return ok()
      }
    }
    if (program === 'launchctl') {
      const [verb, target, plist] = args
      if (verb === 'print-disabled') return ok('disabled services = {\n}\n')
      const label = target!.split('/').pop()!
      if (verb === 'print') return jobs.has(label) ? ok(`${target} = {\n\tpath = ${jobs.get(label)}\n\tstate = running\n\tpid = 4242\n}\n`) : { code: 113, stdout: '', stderr: 'not found' }
      if (verb === 'bootstrap') {
        const text = fs.readFileSync(plist!, 'utf8')
        jobs.set(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)![1]!, plist!)
        return ok()
      }
      if (verb === 'bootout') { jobs.delete(label); return ok() }
      if (verb === 'kickstart') return ok()
    }
    throw new Error(`unexpected command: ${line}`)
  }
  return { units, jobs, log, run, crontab: () => crontab }
}

type Machine = ReturnType<typeof machine>

/** A Walnut's service manager for `set`: its own files (an ownership record of its own), its own versions. */
function walnut(m: Machine, who: string, set: ServiceSet, platform: 'linux' | 'darwin', scope: 'user' | 'cron') {
  const owned = new Set<string>()
  let next = 1
  let bad: string | null = null
  const exe = (n: number) => path.join(set.installRoot, 'versions', `v${n}`, 'daemon')
  const files = {
    async writeConfig(file: string, text: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); owned.add(file) },
    async removeConfig(file: string) { fs.rmSync(file, { force: true }); owned.delete(file) },
    async readConfig(file: string) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null },
    async inspectConfig(file: string) { return { present: fs.existsSync(file), owned: owned.has(file) } },
  }
  const common = {
    platform, home, uid: UID, user: 'walnut', path: '/usr/bin:/bin', stateDir: set.installRoot, runtimeDir: set.runtimeDir, set,
    ...files,
    async prepareExecutable() { return { executable: exe(next++), args: ['--service'] } },
    async ready(_s: unknown, expected?: string) { return expected === undefined || expected !== bad },
    async stay() { return null },
    async prepareUpdate() { return 'prepared' as const },
    async proveBoot() { return null },
    sleep: async () => {},
  }
  let manager: DaemonServiceManager
  const daemon = { supervisor: null as number | null, exe: null as string | null, stop: false }
  if (scope === 'cron') {
    const script = path.join(set.installRoot, 'daemon-boot.sh')
    const startDaemon = () => { daemon.exe = readDaemonBootExecutable(fs.readFileSync(script, 'utf8')) }
    manager = createCronDaemonServiceManager({
      ...common, platform: 'linux', run: m.run(who),
      // The running daemon prepares and exits; its supervisor starts the script on disk again.
      async prepareUpdate() { daemon.exe = null; if (daemon.supervisor && !daemon.stop) startDaemon(); return 'prepared' as const },
      async spawnDetached() { daemon.supervisor = 77; startDaemon() },
      async serviceDaemon() { return daemon.exe ? { pid: 88, executable: daemon.exe } : null },
      async supervisor() { return daemon.supervisor },
      async signal(pid) {
        if (pid === 88) { daemon.exe = null; if (daemon.supervisor && !daemon.stop && fs.existsSync(script)) startDaemon() }
        if (pid === 77) { daemon.supervisor = null; daemon.exe = null }
      },
      async waitGone() { return true },
      async setStop(on) { daemon.stop = on; if (on) { daemon.supervisor = null; daemon.exe = null } },
    })
  } else {
    manager = createDaemonServiceManager({ ...common, run: m.run(who) })
  }
  return {
    manager, set, exe, daemon,
    failNext() { bad = exe(next) },
    configPath: manager.configPath(scope),
  }
}

const names = (set: ServiceSet) => [set.unit, set.label, set.cronTag]

describe.each([
  { platform: 'linux' as const, scope: 'user' as const },
  { platform: 'darwin' as const, scope: 'user' as const },
  { platform: 'linux' as const, scope: 'cron' as const },
])('two Walnuts on one account, $platform $scope', ({ platform, scope }) => {
  it('each installs, restarts, upgrades and rolls back its own service, and never touches the other\'s', async () => {
    const m = machine()
    const a = walnut(m, 'A', serviceSet(platform, home, '', { runtimeDir: '/tmp/open-walnut' }), platform, scope)
    const b = walnut(m, 'B', serviceSet(platform, home, B, { uid: UID }), platform, scope)
    expect(a.configPath).not.toBe(b.configPath)
    // No cross listing: the config tables of the two sets share no file.
    expect(daemonServiceConfigFiles(platform, home).filter((f) => daemonServiceConfigFiles(platform, home, b.set).includes(f))).toEqual([])
    const opts = { scope }
    const text = (w: typeof a) => fs.readFileSync(w.configPath, 'utf8')

    // A installs the default set; B's manager does not read it as its own (nor as foreign: it is not B's file).
    expect((await a.manager.install(opts)).ok).toBe(true)
    const bBefore = await b.manager.status(opts)
    expect(bBefore.installed).toBe(false)
    expect(bBefore.foreign).toBe(false)
    expect(text(a)).not.toContain('WALNUT_SERVICE_SET')

    // B installs its own set beside it.
    const aInstalled = text(a)
    const bInstall = await b.manager.install(opts)
    expect(bInstall.ok, JSON.stringify(bInstall)).toBe(true)
    expect(text(a)).toBe(aInstalled)
    expect(text(b)).toContain(B)
    expect(text(b)).toContain(b.set.installRoot)
    expect(text(b)).toContain(b.set.runtimeDir)
    if (scope === 'cron') expect(text(b)).toContain(`export WALNUT_SERVICE_SET='${B}'`)
    else expect(text(b)).toMatch(new RegExp(`WALNUT_SERVICE_SET(=|</key>\\s*<string>)${B}`))
    for (const w of [a, b]) {
      const s = await w.manager.status(opts)
      expect(s.installed && s.active && s.enabled, w.set.id || 'default').toBe(true)
      expect(s.configPath).toBe(w.configPath)
    }
    if (scope === 'cron') {
      const tab = m.crontab()
      expect(tab).toContain(`${a.set.installRoot}/daemon-boot.sh' >/dev/null 2>&1 # open-walnut-daemon\n`)
      expect(tab).toContain(`${b.set.installRoot}/daemon-boot.sh' >/dev/null 2>&1 # open-walnut-daemon ${B}\n`)
    }

    // Each restarts alone.
    expect((await b.manager.restart(opts)).ok).toBe(true)
    expect((await a.manager.restart(opts)).ok).toBe(true)

    // Each upgrades alone: the other's config stays byte for byte.
    for (const [w, other] of [[a, b], [b, a]] as const) {
      const otherText = text(other)
      const up = await w.manager.update(opts)
      expect(up.ok, JSON.stringify(up)).toBe(true)
      expect(text(w)).toContain(w.exe(2))
      expect(text(other)).toBe(otherText)
      if (scope === 'cron') expect(w.daemon.exe).toBe(w.exe(2))
    }

    // A failed upgrade of each is rolled back to its own previous version; the other's is untouched.
    for (const [w, other] of [[a, b], [b, a]] as const) {
      const before = text(w)
      const otherText = text(other)
      w.failNext()
      const up = await w.manager.update(opts)
      expect(up.ok).toBe(false)
      expect(up.ok ? '' : up.failure.rollback ?? '').toMatch(/previous|put back|back/)
      expect(text(w)).toBe(before)
      expect(text(other)).toBe(otherText)
      const s = await w.manager.status(opts)
      expect(s.installed && s.active).toBe(true)
      if (scope === 'cron') expect(w.daemon.exe).toBe(w.exe(2))
    }

    // cron has no init-system names: both sets' lines are still in the one crontab, each once.
    if (scope === 'cron') {
      for (const w of [a, b]) expect(m.crontab().split('\n').filter((l) => l.includes(`${w.set.installRoot}/daemon-boot.sh'`) && l.startsWith('@reboot'))).toHaveLength(1)
    }
    // Every init-system command a manager ran named its own set only.
    for (const [w, other, who] of scope === 'cron' ? [] : [[a, b, 'A'], [b, a, 'B']] as const) {
      const lines = m.log.filter((l) => l.who === who && !l.line.startsWith('crontab') && !l.line.startsWith('loginctl') && !l.line.includes('show-environment') && !l.line.includes('print-disabled') && !l.line.includes('daemon-reload'))
      expect(lines.length).toBeGreaterThan(0)
      for (const { line } of lines) {
        expect(names(w.set).some((n) => line.includes(n)), `${who}: ${line}`).toBe(true)
        // The default's names are a prefix of the set's: compare whole words.
        const words = line.split(/[\s/]+/)
        if (other.set.id) expect(words.some((x) => x === other.set.unit || x === other.set.label || x.endsWith(other.set.plist)), `${who}: ${line}`).toBe(false)
        else expect(words.some((x) => x === other.set.unit || x === other.set.label), `${who}: ${line}`).toBe(false)
      }
    }

    // B leaves; A keeps running as it was.
    const aText = text(a)
    expect((await b.manager.uninstall(opts)).ok).toBe(true)
    expect(fs.existsSync(b.configPath)).toBe(false)
    expect(text(a)).toBe(aText)
    const aAfter = await a.manager.status(opts)
    expect(aAfter.installed && aAfter.active).toBe(true)
    if (scope === 'cron') {
      expect(m.crontab()).toContain('# open-walnut-daemon\n')
      expect(m.crontab()).not.toContain(B)
    }
  })
  it('an update gives an older set\'s config the env a set carries now; the default set\'s keeps its own text', async () => {
    // Review of the 2026-11-24 drill fixes (S2): a set installed before WALNUT_RUNTIME_DIR was in its
    // env kept a config whose update replaced only the executable, so its walnut file still unpacked
    // into the default Walnut's data home.
    const m = machine()
    const a = walnut(m, 'A', serviceSet(platform, home, '', { runtimeDir: '/tmp/open-walnut' }), platform, scope)
    const b = walnut(m, 'B', serviceSet(platform, home, B, { uid: UID }), platform, scope)
    const opts = { scope }
    const text = (w: typeof a) => fs.readFileSync(w.configPath, 'utf8')
    expect((await a.manager.install(opts)).ok).toBe(true)
    expect((await b.manager.install(opts)).ok).toBe(true)
    const trees = `${b.set.installRoot}/runtime`
    expect(text(b)).toContain(trees)
    // The config as an older Walnut wrote it: no WALNUT_RUNTIME_DIR line.
    fs.writeFileSync(b.configPath, text(b).split('\n').filter((l) => !l.includes('WALNUT_RUNTIME_DIR') && !l.includes(trees)).join('\n'))
    expect(text(b)).not.toContain('WALNUT_RUNTIME_DIR')
    const up = await b.manager.update(opts)
    expect(up.ok, JSON.stringify(up)).toBe(true)
    expect(text(b)).toContain(trees)
    expect(text(b)).toContain(b.exe(2))
    // The default set's update still replaces only its executable.
    const before = text(a)
    expect((await a.manager.update(opts)).ok).toBe(true)
    expect(text(a)).toBe(before.split(a.exe(1)).join(a.exe(2)))
  })
})
