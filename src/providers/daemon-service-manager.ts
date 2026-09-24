import path from 'node:path'
import {
  DAEMON_SERVICE_LABEL,
  DAEMON_SERVICE_PLIST_NAME,
  DAEMON_SERVICE_UNIT_NAME,
  renderDaemonLaunchAgent,
  renderDaemonSystemdUnit,
  replaceDaemonServiceExecutable,
  readDaemonServiceExecutable,
  type DaemonServiceConfig,
  type DaemonServicePlatform,
} from './daemon-service-config.js'

export type DaemonServiceScope = 'user' | 'system'

export type DaemonServiceStartup = 'boot' | 'login' | 'on-demand' | 'unavailable'

export type DaemonServiceErrorCode =
  | 'unsupportedScope'
  | 'missingUser'
  | 'userManagerUnavailable'
  | 'requiresLinger'
  | 'foreignConfig'
  | 'unverifiedJob'
  | 'invalidArgv'
  | 'invalidConfig'
  | 'commandFailed'
  | 'verifyFailed'
  | 'notReady'
  | 'hostError'
  | 'notInstalled'
  | 'disabledOverride'
  | 'overrideUnreadable'
  | 'handoverPending'
  | 'serviceInactive'
  | 'updateRefused'

export interface DaemonServiceCommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface DaemonServiceDeps {
  platform: DaemonServicePlatform
  home: string
  uid: number
  user: string
  path: string
  stateDir: string
  runtimeDir: string
  run(program: string, args: string[]): Promise<DaemonServiceCommandResult>
  writeConfig(configPath: string, text: string): Promise<void>
  removeConfig(configPath: string): Promise<void>
  prepareExecutable(): Promise<{ executable: string; args: string[] }>
  inspectConfig(configPath: string): Promise<{ present: boolean; owned: boolean }>
  readConfig(configPath: string): Promise<string | null>
  ready(status: DaemonServiceStatus, expectedExecutable?: string): Promise<boolean>
  handover?(): Promise<boolean>
  prepareUpdate?(): Promise<void>
}

export interface DaemonServiceStatus {
  platform: DaemonServicePlatform
  scope: DaemonServiceScope
  configPath: string
  installed: boolean
  foreign: boolean
  active: boolean
  enabled: boolean
  startup: DaemonServiceStartup
  detail?: string
}

export interface DaemonServiceFailure {
  code: DaemonServiceErrorCode
  message: string
  command?: string
  stderr?: string
  rollback?: string
}

export type DaemonServiceResult =
  | { ok: true; status: DaemonServiceStatus }
  | { ok: false; failure: DaemonServiceFailure }

export interface DaemonServiceOptions {
  scope?: DaemonServiceScope
}

export interface DaemonServiceManager {
  configPath(scope?: DaemonServiceScope): string
  status(options?: DaemonServiceOptions): Promise<DaemonServiceStatus>
  install(options?: DaemonServiceOptions): Promise<DaemonServiceResult>
  update(options?: DaemonServiceOptions): Promise<DaemonServiceResult>
  uninstall(options?: DaemonServiceOptions): Promise<DaemonServiceResult>
  restart(options?: DaemonServiceOptions): Promise<DaemonServiceResult>
}

export class DaemonServiceHandoverPendingError extends Error {}
export class DaemonServiceUpdateRefusedError extends Error {}

const FOREGROUND_ARG = '--service'

export function daemonServiceConfigPath(
  platform: DaemonServicePlatform,
  home: string,
  scope: DaemonServiceScope,
): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', DAEMON_SERVICE_PLIST_NAME)
  return scope === 'system'
    ? path.join('/etc', 'systemd', 'system', DAEMON_SERVICE_UNIT_NAME)
    : path.join(home, '.config', 'systemd', 'user', DAEMON_SERVICE_UNIT_NAME)
}

export type LaunchdOverride = 'allowed' | 'disabled' | 'unknown'

/** Whose config the init system is actually serving under our name. */
type JobIdentity = 'none' | 'ours' | 'foreign' | 'unverified'

/** The startup/run state a service had before an install touched it. */
interface Was {
  active: boolean
  enabled: boolean
  registered: boolean
}

