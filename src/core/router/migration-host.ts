import { WALNUT_HOME } from '../../constants.js'
import { cronJobRevision } from '../cron/job-revision.js'
import type { CronJob } from '../cron/types.js'
import { findTriggerDaemon, type TriggerDaemon } from '../routines/trigger-daemon.js'
import { RouterMigrationError, type WatcherSnapshot } from './migration-model.js'

export const LEGACY_SNAPSHOT_CAPABILITY = 'trigger-state-snapshot-v1'
const DEADLINE_MS = 5000

type SnapshotDaemon = TriggerDaemon & { pushTriggersNow?: () => Promise<void> }
export interface MigrationHostDeps {
  job(id: string): Promise<CronJob | null>
  daemon(host: string): Promise<SnapshotDaemon | null>
}

const defaults: MigrationHostDeps = {
  async job(id) {
    const { getCronService } = await import('../../web/routes/cron.js')
    const service = getCronService()
    if (!service) throw new RouterMigrationError('routines_unavailable', 'The routines engine is not running here.', 503)
    return (await service.list({ includeDisabled: true, recompute: false })).find((one) => one.id === id) ?? null
  },
  daemon: findTriggerDaemon,
}

async function deadline<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RouterMigrationError('deadline', 'The watcher host did not answer within five seconds.', 504)), DEADLINE_MS)
    })])
  } finally { clearTimeout(timer) }
}

function localHome(home: string, deps: MigrationHostDeps): void {
  if (deps === defaults && home !== WALNUT_HOME) {
    throw new RouterMigrationError('invalid', 'The migration must use this server\'s own data home.', 400)
  }
}

export async function ensureLegacySnapshotHost(id: string, home = WALNUT_HOME, deps: MigrationHostDeps = defaults): Promise<{ job: CronJob; daemon: SnapshotDaemon }> {
  localHome(home, deps)
  return deadline(async () => {
    const job = await deps.job(id)
    if (!job?.check) throw new RouterMigrationError('watcher_state_unsupported', 'This routine has no host polling state to preserve.', 501)
    const daemon = await deps.daemon(job.check.host || '__local__')
    if (!daemon || !daemon.hasCapability(LEGACY_SNAPSHOT_CAPABILITY) || typeof daemon.pushTriggersNow !== 'function') {
      throw new RouterMigrationError('watcher_state_unsupported', 'The watcher host cannot prove a complete paused state. Nothing was paused.', 501)
    }
    return { job, daemon }
  })
}

export async function snapshotLegacyWatcher(id: string, home = WALNUT_HOME, deps: MigrationHostDeps = defaults): Promise<WatcherSnapshot> {
  try {
    const { job, daemon } = await ensureLegacySnapshotHost(id, home, deps)
    if (job.enabled) return { supported: false, reason: 'The watcher is still enabled.' }
    const revision = cronJobRevision(job)
    return await deadline(async () => {
      await daemon.pushTriggersNow!()
      const reply = await daemon.send('triggers.state.snapshot', { home, triggerId: id }, DEADLINE_MS)
      if (reply.ok !== true || reply.supported !== true || reply.complete !== true || reply.frozen !== true
        || reply.state === undefined || reply.state === null || typeof reply.seenReliableUntil !== 'number'
        || !Number.isFinite(reply.seenReliableUntil)) {
        return { supported: false, reason: typeof reply.reason === 'string' ? reply.reason : 'The watcher host could not prove its paused state.' }
      }
      const fresh = await deps.job(id)
      if (!fresh || fresh.enabled || cronJobRevision(fresh) !== revision) {
        return { supported: false, reason: 'The watcher changed during the host snapshot.' }
      }
      const { state: _runtime, ...config } = fresh
      return { supported: true, complete: true, frozen: true, config, state: reply.state, seenReliableUntil: reply.seenReliableUntil }
    })
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
