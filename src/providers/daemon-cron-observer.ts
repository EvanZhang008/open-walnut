import type { CronObservation } from './daemon-cron-controller.js'
import type { CronLaunchSpec, CronProcessIdentity, CronSupervisionRecord } from './daemon-cron-supervision.js'
import { sameCronProcess } from './daemon-cron-supervision.js'
import { collectCronRestoreFacts, type CronRestoreConfig, type CronTranscriptLine } from './daemon-cron-transcript.js'
import { cliOneShotTime } from './daemon-cron-schedule.js'

export type CronProcessProbe =
  | { status: 'alive'; identity: CronProcessIdentity }
  | { status: 'dead' | 'unknown' }

export interface CronObserverDeps {
  bootId: string
  process(record: CronSupervisionRecord, signal: AbortSignal): Promise<CronProcessProbe>
  cliVersion(launch: CronLaunchSpec, signal: AbortSignal): Promise<string>
  config(signal: AbortSignal): Promise<CronRestoreConfig>
  transcript(record: CronSupervisionRecord, signal: AbortSignal): Promise<CronTranscriptLine[]>
  launchBlocker(launch: CronLaunchSpec, signal: AbortSignal): Promise<string | null>
  clock?: () => number
  timeoutMs?: number
}

const SUPPORTED_CLI_VERSIONS = new Set(['2.1.258'])

export function supportsCronRestore(version: string): boolean {
  return SUPPORTED_CLI_VERSIONS.has(version)
}

export function createCronObserver(deps: CronObserverDeps) {
  return async (record: CronSupervisionRecord): Promise<CronObservation> => {
    const signal = AbortSignal.timeout(deps.timeoutMs ?? 10_000)
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
      let aborted!: () => void
      const deadline = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      })
      try { return await Promise.race([work, deadline]) }
      finally { signal.removeEventListener('abort', aborted) }
    }
    const unknown: CronObservation = { process: 'unknown', cron: 'unknown' }
    if (!record.launch) return { ...unknown, blockedReason: 'missing-launch-spec' }
    if (!deps.bootId) return unknown
    let observation: CronObservation = unknown
    try {
      const probe = await bounded(deps.process(record, signal))
      signal.throwIfAborted()
      if (probe.status === 'unknown') return unknown
      if (probe.status === 'alive') {
        if (probe.identity.bootId !== deps.bootId || !record.process || !sameCronProcess(record.process, probe.identity)) return unknown
        observation = { process: 'alive', cron: 'unknown', identity: probe.identity }
      } else {
        observation = { process: 'dead', cron: 'unknown' }
      }
      const version = probe.status === 'alive'
        ? record.launch.cliVersion : await bounded(deps.cliVersion(record.launch, signal))
      signal.throwIfAborted()
      if (!supportsCronRestore(version)) return { ...observation, blockedReason: 'unsupported-cli-version' }
      const config = await bounded(deps.config(signal))
      signal.throwIfAborted()
      if (!config.enabled) return { ...observation, cron: 'inactive' }
      const lines = await bounded(deps.transcript(record, signal))
      signal.throwIfAborted()
      const facts = collectCronRestoreFacts(lines, config, (deps.clock ?? Date.now)(), cliOneShotTime)
      observation = { ...observation, cron: facts.status }
      if (probe.status === 'dead' && facts.status === 'active') {
        const blockedReason = await bounded(deps.launchBlocker(record.launch, signal))
        signal.throwIfAborted()
        if (blockedReason) return { ...observation, blockedReason }
      }
      return observation
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { ...observation, cron: 'unknown', blockedReason: 'recovery-input-missing' }
      return { ...observation, cron: 'unknown' }
    }
  }
}
