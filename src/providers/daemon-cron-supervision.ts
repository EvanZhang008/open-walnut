export interface CronLaunchSpec {
  cwd: string
  args: string[]
  mode: string
  cliVersion: string
  hooksHash?: string | null
}

export interface CronProcessIdentity {
  bootId: string
  pid: number
  startTime: string
}

export type CronSupervisionState =
  | 'watching'
  | 'restarting'
  | 'checking'
  | 'disabled'
  | 'inactive'
  | 'blocked'

export interface CronSupervisionRecord {
  sid: string
  generation: number
  stopRequestId?: string
  enabled: boolean
  state: CronSupervisionState
  launch: CronLaunchSpec | null
  process: CronProcessIdentity | null
  attempts: number[]
  retryAt: number | null
  reason: string | null
  updatedAt: number
}

export type CronRecoveryEvidence = {
  process: 'alive' | 'dead' | 'unknown'
  cron: 'active' | 'inactive' | 'unknown'
  schedulerConfirmed?: boolean
}

export type CronRecoveryDecision =
  | { action: 'none'; state: CronSupervisionState; reason: string | null }
  | { action: 'wait'; until: number }
  | { action: 'resume'; generation: number }

export const CRON_RECOVERY_WINDOW_MS = 6 * 60 * 60 * 1000
export const CRON_RECOVERY_BACKOFF_MS = [5_000, 30_000, 120_000] as const

export function createCronSupervision(
  sid: string,
  launch: CronLaunchSpec,
  now: number,
): CronSupervisionRecord {
  return {
    sid, generation: 1, enabled: true, state: 'checking', launch,
    process: null, attempts: [], retryAt: null, reason: null, updatedAt: now,
  }
}

export function disableCronSupervision(
  record: CronSupervisionRecord,
  now: number,
): CronSupervisionRecord {
  return {
    ...record, generation: record.generation + 1, enabled: false,
    state: 'disabled', retryAt: null, reason: 'user-disabled', updatedAt: now,
  }
}

export function enableCronSupervision(
  record: CronSupervisionRecord,
  now: number,
): CronSupervisionRecord {
  return {
    ...record, generation: record.generation + 1, enabled: true,
    state: 'checking', attempts: [], retryAt: null, reason: null, updatedAt: now,
  }
}

export function decideCronRecovery(
  record: CronSupervisionRecord,
  evidence: CronRecoveryEvidence,
  now: number,
): CronRecoveryDecision {
  if (!record.enabled) return { action: 'none', state: 'disabled', reason: 'user-disabled' }
  if (record.state === 'blocked') return { action: 'none', state: 'blocked', reason: record.reason }
  if (evidence.cron === 'inactive') return { action: 'none', state: 'inactive', reason: 'no-active-cron' }
  if (evidence.process === 'alive') {
    return evidence.schedulerConfirmed
      ? { action: 'none', state: 'watching', reason: null }
      : { action: 'none', state: 'checking', reason: 'scheduler-unconfirmed' }
  }
  if (evidence.process === 'unknown' || evidence.cron === 'unknown') {
    return { action: 'none', state: 'checking', reason: 'unknown-evidence' }
  }
  if (!record.launch) return { action: 'none', state: 'blocked', reason: 'missing-launch-spec' }
  const attempts = recentCronRecoveryAttempts(record, now)
  if (attempts.length >= CRON_RECOVERY_BACKOFF_MS.length) {
    return { action: 'none', state: 'blocked', reason: 'retry-budget-exhausted' }
  }
  if (record.retryAt === null) {
    return { action: 'wait', until: now + CRON_RECOVERY_BACKOFF_MS[attempts.length] }
  }
  if (record.retryAt > now) return { action: 'wait', until: record.retryAt }
  return { action: 'resume', generation: record.generation }
}

export function recentCronRecoveryAttempts(record: CronSupervisionRecord, now: number): number[] {
  // A clock moved backwards must not refill the budget; only attempts clearly outside the window are dropped.
  return record.attempts.filter((at) => now - at < CRON_RECOVERY_WINDOW_MS)
}

export function beginCronRecovery(
  record: CronSupervisionRecord,
  generation: number,
  now: number,
): CronSupervisionRecord | null {
  if (!record.enabled || record.generation !== generation || record.state === 'blocked') return null
  const attempts = recentCronRecoveryAttempts(record, now)
  if (attempts.length >= CRON_RECOVERY_BACKOFF_MS.length) return null
  return {
    ...record, state: 'restarting', attempts: [...attempts, now], retryAt: null,
    reason: null, updatedAt: now,
  }
}

export function sameCronProcess(
  expected: CronProcessIdentity,
  actual: CronProcessIdentity | null,
): boolean {
  return expected.pid > 1 && actual !== null && actual.pid > 1
    && expected.bootId !== '' && expected.startTime !== ''
    && expected.bootId === actual.bootId
    && expected.pid === actual.pid
    && expected.startTime === actual.startTime
}

export function buildCronResumeArgs(args: readonly string[], sid: string): string[] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) {
    throw new Error('Invalid session id')
  }
  const withValue = new Set(['--session-id', '--resume', '--resume-session-at', '-r'])
  const flags = new Set(['--fork-session', '--continue', '-c'])
  const retainedValues = new Set([
    '--append-system-prompt', '--system-prompt', '--mcp-config', '--permission-mode',
    '--model', '--effort', '--input-format', '--output-format', '--permission-prompt-tool',
    '--settings', '--setting-sources', '--agent', '--agents', '--debug-file',
    '--allowedTools', '--disallowedTools', '--tools', '--fallback-model',
  ])
  const retainedFlags = new Set([
    '-p', '--print', '--verbose', '--include-partial-messages', '--debug',
    '--allow-dangerously-skip-permissions', '--dangerously-skip-permissions',
    '--strict-mcp-config', '--disable-slash-commands',
  ])
  if (!args[0] || args[0].startsWith('-')) throw new Error('Missing CLI executable')
  const result: string[] = [args[0]]
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    const name = arg.split('=', 1)[0]
    if (retainedValues.has(name)) {
      result.push(arg)
      if (!arg.includes('=')) {
        if (args[i + 1] === undefined) throw new Error(`Missing launch option value: ${arg}`)
        result.push(args[++i])
      }
    } else if (withValue.has(name)) {
      if (!arg.includes('=') && args[i + 1] && !args[i + 1].startsWith('-')) i++
    } else if (retainedFlags.has(arg)) {
      result.push(arg)
    } else if (!flags.has(arg)) {
      throw new Error(`Unsupported cron recovery launch option: ${name}`)
    }
  }
  return [...result, '--resume', sid]
}
