/**
 * One remote host's boot start, kept by its DaemonConnection: probe it a while
 * after each connect (and every few hours while connected), and when nothing
 * starts the daemon at boot, set it up on the host (remote-boot-start.ts says
 * why and how). Never on the Mac, the cloud box, or an ephemeral server; off
 * with automatic host fixes (`WALNUT_HOST_AUTOFIX=0`, `hosts.<name>.autofix:
 * false`) or `WALNUT_DAEMON_BOOT_START=0`. A service config already on the host
 * is the user's (or an earlier setup's) and is never replaced from here.
 */
import { log } from '../logging/index.js'
import {
  bootSetupBlocker, bootSetupDue, bootSetupMarkerCommand, buildBootStartProbeScript, classifyBootStart, parseBootStartProbe,
  type BootStart,
} from './remote-boot-start.js'
import { installRemoteDaemonService, type RemoteDaemonUpdateIo } from './daemon-service-update.js'

export interface BootStartView extends BootStart {
  checkedAt: number
  setup: { running: boolean; error: string | null; at: number } | null
}

export interface BootStartKeeperIo extends RemoteDaemonUpdateIo {
  hostKey: string
  connected(): boolean
  /** Why setting up now would be unsafe or useless (null: go ahead). Checked right before the install. */
  hold(): Promise<string | null>
  /** Why this host must never be set up from here (null: it may). */
  off(): Promise<string | null>
  expectedVersion(): string | null
  localBinary(): Promise<string | null>
  /** The daemon binary of this build already on the host, when there is one. */
  remoteBinary(): Promise<string | null>
  hasCapability(cap: string): boolean
  /** The old daemon handed over and exited: drop the link so the reconnect finds the service. */
  reconnect(): void
}

export const BOOT_CHECK_DELAY_MS = 45_000
export const BOOT_RECHECK_MS = 6 * 3_600_000
const HOLD_RETRY_MS = 2 * 60_000
/** A probe that failed or was cut short is asked again this soon, not at the next connect. */
export const PROBE_RETRY_MS = 10 * 60_000

export class BootStartKeeper {
  private view: BootStartView | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private stopped = false

  constructor(private readonly io: BootStartKeeperIo, private readonly now: () => number = Date.now) {}

  get state(): BootStartView | null { return this.view }

  /** Called at each connect: a connection the pool disconnected and dialled again is kept again. */
  schedule(delayMs = BOOT_CHECK_DELAY_MS): void {
    this.stopped = false
    this.arm(delayMs)
  }

  private arm(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.check().catch((err) => {
        log.session.warn('DaemonConnection: boot start check failed', {
          host: this.io.hostKey, error: err instanceof Error ? err.message : String(err),
        })
        if (this.io.connected()) this.arm(PROBE_RETRY_MS)
      })
    }, delayMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Probe now, and set up when due. One at a time. */
  check(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = null })
    return this.running
  }

  private setSetup(running: boolean, error: string | null): void {
    if (this.view) this.view = { ...this.view, setup: { running, error, at: this.now() } }
  }

  private async probe(): Promise<ReturnType<typeof parseBootStartProbe>> {
    const facts = parseBootStartProbe(await this.io.run(buildBootStartProbeScript(), 15_000))
    if (!facts) return null
    const prior = this.view?.setup ?? null
    this.view = { ...classifyBootStart(facts), checkedAt: this.now(), setup: prior && !prior.running ? prior : null }
    return facts
  }

  private async run(): Promise<void> {
    if (this.stopped || !this.io.connected()) return
    const facts = await this.probe()
    if (!facts) { this.arm(PROBE_RETRY_MS); return }
    this.arm(BOOT_RECHECK_MS)
    const verdict = this.view!
    if (verdict.mode === 'boot') { this.setSetup(false, null); return }
    if (verdict.installed) return
    const off = await this.io.off()
    if (off) { this.setSetup(false, off); return }
    const blocker = bootSetupBlocker(facts)
    if (blocker) { this.setSetup(false, blocker); return }
    const expected = this.io.expectedVersion()
    const binary = await this.io.localBinary()
    if (!expected || !binary) { this.setSetup(false, 'this Walnut has no daemon binary for the host'); return }
    if (!this.io.hasCapability('service-handover-v1')) {
      this.setSetup(false, 'its daemon cannot hand its sessions to a service yet; Walnut sets it up once the daemon is updated')
      return
    }
    if (!bootSetupDue(facts, expected, this.now())) {
      if (facts.attempt?.removed) this.setSetup(false, 'its service was removed there with `walnut daemon uninstall`, so Walnut leaves it off')
      else if (!this.view!.setup?.error) this.setSetup(false, 'the last setup attempt failed; Walnut tries again later')
      return
    }
    const held = await this.io.hold()
    if (held) {
      log.session.info('DaemonConnection: boot start setup waits', { host: this.io.hostKey, reason: held })
      this.arm(HOLD_RETRY_MS)
      return
    }
    await this.install(binary, expected)
  }

  private async install(binary: string, expected: string): Promise<void> {
    const startedAt = this.now()
    this.setSetup(true, null)
    log.session.info('DaemonConnection: setting up the daemon to start after a reboot', { host: this.io.hostKey, expected })
    let result
    try {
      result = await installRemoteDaemonService(binary, expected, this.io, { existing: (await this.io.remoteBinary()) ?? undefined })
    } catch (err) {
      result = { ok: false, message: err instanceof Error ? err.message : String(err), uploaded: true }
    }
    await this.io.run(bootSetupMarkerCommand(expected, startedAt, result.ok), 10_000).catch(() => {})
    if (result.ok) {
      log.session.info('DaemonConnection: the daemon now starts after a reboot', {
        host: this.io.hostKey, scope: result.scope, startup: result.startup, uploaded: result.uploaded, ms: this.now() - startedAt,
      })
      this.setSetup(false, null)
      // The unmanaged daemon handed over and exited; the reconnect adopts the service daemon.
      this.io.reconnect()
      await this.probe().catch(() => null)
      return
    }
    const message = (result.message ?? 'the setup failed').split('\n')[0].slice(0, 400)
    log.session.warn('DaemonConnection: could not set up the daemon to start after a reboot', {
      host: this.io.hostKey, code: result.code, message, uploaded: result.uploaded,
    })
    await this.probe().catch(() => null)
    this.setSetup(false, `Walnut could not set it up: ${message}`)
  }
}
