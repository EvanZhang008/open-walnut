import { describe, it, expect } from 'vitest'
import { installedDaemonServiceScope, resolveDaemonServiceScope, type ScopeDeps } from '../../src/providers/daemon-service-scope.js'
import { CRON_BOOT_PROBE_SCRIPT } from '../../src/providers/daemon-service-boot-script.js'
import type { DaemonServiceFailure, DaemonServiceScope } from '../../src/providers/daemon-service-manager.js'

type Reply = { code?: number; stdout?: string; stderr?: string }

const HOME = '/home/walnut'
const UNIT_USER = '/home/walnut/.config/systemd/user/open-walnut-daemon.service'
const UNIT_SYSTEM = '/etc/systemd/system/open-walnut-daemon.service'
const BOOT_SCRIPT = '/home/walnut/.local/share/open-walnut/daemon/daemon-boot.sh'
const PLIST = '/home/walnut/Library/LaunchAgents/dev.openwalnut.session-daemon.plist'

const SHOW_ENV = 'systemctl --user show-environment'
const LINGER = 'loginctl show-user walnut -p Linger'
const ENABLE_LINGER = 'loginctl --no-ask-password enable-linger walnut'
const CRONTAB = 'crontab -l'
const PROBE = 'cron-probe'

const NO_MANAGER: Reply = { code: 1, stderr: 'Failed to connect to bus: No medium found' }
const NO_CRONTAB: Reply = { code: 1, stderr: 'no crontab for walnut\n' }

function harness(options: { platform?: 'linux' | 'darwin'; present?: string[]; replies?: Record<string, Reply | Reply[]> } = {}) {
  const calls: string[] = []
  const looked: string[] = []
  const table: Record<string, Reply[]> = {}
  const defaults: Record<string, Reply | Reply[]> = {
    [SHOW_ENV]: { stdout: 'HOME=/home/walnut\n' },
    [LINGER]: { stdout: 'Linger=yes\n' },
    [ENABLE_LINGER]: { code: 1, stderr: 'Could not enable linger: Access denied' },
    [CRONTAB]: { stdout: '' },
    [PROBE]: { stdout: 'enabled cron.service\n' },
  }
  for (const [line, reply] of Object.entries({ ...defaults, ...options.replies })) table[line] = Array.isArray(reply) ? [...reply] : [reply]
  const present = new Set(options.present ?? [])
  const deps: ScopeDeps = {
    platform: options.platform ?? 'linux',
    home: HOME,
    user: 'walnut',
    async run(program, args) {
      const line = program === '/bin/sh' && args[0] === '-c' && args[1] === CRON_BOOT_PROBE_SCRIPT ? PROBE : [program, ...args].join(' ')
      calls.push(line)
      const queue = table[line]
      if (!queue) throw new Error(`unexpected command: ${line}`)
      const reply = queue.length > 1 ? queue.shift()! : queue[0]
      return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
    },
    async present(file) {
      looked.push(file)
      return present.has(file)
    },
  }
  return { deps, calls, looked }
}

function expectScope(choice: Awaited<ReturnType<typeof resolveDaemonServiceScope>>): { scope: DaemonServiceScope; notes: string[] } {
  if ('failure' in choice) throw new Error(`expected a scope, got ${JSON.stringify(choice.failure)}`)
  return choice
}

function expectFailure(choice: Awaited<ReturnType<typeof resolveDaemonServiceScope>>): DaemonServiceFailure {
  if (!('failure' in choice)) throw new Error(`expected a failure, got ${JSON.stringify(choice)}`)
  return choice.failure
}

function expectNoSudo(h: ReturnType<typeof harness>) {
  expect(h.calls.join('\n')).not.toMatch(/sudo|pkexec|doas/)
}

describe('scope of a command with none given', () => {
  it.each(['user', 'system', 'cron'] as const)('uses an explicit %s scope without looking at the host', async (scope) => {
    const h = harness({ present: [UNIT_USER] })
    expect(expectScope(await resolveDaemonServiceScope('install', scope, h.deps))).toEqual({ scope, notes: [] })
    expect(h.calls).toEqual([])
    expect(h.looked).toEqual([])
  })

  it.each([
    ['user', UNIT_USER],
    ['system', UNIT_SYSTEM],
    ['cron', BOOT_SCRIPT],
  ] as const)('manages the one installed %s config', async (scope, file) => {
    for (const action of ['install', 'update', 'status', 'uninstall']) {
      const h = harness({ present: [file] })
      expect(expectScope(await resolveDaemonServiceScope(action, undefined, h.deps))).toEqual({ scope, notes: [] })
      expect(h.calls).toEqual([])
    }
  })

  it('reads two installed configs as none installed', async () => {
    const h = harness({ present: [UNIT_USER, BOOT_SCRIPT] })
    expect(await installedDaemonServiceScope(h.deps)).toBeNull()
    expect(expectScope(await resolveDaemonServiceScope('status', undefined, h.deps)).scope).toBe('user')
  })

  it.each([[[]], [[PLIST]]])('uses the login agent on macOS (present: %j)', async (present) => {
    const h = harness({ platform: 'darwin', present })
    expect(expectScope(await resolveDaemonServiceScope('install', undefined, h.deps))).toEqual({ scope: 'user', notes: [] })
    expect(h.calls).toEqual([])
    expect(h.looked).toEqual([PLIST])
  })

  it.each(['status', 'update', 'uninstall', 'restart'])('answers user for %s with nothing installed, probing nothing', async (action) => {
    const h = harness()
    expect(expectScope(await resolveDaemonServiceScope(action, undefined, h.deps))).toEqual({ scope: 'user', notes: [] })
    expect(h.calls).toEqual([])
  })
})