interface Undo {
  updateStarted: boolean
  handedOver: boolean
  wrote: boolean
  ours: boolean
  previous: string | null
  was: Was
}

interface Probe {
  present: boolean
  owned: boolean
  active: boolean
  enabled: boolean
  registered: boolean
  linger: boolean
  identity: JobIdentity
  identityDetail?: string
  identityCommand: string
  override?: LaunchdOverride
  overrideCommand?: string
  overrideStderr?: string
}

// launchctl print puts the plist it loaded on its own line; the spacing varies.
const LAUNCHD_PATH = /^[ \t]*path[ \t]*=[ \t]*(\S[^\n]*?)[ \t]*$/m

const describeState = (state: { active: boolean; enabled: boolean }): string =>
  `${state.active ? 'active' : 'stopped'} and ${state.enabled ? 'enabled' : 'not enabled'}`

const DISABLED_BLOCK = /disabled\s+services\s*=\s*\{([^}]*)\}/
function parseLaunchdOverride(stdout: string): LaunchdOverride {
  const block = DISABLED_BLOCK.exec(stdout)
  if (!block) return 'unknown'
  let verdict: LaunchdOverride = 'allowed'
  for (const line of block[1].split('\n').map((line) => line.trim()).filter(Boolean)) {
    const entry = line.match(/^"([^"]+)"\s*=>\s*(true|false|disabled|enabled)\s*,?$/)
    if (!entry) return 'unknown'
    if (entry[1] === DAEMON_SERVICE_LABEL) verdict = ['true', 'disabled'].includes(entry[2]) ? 'disabled' : 'allowed'
  }
  return verdict
}

