/**
 * The cron boot backend of `walnut daemon install|update|uninstall|restart|status`
 * (scope `cron`, Linux): the daemon starts at boot from one `@reboot` line in the
 * account's own crontab, which runs the supervisor script
 * (daemon-service-boot-script.ts). No root and no systemd user manager needed.
 *
 * Same contract as the systemd and launchd manager (daemon-service-manager.ts):
 * a config Walnut did not write is never touched, every step is verified after
 * it ran (a 0 exit is a request accepted, not a fact), a failed install puts
 * back what was there, and stopping the daemon never stops its CLI sessions.
 * The supervisor is to this backend what systemd is to a unit: it restarts the
 * daemon, reads the new script on each restart, and stops on the stop file.
 */
import path from 'node:path'
import {
  daemonServiceConfigFiles,
  type DaemonServiceConfig,
} from './daemon-service-config.js'
import {
  CRON_BOOT_PROBE_SCRIPT,
  DAEMON_BOOT_SCRIPT_NAME,
  cronLineState,
  crontabWithDaemonLine,
  crontabWithoutDaemonLine,
  daemonCronLine,
  isNoCrontab,
  parseCronBootProbe,
  readDaemonBootExecutable,
  renderDaemonBootScript,
  replaceDaemonBootExecutable,
  type CronBoot,
  type CronLineState,
} from './daemon-service-boot-script.js'
import {
  DaemonServiceHandoverPendingError,
  DaemonServiceUpdateRefusedError,
  type DaemonServiceCommandResult,
  type DaemonServiceDeps,
  type DaemonServiceErrorCode,
  type DaemonServiceManager,
  type DaemonServiceResult,
  type DaemonServiceStatus,
} from './daemon-service-manager.js'

export interface CronServiceDeps extends Omit<DaemonServiceDeps, 'run' | 'platform'> {
  platform: 'linux' | 'darwin'
  run(program: string, args: string[], input?: string): Promise<DaemonServiceCommandResult>
  /** Start a program in its own session, detached from this process, with a cron-like environment. */
  spawnDetached(program: string, args: string[]): Promise<void>
  /** The live daemon of the runtime dir when its executable is one of this install root's versions. */
  serviceDaemon(): Promise<{ pid: number; executable: string } | null>
  /** The live supervisor: the pid file names a shell running this install root's boot script. */
  supervisor(): Promise<number | null>
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>
  /** Resolves true once `pid` has exited (a zombie counts as exited), false at the timeout. */
  waitGone(pid: number, timeoutMs: number): Promise<boolean>
  /** Put the stop file in place (the supervisor ends at its next look) or take it away. */
  setStop(on: boolean): Promise<void>
}

const FOREGROUND_ARG = '--service'
const DAEMON_STOP_WAIT_MS = 60_000
const SUPERVISOR_STOP_WAIT_MS = 10_000

interface Probe {
  present: boolean
  owned: boolean
  line: CronLineState | 'unreadable'
  lineStderr?: string
  boot: CronBoot
  daemon: { pid: number; executable: string } | null
  supervisor: number | null
}

interface Undo {
  wrote: boolean
  ours: boolean
  previous: string | null
  handedOver: boolean
  updateStarted: boolean
}