describe('install with nothing installed', () => {
  it('picks the user unit when a user manager answers and linger is on', async () => {
    const h = harness()
    expect(expectScope(await resolveDaemonServiceScope('install', undefined, h.deps))).toEqual({ scope: 'user', notes: [] })
    expect(h.calls).toEqual([SHOW_ENV, LINGER])
    expectNoSudo(h)
  })

  it('turns linger on when the account may, and says so', async () => {
    const h = harness({ replies: { [LINGER]: [{ stdout: 'no\n' }, { stdout: 'yes\n' }], [ENABLE_LINGER]: { code: 0 } } })
    const choice = expectScope(await resolveDaemonServiceScope('install', undefined, h.deps))
    expect(choice.scope).toBe('user')
    expect(choice.notes).toEqual(['turned linger on for walnut (this host allows it without a password), so the user service starts at boot'])
    expect(h.calls).toEqual([SHOW_ENV, LINGER, ENABLE_LINGER, LINGER])
    expectNoSudo(h)
  })

  it('falls back to cron when linger may not be turned on, and names why', async () => {
    const h = harness({ replies: { [LINGER]: { stdout: 'no\n' } } })
    const choice = expectScope(await resolveDaemonServiceScope('install', undefined, h.deps))
    expect(choice.scope).toBe('cron')
    expect(choice.notes).toHaveLength(1)
    expect(choice.notes[0]).toContain('linger is off and this account may not turn it on (Could not enable linger: Access denied)')
    expect(choice.notes[0]).toContain("from this account's crontab instead (cron.service is enabled at boot)")
    expect(h.calls).toEqual([SHOW_ENV, LINGER, ENABLE_LINGER, CRONTAB, PROBE])
    expectNoSudo(h)
  })

  it('falls back to cron when enable-linger exits 0 but linger stays off', async () => {
    const h = harness({ replies: { [LINGER]: { stdout: 'no\n' }, [ENABLE_LINGER]: { code: 0 } } })
    expect(expectScope(await resolveDaemonServiceScope('install', undefined, h.deps)).scope).toBe('cron')
  })

  it('picks cron with no user manager and an account with no crontab yet', async () => {
    const h = harness({ replies: { [SHOW_ENV]: NO_MANAGER, [CRONTAB]: NO_CRONTAB, [PROBE]: { stdout: 'running crond\n' } } })
    const choice = expectScope(await resolveDaemonServiceScope('install', undefined, h.deps))
    expect(choice.scope).toBe('cron')
    expect(choice.notes[0]).toContain('no systemd user manager answers for this account')
    expect(choice.notes[0]).toContain('crond is running')
    expect(h.calls).not.toContain(ENABLE_LINGER)
    expectNoSudo(h)
  })

  it('fails with noBootStart naming both reasons and the admin step when crontab is missing', async () => {
    const h = harness({ replies: { [SHOW_ENV]: NO_MANAGER, [CRONTAB]: { code: 127, stderr: 'sh: crontab: not found' } } })
    const failure = expectFailure(await resolveDaemonServiceScope('install', undefined, h.deps))
    expect(failure.code).toBe('noBootStart')
    expect(failure.message).toContain('no systemd user manager answers for this account')
    expect(failure.message).toContain('crontab is not installed')
    expect(failure.message).toContain('"loginctl enable-linger walnut"')
    expect(h.calls).toEqual([SHOW_ENV, CRONTAB])
    expectNoSudo(h)
  })

  it.each([
    ['crontab is denied', { [CRONTAB]: { code: 1, stderr: 'You (walnut) are not allowed to use this program (crontab)' } }, 'this account may not use crontab (You (walnut) are not allowed to use this program (crontab))'],
    ['no cron daemon starts at boot', { [PROBE]: { stdout: 'missing\n' } }, 'no cron daemon is enabled at boot or running here'],
    ['the cron probe fails', { [PROBE]: { code: 2 } }, 'could not tell whether a cron daemon starts at boot'],
  ] as const)('fails with noBootStart when linger is refused and %s', async (_name, replies, reason) => {
    const h = harness({ replies: { [LINGER]: { stdout: 'no\n' }, ...replies } })
    const failure = expectFailure(await resolveDaemonServiceScope('install', undefined, h.deps))
    expect(failure.code).toBe('noBootStart')
    expect(failure.message).toContain('linger is off and this account may not turn it on')
    expect(failure.message).toContain(reason)
    expect(failure.message).toContain('loginctl enable-linger walnut')
    expectNoSudo(h)
  })
})