export function createDaemonServiceManager(deps: DaemonServiceDeps): DaemonServiceManager {
  const cfgPath = (scope: DaemonServiceScope): string =>
    daemonServiceConfigPath(deps.platform, deps.home, scope)
  const target = (): string => `gui/${deps.uid}/${DAEMON_SERVICE_LABEL}`
  const scoped = (scope: DaemonServiceScope, args: string[]): string[] =>
    scope === 'user' ? ['--user', ...args] : args

  const fail = (
    code: DaemonServiceErrorCode,
    message: string,
    command?: string,
    stderr?: string,
  ): DaemonServiceResult => ({
    ok: false,
    failure: { code, message, ...(command ? { command } : {}), ...(stderr ? { stderr } : {}) },
  })

  async function step(program: string, args: string[]): Promise<DaemonServiceResult | null> {
    const line = [program, ...args].join(' ')
    const result = await deps.run(program, args)
    if (result.code === 0) return null
    return fail('commandFailed', `${line} exited with ${result.code}`, line, result.stderr)
  }

  const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

  // Probes and commands are someone else's I/O; if they throw, that must still become a structured failure, never a raw exception for the caller.
  const guarded = (attempt: () => Promise<DaemonServiceResult>): Promise<DaemonServiceResult> =>
    attempt().catch((err: unknown) => fail(err instanceof DaemonServiceHandoverPendingError ? 'handoverPending'
      : err instanceof DaemonServiceUpdateRefusedError ? 'updateRefused' : 'hostError', errText(err)))

  async function lingerOn(): Promise<boolean> {
    const result = await deps.run('loginctl', ['show-user', deps.user, '-p', 'Linger', '--value'])
    return result.code === 0 && result.stdout.trim() === 'yes'
  }

  // Loaded does not mean it will start at the next login; the disabled override must be checked separately.
  async function readOverride(): Promise<{
    verdict: LaunchdOverride
    command: string
    stderr: string
  }> {
    const args = ['print-disabled', `gui/${deps.uid}`]
    const printed = await deps.run('launchctl', args)
    return {
      verdict: printed.code === 0 ? parseLaunchdOverride(printed.stdout) : 'unknown',
      command: ['launchctl', ...args].join(' '),
      stderr: printed.stderr,
    }
  }

  // A unit with the same name may come from a higher-priority directory or be changed by a drop-in; neither is the one we installed.
  async function unitIdentity(scope: DaemonServiceScope): Promise<{
    identity: JobIdentity
    identityDetail?: string
    identityCommand: string
  }> {
    const args = scoped(scope, ['show', DAEMON_SERVICE_UNIT_NAME, '-p', 'FragmentPath', '-p', 'DropInPaths'])
    const identityCommand = ['systemctl', ...args].join(' ')
    const shown = await deps.run('systemctl', args)
    const props = new Map<string, string>()
    for (const line of shown.stdout.split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) props.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
    }
    const fragment = props.get('FragmentPath')
    const dropIns = props.get('DropInPaths')
    if (shown.code !== 0 || fragment === undefined || dropIns === undefined) {
      return { identity: 'unverified', identityCommand }
    }
    if (fragment === '') return { identity: 'none', identityCommand }
    if (fragment !== cfgPath(scope)) return { identity: 'foreign', identityDetail: fragment, identityCommand }
    if (dropIns !== '') return { identity: 'foreign', identityDetail: `drop-ins ${dropIns}`, identityCommand }
    return { identity: 'ours', identityCommand }
  }

  function launchdIdentity(
    scope: DaemonServiceScope,
    printed: DaemonServiceCommandResult,
  ): { identity: JobIdentity; identityDetail?: string } {
    if (printed.code !== 0) return { identity: printed.code === 113 ? 'none' : 'unverified' }
    const loadedFrom = LAUNCHD_PATH.exec(printed.stdout)?.[1]
    if (!loadedFrom) return { identity: 'unverified' }
    if (loadedFrom === cfgPath(scope)) return { identity: 'ours' }
    return { identity: 'foreign', identityDetail: loadedFrom }
  }

  async function probe(
    scope: DaemonServiceScope,
    seen?: { present: boolean; owned: boolean },
  ): Promise<Probe> {
    const found = seen ?? await deps.inspectConfig(cfgPath(scope))
    if (deps.platform === 'darwin') {
      const args = ['print', target()]
      const printed = await deps.run('launchctl', args)
      const loaded = printed.code === 0
      const override = await readOverride()
      return {
        present: found.present,
        owned: found.owned,
        enabled: loaded && override.verdict === 'allowed',
        active: loaded && /state = running|pid = \d+/.test(printed.stdout),
        registered: loaded,
        linger: false,
        ...launchdIdentity(scope, printed),
        identityCommand: ['launchctl', ...args].join(' '),
        override: override.verdict,
        overrideCommand: override.command,
        overrideStderr: override.stderr,
      }
    }
    const active = await deps.run('systemctl', scoped(scope, ['is-active', DAEMON_SERVICE_UNIT_NAME]))
    const enabled = await deps.run('systemctl', scoped(scope, ['is-enabled', DAEMON_SERVICE_UNIT_NAME]))
    // static / enabled-runtime also exit 0, but neither means start at boot; only 'enabled' counts.
    const bootStart = enabled.code === 0 && enabled.stdout.trim() === 'enabled'
    const unit = await unitIdentity(scope)
    return {
      present: found.present,
      owned: found.owned,
      active: active.code === 0,
      enabled: bootStart,
      registered: active.code === 0 || bootStart,
      linger: scope === 'user' ? await lingerOn() : false,
      ...unit,
    }
  }

  // Before any change, confirm that the registered job is the one we installed: leave alone anything foreign, unclear, or
  // whose config is no longer on disk while a job with the same name still exists.
  function jobRefusal(scope: DaemonServiceScope, mine: boolean, p: Probe): DaemonServiceFailure | null {
    if (p.identity === 'none' || (p.identity === 'ours' && mine)) return null
    if (p.identity === 'unverified') {
      return {
        code: 'unverifiedJob',
        message: `could not confirm which config the already loaded ${DAEMON_SERVICE_LABEL} service came from, so walnut will not act on it`,
        command: p.identityCommand,
      }
    }
    const from = p.identity === 'foreign'
      ? `from ${p.identityDetail}, not from ${cfgPath(scope)}`
      : `from ${cfgPath(scope)}, which is not on disk as a config this tool owns`
    return {
      code: 'foreignConfig',
      message: `a service is already loaded ${from}; unload it yourself before letting walnut manage this host`,
      command: p.identityCommand,
    }
  }

  function overrideNote(override?: LaunchdOverride): string | undefined {
    if (override === 'disabled') {
      return `launchd keeps ${DAEMON_SERVICE_LABEL} disabled for this login session, so it will not start on its own`
    }
    if (override === 'unknown') {
      return `launchd did not say whether ${DAEMON_SERVICE_LABEL} is disabled, so a login start cannot be confirmed`
    }
    return undefined
  }

  // The on-disk copy being ours does not mean the running job was started from it.
  function identityNote(scope: DaemonServiceScope, p: Probe, installed: boolean): string | undefined {
    if (p.identity === 'foreign') {
      return `the service registered here comes from ${p.identityDetail}, not from ${cfgPath(scope)}`
    }
    if (p.identity === 'unverified') return 'could not confirm which config the registered service came from'
    if (p.identity === 'ours' && !installed) {
      return `a service is registered from ${cfgPath(scope)}, which is not on disk as a config this tool owns`
    }
    return undefined
  }

  function statusOf(scope: DaemonServiceScope, p: Probe, detail?: string): DaemonServiceStatus {
    const installed = p.present && p.owned
    const mine = installed && p.identity === 'ours'
    const active = p.active && mine
    const enabled = p.enabled && mine
    let startup: DaemonServiceStartup = 'unavailable'
    if (installed && !enabled) startup = 'on-demand'
    else if (installed && deps.platform === 'darwin') startup = 'login'
    else if (installed) startup = scope === 'system' || p.linger ? 'boot' : 'login'
    detail = detail ?? identityNote(scope, p, installed) ?? (installed ? overrideNote(p.override) : undefined)
    return {
      platform: deps.platform,
      scope,
      configPath: cfgPath(scope),
      installed,
      foreign: p.present && !p.owned,
      active,
      enabled,
      startup,
      ...(detail ? { detail } : {}),
    }
  }

  function scopeRefusal(scope: DaemonServiceScope): DaemonServiceResult | null {
    if (deps.platform === 'darwin' && scope === 'system') {
      return fail(
        'unsupportedScope',
        'macOS starts the daemon as a login agent; a system-wide LaunchDaemon is not supported here',
      )
    }
    if (deps.uid === 0 || deps.user === 'root') {
      return fail('missingUser', 'The daemon must run as the original non-root account; root-owned service installation is not supported')
    }
    if (scope === 'system' && deps.user.trim() === '') {
      return fail('missingUser', 'a system-scope unit needs the account name so the daemon keeps running as that user')
    }
    return null
  }

  // Exit code 0 only means the init system accepted the request; installed means the config is in place, the registered job is it,
  // the service is running, and the daemon answers.
  async function confirm(
    scope: DaemonServiceScope,
    phase: 'install' | 'restart',
    expectedExecutable?: string,
  ): Promise<DaemonServiceResult> {
    // When bootstrap returns the process may not have started yet; verify ownership first, then wait for hello.
    const opened = await probe(scope)
    if (phase === 'install' && (!opened.present || !opened.owned)) {
      return fail('verifyFailed', `${cfgPath(scope)} is not in place after the write`)
    }
    const early = jobRefusal(scope, opened.present && opened.owned, opened)
    if (early) return { ok: false, failure: early }
    if (!(await deps.ready(statusOf(scope, opened), expectedExecutable))) {
      const asWhat = expectedExecutable ? `as ${expectedExecutable}` : 'as ready'
      return fail('notReady', `the daemon never answered ${asWhat}`)
    }
    // Probe once more after the answer: the registered copy may have been swapped while waiting, and then hello does not prove it is the one running now.
    const after = await probe(scope)
    if (phase === 'restart') {
      if (!after.active) return fail('verifyFailed', 'the service is not active after the restart')
    } else {
      if (!after.present || !after.owned) {
        return fail('verifyFailed', `${cfgPath(scope)} is not in place after the write`)
      }
      if (!after.enabled) return fail('verifyFailed', 'the service did not come up enabled')
      if (!after.active) return fail('verifyFailed', 'the service is not active after being enabled')
    }
    const stray = jobRefusal(scope, after.present && after.owned, after)
    if (stray) return { ok: false, failure: stray }
    return { ok: true, status: statusOf(scope, after) }
  }

  async function runAll(steps: [string, string[]][]): Promise<string | null> {
    for (const [program, args] of steps) {
      const result = await deps.run(program, args)
      if (result.code !== 0) return `${[program, ...args].join(' ')} exited with ${result.code}`
    }
    return null
  }

  // Back out only a job we just registered ourselves: if nothing is loaded, or the loaded one is not ours, do nothing.
  async function bootoutLoaded(scope: DaemonServiceScope): Promise<string | null> {
    const printed = await deps.run('launchctl', ['print', target()])
    if (printed.code === 113) return null
    if (launchdIdentity(scope, printed).identity !== 'ours') {
      return `the loaded ${DAEMON_SERVICE_LABEL} job did not come from ${cfgPath(scope)}`
    }
    const out = await deps.run('launchctl', ['bootout', target()])
    return out.code === 0 ? null : `${DAEMON_SERVICE_LABEL} stayed loaded`
  }

  // Rollback succeeds when things are back to the pre-install state: config in place, the registered job is still it, and the enable and run state both match.
  async function confirmRestored(scope: DaemonServiceScope, was: Was, executable?: string): Promise<string | null> {
    const after = await probe(scope)
    if (!after.present || !after.owned) return `${cfgPath(scope)} is not back in place`
    const stray = jobRefusal(scope, true, after)
    if (stray) return stray.message
    if (after.registered !== was.registered) return 'the service registration did not return to its previous state'
    if (after.active !== was.active || after.enabled !== was.enabled) {
      return `the service is ${describeState(after)} instead of ${describeState(was)} as before`
    }
    if (was.active && !(await deps.ready(statusOf(scope, after), executable))) return 'the daemon never answered as ready'
    return null
  }

  // Rollback must keep the enable and run state from before the install.
  async function restorePrevious(scope: DaemonServiceScope, previous: string, was: Was, executable?: string): Promise<string> {
    const put = 'put the previous config back'
    try {
      await deps.writeConfig(cfgPath(scope), previous)
    } catch (err) {
      return `could not ${put} at ${cfgPath(scope)}: ${errText(err)}`
    }
    let broke: string | null
    if (deps.platform === 'darwin') {
      broke = await bootoutLoaded(scope)
      if (!broke && was.registered) {
        broke = await runAll([['launchctl', ['bootstrap', `gui/${deps.uid}`, cfgPath(scope)]]])
      }
    } else {
      const steps: [string, string[]][] = [['systemctl', scoped(scope, ['daemon-reload'])]]
      if (!was.enabled) steps.push(['systemctl', scoped(scope, ['disable', DAEMON_SERVICE_UNIT_NAME])])
      if (was.active) steps.push(['systemctl', scoped(scope, ['reset-failed', DAEMON_SERVICE_UNIT_NAME])])
      steps.push(['systemctl', scoped(scope, [was.active ? 'restart' : 'stop', DAEMON_SERVICE_UNIT_NAME])])
      broke = await runAll(steps)
    }
    if (broke) return `${put}, but ${broke}`
    const again = await confirmRestored(scope, was, executable)
    if (again) return `${put}, but the previous version did not come back: ${again}`
    return was.active
      ? executable ? `${put} and the previous executable is responding` : `${put} and a managed daemon is responding; the previous executable identity was not verified`
      : `${put} and left the service ${describeState(was)}, as it was before`
  }

  // A first install failed: undo this registration, delete the config this install wrote, and return to the original no-service state.
  async function undoFirstInstall(scope: DaemonServiceScope): Promise<string> {
    const gone = 'removed the config this install wrote'
    // systemd needs the unit file still on disk to stop the service, so disable must come before the delete.
    const stuck = deps.platform === 'darwin'
      ? await bootoutLoaded(scope)
      : await runAll([['systemctl', scoped(scope, ['disable', '--now', DAEMON_SERVICE_UNIT_NAME])]])
    if (stuck) return `kept the service config because the stop was not confirmed: ${stuck}`
    const lingering = (p: Probe): string | null => {
      if (p.identity === 'unverified') return 'the init system would not say what is still registered'
      return p.active || p.registered ? 'the service is still registered with the init system' : null
    }
    // Exit code 0 only means the request was accepted; before deleting the unit/plist we must probe that it is really neither running nor registered,
    // otherwise we would delete the config of a service we cannot stop.
    const before = lingering(await probe(scope))
    if (before) return `kept the service config because the stop was not confirmed: ${before}`
    try {
      await deps.removeConfig(cfgPath(scope))
    } catch (err) {
      return `could not remove the config this install wrote at ${cfgPath(scope)}: ${errText(err)}`
    }
    const reload = deps.platform === 'darwin'
      ? null
      : await runAll([['systemctl', scoped(scope, ['daemon-reload'])]])
    if (reload) return `${gone}, but ${reload}`
    const after = await probe(scope)
    const left = after.present ? `${cfgPath(scope)} is still on disk` : lingering(after)
    return left ? `${gone}, but ${left}` : `${gone}, so no service is registered`
  }

  async function install(options: DaemonServiceOptions = {}, updateOnly = false): Promise<DaemonServiceResult> {
    const scope = options.scope ?? 'user'
    const undo: Undo = {
      updateStarted: false,
      handedOver: false,
      wrote: false,
      ours: false,
      previous: null,
      was: { active: false, enabled: false, registered: false },
    }
    const result = await guarded(() => attemptInstall(scope, undo, updateOnly))
    if (result.ok || !undo.wrote) return result
    if (undo.handedOver || result.failure.code === 'handoverPending') {
      return { ok: false, failure: { ...result.failure, rollback: 'Kept the service config and session state because the previous daemon may have exited; retry installation to finish the handover' } }
    }
    let rollback: string
    try {
      if (updateOnly && !undo.updateStarted && undo.previous !== null) {
        await deps.writeConfig(cfgPath(scope), undo.previous)
        rollback = 'Restored the previous config without restarting the running daemon'
      } else if (!undo.ours) rollback = await undoFirstInstall(scope)
      else if (undo.previous === null) {
        rollback = 'the previous config could not be read before the write, so it was left as this install wrote it'
      } else rollback = await restorePrevious(scope, undo.previous, undo.was,
        updateOnly ? readDaemonServiceExecutable(deps.platform, undo.previous) : undefined)
    } catch (err) {
      rollback = `the rollback did not finish: ${errText(err)}`
    }
    return { ok: false, failure: { ...result.failure, rollback } }
  }

  async function attemptInstall(scope: DaemonServiceScope, undo: Undo, updateOnly: boolean): Promise<DaemonServiceResult> {
    const refused = scopeRefusal(scope)
    if (refused) return refused

    if (deps.platform === 'linux' && scope === 'user') {
      const env = await deps.run('systemctl', ['--user', 'show-environment'])
      if (env.code !== 0) {
        return fail(
          'userManagerUnavailable',
          'no systemd user manager answered; log in once on this host or install the system-scope unit instead',
          'systemctl --user show-environment',
          env.stderr,
        )
      }
      // With linger off, user services do not start before login; this is a read-only probe and never turns it on.
      if (!(await lingerOn())) {
        return fail(
          'requiresLinger',
          `the user service only starts before login while linger is on: run "loginctl enable-linger ${deps.user}" yourself, then install again`,
          `loginctl show-user ${deps.user} -p Linger --value`,
        )
      }
    }

    const found = await deps.inspectConfig(cfgPath(scope))
    if (found.present && !found.owned) {
      return fail('foreignConfig', `${cfgPath(scope)} was not written by this tool; remove it yourself before installing`)
    }
    const ours = found.present && found.owned
    if (updateOnly && !ours) return fail('notInstalled', 'Only an existing owned service can be updated')
    undo.ours = ours

    // Before changing anything, see the current state: whose job is registered, and the original enable/run state.
    const before = await probe(scope, found)
    const stray = jobRefusal(scope, ours, before)
    if (stray) return { ok: false, failure: stray }
    undo.was = { active: before.active, enabled: before.enabled, registered: before.registered }
    if (updateOnly && (!before.active || !before.enabled)) return fail('serviceInactive', 'The service is stopped or disabled; automatic updates leave that choice unchanged')

    if (deps.platform === 'darwin') {
      // Keep the user's choice to disable; if it cannot be confirmed, do not install either.
      if (before.override === 'disabled') {
        return fail(
          'disabledOverride',
          `launchd has ${DAEMON_SERVICE_LABEL} disabled for this login session, so the daemon would not start; run "launchctl enable ${target()}" yourself, then install again`,
          before.overrideCommand,
          before.overrideStderr,
        )
      }
      if (before.override === 'unknown') {
        return fail(
          'overrideUnreadable',
          `could not read whether launchd has ${DAEMON_SERVICE_LABEL} disabled, so the install cannot promise a login start; check "${before.overrideCommand}" yourself, then install again`,
          before.overrideCommand,
          before.overrideStderr,
        )
      }
    }

    const prepared = await deps.prepareExecutable()
    if (!prepared.args.includes(FOREGROUND_ARG)) {
      return fail(
        'invalidArgv',
        `the service argv must run the daemon in the foreground (${FOREGROUND_ARG}), got ${JSON.stringify(prepared.args)}`,
      )
    }

    const config: DaemonServiceConfig = {
      platform: deps.platform,
      home: deps.home,
      executable: prepared.executable,
      args: prepared.args,
      runtimeDir: deps.runtimeDir,
      stateDir: deps.stateDir,
      path: deps.path,
      ...(deps.user.trim() ? { user: deps.user } : {}),
    }
    let text: string
    try {
      text = deps.platform === 'darwin'
        ? renderDaemonLaunchAgent(config)
        : renderDaemonSystemdUnit(config, scope)
    } catch (err) {
      return fail('invalidConfig', err instanceof Error ? err.message : String(err))
    }

    // Read right before writing, to keep the window between the baseline and the overwrite as small as possible.
    if (ours) {
      undo.previous = await deps.readConfig(cfgPath(scope))
      if (undo.previous === null) return fail('hostError', 'Could not read the previous service config; nothing was changed')
    }
    if (updateOnly) {
      text = replaceDaemonServiceExecutable(deps.platform, undo.previous!, prepared.executable)
      const latest = await probe(scope)
      const refusal = jobRefusal(scope, latest.present && latest.owned, latest)
      if (refusal) return { ok: false, failure: refusal }
      if (!latest.active || !latest.enabled) return fail('serviceInactive', 'The service was stopped or disabled during staging; nothing was changed')
    }
    try {
      await deps.writeConfig(cfgPath(scope), text)
      undo.wrote = true
    } catch (error) {
      undo.wrote = await deps.readConfig(cfgPath(scope)).then((current) => current === text, () => false)
      throw error
    }
    if (updateOnly) {
      try {
        if (!deps.prepareUpdate) throw new DaemonServiceUpdateRefusedError('Service update preparation is unavailable')
        await deps.prepareUpdate()
        undo.updateStarted = true
      } catch (error) {
        undo.updateStarted = !(error instanceof DaemonServiceUpdateRefusedError)
        throw error
      }
    } else undo.handedOver = await deps.handover?.() ?? false
    if (deps.platform === 'darwin') {
      if (before.registered) {
        const out = await step('launchctl', ['bootout', target()])
        if (out) return out
      }
      const bootstrap = await step('launchctl', ['bootstrap', `gui/${deps.uid}`, cfgPath(scope)])
      if (bootstrap) return bootstrap
    } else {
      const reload = await step('systemctl', scoped(scope, ['daemon-reload']))
      if (reload) return reload
      if (!updateOnly) {
        const enable = await step('systemctl', scoped(scope, ['enable', '--now', DAEMON_SERVICE_UNIT_NAME]))
        if (enable) return enable
      }
      // enable --now does not replace an old binary that is already running.
      if (ours) {
        const again = await step('systemctl', scoped(scope, ['restart', DAEMON_SERVICE_UNIT_NAME]))
        if (again) return again
      }
    }

    return confirm(scope, 'install', prepared.executable)
  }

  function uninstall(options: DaemonServiceOptions = {}): Promise<DaemonServiceResult> {
    return guarded(() => attemptUninstall(options))
  }

  async function attemptUninstall(options: DaemonServiceOptions): Promise<DaemonServiceResult> {
    const scope = options.scope ?? 'user'
    const refused = scopeRefusal(scope)
    if (refused) return refused

    const before = await probe(scope)
    if (before.present && !before.owned) {
      return fail('foreignConfig', `${cfgPath(scope)} was not written by this tool; leaving it in place`)
    }
    const stray = jobRefusal(scope, before.present && before.owned, before)
    if (stray) return { ok: false, failure: stray }
    if (!before.present) return { ok: true, status: statusOf(scope, before, 'no service config to remove') }

    if (before.registered) {
      const off = deps.platform === 'darwin'
        ? await step('launchctl', ['bootout', target()])
        : await step('systemctl', scoped(scope, ['disable', '--now', DAEMON_SERVICE_UNIT_NAME]))
      if (off) return off
    }

    // A stop command that exits 0 does not mean it stopped; keep the config when the stop cannot be confirmed.
    const stopped = await probe(scope)
    const lingering = jobRefusal(scope, stopped.present && stopped.owned, stopped)
    if (lingering) return { ok: false, failure: lingering }
    if (stopped.active || stopped.registered) {
      return fail(
        'verifyFailed',
        `the service is still registered after the stop, so ${cfgPath(scope)} was left in place`,
      )
    }

    await deps.removeConfig(cfgPath(scope))
    if (deps.platform === 'linux') {
      const reload = await step('systemctl', scoped(scope, ['daemon-reload']))
      if (reload) return reload
    }

    const after = await probe(scope)
    if (after.present) return fail('verifyFailed', `${cfgPath(scope)} is still in place after the removal`)
    if (after.identity === 'unverified') {
      return fail(
        'unverifiedJob',
        'the config is gone, but the init system would not say whether anything is still registered',
        after.identityCommand,
      )
    }
    if (after.active || after.registered) {
      return fail('verifyFailed', 'the service is still registered with the init system after the stop')
    }
    return {
      ok: true,
      status: statusOf(scope, after, 'the daemon data and any running CLI sessions were left alone'),
    }
  }

  function restart(options: DaemonServiceOptions = {}): Promise<DaemonServiceResult> {
    return guarded(() => attemptRestart(options))
  }

  async function attemptRestart(options: DaemonServiceOptions): Promise<DaemonServiceResult> {
    const scope = options.scope ?? 'user'
    const refused = scopeRefusal(scope)
    if (refused) return refused

    const before = await probe(scope)
    if (before.present && !before.owned) {
      return fail('foreignConfig', `${cfgPath(scope)} was not written by this tool`)
    }
    const stray = jobRefusal(scope, before.present && before.owned, before)
    if (stray) return { ok: false, failure: stray }
    if (!before.present) return fail('notInstalled', `no service is installed at ${cfgPath(scope)}`)

    if (deps.platform === 'darwin') {
      if (before.registered) {
        const stopped = await step('launchctl', ['bootout', target()])
        if (stopped) return stopped
      }
      const started = await step('launchctl', ['bootstrap', `gui/${deps.uid}`, cfgPath(scope)])
      if (started) return started
    } else {
      const restarted = await step('systemctl', scoped(scope, ['restart', DAEMON_SERVICE_UNIT_NAME]))
      if (restarted) return restarted
    }

    return confirm(scope, 'restart')
  }

  async function status(options: DaemonServiceOptions = {}): Promise<DaemonServiceStatus> {
    const scope = options.scope ?? 'user'
    if (deps.platform === 'darwin' && scope === 'system') {
      return {
        platform: deps.platform,
        scope,
        configPath: cfgPath('user'),
        installed: false,
        foreign: false,
        active: false,
        enabled: false,
        startup: 'unavailable',
        detail: 'macOS starts the daemon as a login agent; there is no system scope here',
      }
    }
    return statusOf(scope, await probe(scope))
  }

  return {
    configPath: (scope: DaemonServiceScope = 'user') => cfgPath(scope),
    status,
    install,
    update: (options) => install(options, true),
    uninstall,
    restart,
  }
}