export function createCronDaemonServiceManager(deps: CronServiceDeps): DaemonServiceManager {
  const script = path.join(deps.stateDir, DAEMON_BOOT_SCRIPT_NAME)
  // The systemd units: a daemon with one of them already has a service, and two would race for one runtime dir.
  const units = daemonServiceConfigFiles('linux', deps.home).filter((file) => file !== script)

  const fail = (code: DaemonServiceErrorCode, message: string, command?: string, stderr?: string): DaemonServiceResult => ({
    ok: false,
    failure: { code, message, ...(command ? { command } : {}), ...(stderr ? { stderr } : {}) },
  })
  const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
  const guarded = (attempt: () => Promise<DaemonServiceResult>): Promise<DaemonServiceResult> =>
    attempt().catch((err: unknown) => fail(err instanceof DaemonServiceHandoverPendingError ? 'handoverPending'
      : err instanceof DaemonServiceUpdateRefusedError ? 'updateRefused' : 'hostError', errText(err)))

  function refusal(): DaemonServiceResult | null {
    if (deps.platform !== 'linux') return fail('unsupportedScope', 'the cron boot start is for Linux; macOS starts the daemon as a login agent')
    if (deps.uid === 0 || deps.user === 'root') {
      return fail('missingUser', 'The daemon must run as the original non-root account; root-owned service installation is not supported')
    }
    return null
  }

  async function readCrontab(): Promise<{ text: string } | { failure: DaemonServiceResult }> {
    const listed = await deps.run('crontab', ['-l'])
    if (listed.code === 0) return { text: listed.stdout }
    if (isNoCrontab(listed.stderr)) return { text: '' }
    return {
      failure: fail('cronUnavailable', `this account cannot use its crontab (crontab -l exited with ${listed.code})`, 'crontab -l', listed.stderr),
    }
  }

  async function writeCrontab(text: string): Promise<DaemonServiceResult | null> {
    const wrote = await deps.run('crontab', ['-'], text)
    return wrote.code === 0 ? null : fail('commandFailed', `crontab - exited with ${wrote.code}`, 'crontab -', wrote.stderr)
  }

  async function cronBoot(): Promise<CronBoot> {
    const probed = await deps.run('/bin/sh', ['-c', CRON_BOOT_PROBE_SCRIPT])
    return probed.code === 0 ? parseCronBootProbe(probed.stdout) : { ok: false, reason: 'could not tell whether a cron daemon starts at boot' }
  }

  async function probe(seen?: { present: boolean; owned: boolean }): Promise<Probe> {
    const found = seen ?? await deps.inspectConfig(script)
    const tab = await deps.run('crontab', ['-l'])
    const line: Probe['line'] = tab.code === 0 ? cronLineState(tab.stdout, script)
      : isNoCrontab(tab.stderr) ? 'none' : 'unreadable'
    return {
      present: found.present,
      owned: found.owned,
      line,
      ...(line === 'unreadable' ? { lineStderr: tab.stderr } : {}),
      boot: await cronBoot(),
      daemon: await deps.serviceDaemon(),
      supervisor: await deps.supervisor(),
    }
  }

  function statusOf(p: Probe, detail?: string): DaemonServiceStatus {
    const installed = p.present && p.owned
    const enabled = installed && p.line === 'ours'
    const active = installed && p.daemon !== null
    const startup = !installed ? 'unavailable' : enabled && p.boot.ok ? 'boot' : 'on-demand'
    const note = detail
      ?? (p.line === 'unreadable' ? 'could not read this account\'s crontab, so a boot start cannot be confirmed'
        : installed && p.line === 'stale' ? 'the crontab line is not the one this build writes; install again to put it right'
          : installed && !enabled ? 'the @reboot line is not in this account\'s crontab, so the daemon will not start at boot'
            : enabled && !p.boot.ok ? `the @reboot line is in place, but ${p.boot.reason}, so it will not run at boot`
              : enabled ? `started at boot by this account's crontab (${p.boot.ok ? p.boot.via : ''})` : undefined)
    return {
      platform: 'linux',
      scope: 'cron',
      configPath: script,
      installed,
      foreign: p.present && !p.owned,
      active,
      enabled,
      startup,
      ...(note ? { detail: note } : {}),
    }
  }

  /** Stop our daemon (never its CLIs: a service-mode daemon leaves them running) and wait for it. */
  async function stopDaemon(timeoutMs = DAEMON_STOP_WAIT_MS): Promise<string | null> {
    const daemon = await deps.serviceDaemon()
    if (!daemon) return null
    await deps.signal(daemon.pid, 'SIGTERM')
    return await deps.waitGone(daemon.pid, timeoutMs) ? null : `the daemon (pid ${daemon.pid}) did not exit within ${Math.round(timeoutMs / 1000)}s`
  }

  async function stopSupervisor(): Promise<string | null> {
    const pid = await deps.supervisor()
    if (!pid) return null
    if (await deps.waitGone(pid, 2_000)) return null
    await deps.signal(pid, 'SIGTERM')
    if (await deps.waitGone(pid, SUPERVISOR_STOP_WAIT_MS)) return null
    await deps.signal(pid, 'SIGKILL')
    return await deps.waitGone(pid, 2_000) ? null : `the boot supervisor (pid ${pid}) did not exit`
  }

  /**
   * Run the script now: the supervisor restarts a daemon that exits, so a live
   * one is asked to exit and comes back from the script as it is on disk; with
   * no supervisor (a first install, or one that gave up), a daemon still running
   * is stopped first and a new supervisor started.
   */
  async function startFromScript(): Promise<string | null> {
    await deps.setStop(false)
    const supervisor = await deps.supervisor()
    if (supervisor) {
      const daemon = await deps.serviceDaemon()
      if (daemon) await deps.signal(daemon.pid, 'SIGTERM')
      return null
    }
    const stuck = await stopDaemon()
    if (stuck) return stuck
    await deps.spawnDetached('/bin/sh', [script])
    return null
  }

  /**
   * An overdue update's restart (daemon-over-busy.ts step 3): SIGTERM, and once its shutdown runs
   * past DAEMON_STOP_WAIT_MS (an older daemon whose session command never settles), SIGKILL to that
   * pid alone, as systemd and launchd do after their stop timeout. A service-mode daemon's CLI
   * sessions are their own process groups, and the next daemon adopts them.
   */
  async function replaceDaemon(): Promise<string | null> {
    await deps.setStop(false)
    const daemon = await deps.serviceDaemon()
    if (daemon) {
      await deps.signal(daemon.pid, 'SIGTERM')
      if (!(await deps.waitGone(daemon.pid, DAEMON_STOP_WAIT_MS))) {
        await deps.signal(daemon.pid, 'SIGKILL')
        if (!(await deps.waitGone(daemon.pid, 5_000))) return `the daemon (pid ${daemon.pid}) did not exit`
      }
    }
    if (!(await deps.supervisor())) await deps.spawnDetached('/bin/sh', [script])
    return null
  }

  async function confirm(phase: 'install' | 'update' | 'restart', expectedExecutable?: string): Promise<DaemonServiceResult> {
    const opened = await probe()
    if (!opened.present || !opened.owned) return fail('verifyFailed', `${script} is not in place after the write`)
    if (!(await deps.ready(statusOf(opened), expectedExecutable))) {
      return fail('notReady', `the daemon never answered ${expectedExecutable ? `as ${expectedExecutable}` : 'as ready'}`)
    }
    const after = await probe()
    if (!after.present || !after.owned) return fail('verifyFailed', `${script} is not in place after the write`)
    if (phase !== 'restart' && after.line !== 'ours') return fail('verifyFailed', 'the @reboot line is not in this account\'s crontab after the write')
    if (!after.daemon) return fail('verifyFailed', 'the daemon is not running from this install after the start')
    if (expectedExecutable && after.daemon.executable !== expectedExecutable) {
      return fail('verifyFailed', `the running daemon is ${after.daemon.executable}, not ${expectedExecutable}`)
    }
    // An update's daemon must stay serving, not only answer once (DaemonServiceDeps.stay).
    const left = phase === 'update' && deps.stay ? await deps.stay(statusOf(after)) : null
    if (left) return fail('verifyFailed', left)
    return { ok: true, status: statusOf(after) }
  }

  async function install(updateOnly: boolean): Promise<DaemonServiceResult> {
    const undo: Undo = { wrote: false, ours: false, previous: null, handedOver: false, updateStarted: false }
    const result = await guarded(() => attemptInstall(undo, updateOnly))
    if (result.ok || !undo.wrote) return result
    // The previous daemon published its sessions for the service and exited: taking the script away would leave
    // them with nobody to adopt them. Keep it, as the systemd manager does, and let the caller install again.
    if (undo.handedOver || result.failure.code === 'handoverPending') {
      return { ok: false, failure: { ...result.failure, rollback: 'Kept the boot script, its @reboot line and the session state because the previous daemon may have exited; retry installation to finish the handover' } }
    }
    let rollback: string
    try {
      rollback = await roll(undo, updateOnly)
    } catch (err) {
      rollback = `the rollback did not finish: ${errText(err)}`
    }
    // The old daemon prepared and exited for the new build: what failed after that is the build's
    // own start (DaemonServiceFailure.stopped), as with systemd and launchd.
    return { ok: false, failure: { ...result.failure, rollback, ...(updateOnly && undo.updateStarted ? { stopped: true } : {}) } }
  }

  async function roll(undo: Undo, updateOnly: boolean): Promise<string> {
    if (undo.ours && undo.previous !== null) {
      await deps.writeConfig(script, undo.previous)
      if (updateOnly && !undo.updateStarted) return 'Restored the previous boot script without restarting the running daemon'
      const restarted = await startFromScript()
      if (restarted) return `put the previous boot script back, but ${restarted}`
      const executable = (() => { try { return readDaemonBootExecutable(undo.previous!) } catch { return undefined } })()
      let back = await confirm('restart', executable)
      // The supervisor gives up after 5 failures in 60 s, and a new daemon that kept failing
      // used them up: with no supervisor left nothing starts the previous one (2026-11-04).
      if (!back.ok && !(await deps.supervisor())) {
        await deps.spawnDetached('/bin/sh', [script])
        back = await confirm('restart', executable)
        if (back.ok) return 'put the previous boot script back and started its supervisor again; the previous daemon is responding'
      }
      return back.ok ? 'put the previous boot script back and the previous daemon is responding'
        : `put the previous boot script back, but the previous daemon did not come back: ${back.failure.message}`
    }
    if (undo.ours) return 'the previous boot script could not be read before the write, so it was left as this install wrote it'
    // A first install: take everything back out, so the host is as it was (and, after a handover, Walnut starts its
    // daemon again the usual way, since no service config is left to stop it).
    const tab = await readCrontab()
    if ('failure' in tab) return 'kept the boot script because the crontab could not be read to take the @reboot line out'
    if (cronLineState(tab.text, script) !== 'none') {
      const wrote = await writeCrontab(crontabWithoutDaemonLine(tab.text, script))
      if (wrote) return `kept the boot script because the @reboot line could not be taken out: ${wrote.ok ? '' : wrote.failure.message}`
    }
    await deps.setStop(true)
    const stuck = (await stopDaemon()) ?? (await stopSupervisor())
    if (stuck) return `took the @reboot line out but kept the boot script, because ${stuck}`
    await deps.removeConfig(script)
    await deps.setStop(false)
    return 'removed the boot script and the @reboot line this install wrote, so no service is registered'
  }

  async function attemptInstall(undo: Undo, updateOnly: boolean): Promise<DaemonServiceResult> {
    const refused = refusal()
    if (refused) return refused
    for (const unit of units) {
      if ((await deps.inspectConfig(unit)).present) {
        return fail('foreignConfig', `${unit} is installed, so the daemon already has a service; walnut will not add a cron start beside it`)
      }
    }
    const tab = await readCrontab()
    if ('failure' in tab) return tab.failure
    const boot = await cronBoot()
    if (!boot.ok && !updateOnly) return fail('cronUnavailable', `cron cannot start the daemon at boot here: ${boot.reason}`)
    const found = await deps.inspectConfig(script)
    if (found.present && !found.owned) return fail('foreignConfig', `${script} was not written by this tool; remove it yourself before installing`)
    const ours = found.present && found.owned
    if (updateOnly && !ours) return fail('notInstalled', 'Only an existing owned service can be updated')
    undo.ours = ours
    const line = cronLineState(tab.text, script)
    if (line === 'foreign') return fail('foreignConfig', 'this account\'s crontab has an Open Walnut line for another boot script; remove it yourself before installing')
    const before = await probe(found)
    if (updateOnly && (!before.daemon || line !== 'ours')) {
      return fail('serviceInactive', 'The service is stopped or its @reboot line is gone; automatic updates leave that choice unchanged')
    }

    const prepared = await deps.prepareExecutable()
    if (!prepared.args.includes(FOREGROUND_ARG)) {
      return fail('invalidArgv', `the service argv must run the daemon in the foreground (${FOREGROUND_ARG}), got ${JSON.stringify(prepared.args)}`)
    }
    // Before the old daemon is asked to stop: a new one that cannot serve never replaces it.
    const unproven = await deps.proveBoot?.(prepared)
    if (unproven) return fail('bootProof', `the new daemon did not start in a trial run, so nothing was changed: ${unproven}`)
    const config: DaemonServiceConfig = {
      platform: 'linux', home: deps.home, executable: prepared.executable, args: prepared.args,
      runtimeDir: deps.runtimeDir, stateDir: deps.stateDir, path: deps.path,
    }
    let text: string
    try {
      text = renderDaemonBootScript(config)
      daemonCronLine(script)
    } catch (err) {
      return fail('invalidConfig', errText(err))
    }
    if (ours) {
      undo.previous = await deps.readConfig(script)
      if (undo.previous === null) return fail('hostError', 'Could not read the previous boot script; nothing was changed')
    }
    if (updateOnly) {
      try { text = replaceDaemonBootExecutable(undo.previous!, prepared.executable) } catch (err) { return fail('invalidConfig', errText(err)) }
      const latest = await probe()
      if (!latest.daemon || latest.line !== 'ours') return fail('serviceInactive', 'The service was stopped during staging; nothing was changed')
    }
    try {
      await deps.writeConfig(script, text)
      undo.wrote = true
    } catch (error) {
      undo.wrote = await deps.readConfig(script).then((current) => current === text, () => false)
      throw error
    }

    if (updateOnly) {
      // The daemon prepares, exits non-zero, and the supervisor reads the new script 5 s later, as systemd restarts a unit.
      let prepared_: void | 'prepared' | 'unprepared'
      try {
        if (!deps.prepareUpdate) throw new DaemonServiceUpdateRefusedError('Service update preparation is unavailable')
        prepared_ = await deps.prepareUpdate()
        undo.updateStarted = true
      } catch (error) {
        undo.updateStarted = !(error instanceof DaemonServiceUpdateRefusedError)
        throw error
      }
      // An overdue update the busy daemon would not prepare for: its own shutdown (SIGTERM) does
      // it, and the supervisor starts the new script (daemon-over-busy.ts).
      if (prepared_ === 'unprepared') {
        const stuck = await replaceDaemon()
        if (stuck) return fail('verifyFailed', `the running daemon could not be replaced: ${stuck}`)
        return confirm('update', prepared.executable)
      }
      if (!(await deps.supervisor())) await deps.spawnDetached('/bin/sh', [script])
      return confirm('update', prepared.executable)
    }

    undo.handedOver = await deps.handover?.() ?? false
    if (line !== 'ours') {
      const wrote = await writeCrontab(crontabWithDaemonLine(tab.text, script))
      if (wrote) return wrote
    }
    const stuck = await startFromScript()
    if (stuck) return fail('verifyFailed', `the running daemon could not be replaced: ${stuck}`)
    return confirm('install', prepared.executable)
  }

  async function uninstall(): Promise<DaemonServiceResult> {
    const refused = refusal()
    if (refused) return refused
    const found = await deps.inspectConfig(script)
    if (found.present && !found.owned) return fail('foreignConfig', `${script} was not written by this tool; leaving it in place`)
    const tab = await readCrontab()
    if ('failure' in tab) return tab.failure
    const line = cronLineState(tab.text, script)
    if (line === 'foreign' && !found.present) return fail('foreignConfig', 'the Open Walnut line in this crontab is for another boot script; leaving it in place')
    // Only lines naming our script go; another install root's tagged line stays.
    const without = crontabWithoutDaemonLine(tab.text, script)
    if (without !== tab.text && line !== 'none') {
      const wrote = await writeCrontab(without)
      if (wrote) return wrote
    }
    if (!found.present) return { ok: true, status: statusOf(await probe(), 'no service config to remove') }
    await deps.setStop(true)
    const stuck = (await stopDaemon()) ?? (await stopSupervisor())
    if (stuck) return fail('verifyFailed', `${stuck}, so ${script} was left in place`)
    await deps.removeConfig(script)
    await deps.setStop(false)
    const after = await probe()
    if (after.present) return fail('verifyFailed', `${script} is still in place after the removal`)
    if (after.line === 'unreadable') return fail('verifyFailed', 'the boot script is gone, but the crontab could not be read back to confirm the @reboot line is out')
    if (after.line !== 'none' && after.line !== 'foreign') return fail('verifyFailed', 'the @reboot line is still in this account\'s crontab')
    return { ok: true, status: statusOf(after, 'the daemon data and any running CLI sessions were left alone') }
  }

  async function restart(): Promise<DaemonServiceResult> {
    const refused = refusal()
    if (refused) return refused
    const found = await deps.inspectConfig(script)
    if (found.present && !found.owned) return fail('foreignConfig', `${script} was not written by this tool`)
    if (!found.present) return fail('notInstalled', `no service is installed at ${script}`)
    const stuck = await startFromScript()
    if (stuck) return fail('verifyFailed', stuck)
    return confirm('restart')
  }

  return {
    configPath: () => script,
    status: async () => statusOf(await probe()),
    install: () => install(false),
    update: () => install(true),
    uninstall: () => guarded(uninstall),
    restart: () => guarded(restart),
  }
}
