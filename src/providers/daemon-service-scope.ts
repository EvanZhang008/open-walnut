/**
 * Which service backend a `walnut daemon …` command with no `--scope` acts on.
 *
 * An installed one first: the command manages what is there. With nothing
 * installed, `install` picks the first way this account can start the daemon at
 * boot WITHOUT root, in this order:
 *   1. the systemd user unit, when a user manager answers and linger is on, or
 *      this account may turn linger on itself (polkit's set-self-linger: allowed
 *      without a password on some distributions; never with sudo);
 *   2. the cron boot script, when this account may use its crontab and a cron
 *      daemon starts at boot;
 *   3. none: the failure says what each one lacked and the one step an
 *      administrator could take.
 * macOS has one: the LaunchAgent, which starts at login.
 */
import { daemonServiceConfigFiles } from './daemon-service-config.js'
import { CRON_BOOT_PROBE_SCRIPT, isNoCrontab, parseCronBootProbe } from './daemon-service-boot-script.js'
import type { DaemonServiceCommandResult, DaemonServiceFailure, DaemonServiceScope } from './daemon-service-manager.js'
import { lingerValue } from './daemon-service-manager.js'

export interface ScopeDeps {
  platform: 'linux' | 'darwin'
  home: string
  user: string
  run(program: string, args: string[], input?: string): Promise<DaemonServiceCommandResult>
  /** Is a config at this path (owned or not)? */
  present(file: string): Promise<boolean>
}

export type ScopeChoice =
  | { scope: DaemonServiceScope; notes: string[] }
  | { failure: DaemonServiceFailure }

async function lingerOn(deps: ScopeDeps): Promise<boolean> {
  const shown = await deps.run('loginctl', ['show-user', deps.user, '-p', 'Linger'])
  return shown.code === 0 && lingerValue(shown.stdout) === 'yes'
}

/** The installed backend on this host, or null with none (or more than one, which stays the user's to sort out). */
export async function installedDaemonServiceScope(deps: Pick<ScopeDeps, 'platform' | 'home' | 'present'>): Promise<DaemonServiceScope | null> {
  if (deps.platform === 'darwin') return (await deps.present(daemonServiceConfigFiles('darwin', deps.home)[0])) ? 'user' : null
  const [user, system, cron] = daemonServiceConfigFiles('linux', deps.home)
  const found = { user: await deps.present(user), system: await deps.present(system), cron: await deps.present(cron) }
  const scopes = (Object.keys(found) as (keyof typeof found)[]).filter((scope) => found[scope])
  return scopes.length === 1 ? scopes[0] : null
}

export async function resolveDaemonServiceScope(action: string, explicit: DaemonServiceScope | undefined, deps: ScopeDeps): Promise<ScopeChoice> {
  if (explicit) return { scope: explicit, notes: [] }
  const installed = await installedDaemonServiceScope(deps)
  if (installed) return { scope: installed, notes: [] }
  if (deps.platform === 'darwin' || action !== 'install') return { scope: 'user', notes: [] }

  const notes: string[] = []
  let systemd: string
  const manager = await deps.run('systemctl', ['--user', 'show-environment'])
  if (manager.code !== 0) systemd = 'no systemd user manager answers for this account'
  else if (await lingerOn(deps)) return { scope: 'user', notes }
  else {
    const enabled = await deps.run('loginctl', ['--no-ask-password', 'enable-linger', deps.user])
    if (enabled.code === 0 && await lingerOn(deps)) {
      notes.push(`turned linger on for ${deps.user} (this host allows it without a password), so the user service starts at boot`)
      return { scope: 'user', notes }
    }
    const said = (enabled.stderr || enabled.stdout).trim().split('\n').pop()
    systemd = `linger is off and this account may not turn it on${said ? ` (${said})` : ''}`
  }

  let cron: string
  const tab = await deps.run('crontab', ['-l'])
  if (tab.code !== 0 && !isNoCrontab(tab.stderr)) {
    const said = (tab.stderr || tab.stdout).trim().split('\n').pop()
    cron = tab.code === 127 || /not found|ENOENT/i.test(said ?? '') ? 'crontab is not installed' : `this account may not use crontab${said ? ` (${said})` : ''}`
  } else {
    const probed = await deps.run('/bin/sh', ['-c', CRON_BOOT_PROBE_SCRIPT])
    const boot = probed.code === 0 ? parseCronBootProbe(probed.stdout) : { ok: false as const, reason: 'could not tell whether a cron daemon starts at boot' }
    if (boot.ok) {
      notes.push(`${systemd}, so the daemon starts at boot from this account's crontab instead (${boot.via})`)
      return { scope: 'cron', notes }
    }
    cron = boot.reason
  }
  return {
    failure: {
      code: 'noBootStart',
      message: `this account cannot start the daemon at boot without root: ${systemd}, and ${cron}. `
        + `An administrator can run "loginctl enable-linger ${deps.user}" once (or enable a cron daemon), then Walnut sets the rest up by itself`,
    },
  }
}
