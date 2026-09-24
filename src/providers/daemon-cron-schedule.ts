import type { CronRestoreConfig } from './daemon-cron-transcript.js'
import { DEFAULT_CRON_RESTORE_CONFIG } from './daemon-cron-transcript.js'

const FIELD_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const

function parseField(text: string, min: number, max: number): number[] | null {
  const values = new Set<number>()
  const dow = min === 0 && max === 6
  for (const term of text.split(',')) {
    const wildcard = term.match(/^\*(?:\/(\d+))?$/)
    if (wildcard) {
      const step = wildcard[1] ? Number.parseInt(wildcard[1], 10) : 1
      if (step < 1) return null
      for (let n = min; n <= max; n += step) values.add(n)
      continue
    }
    const range = term.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (range) {
      const start = Number.parseInt(range[1], 10)
      const end = Number.parseInt(range[2], 10)
      const step = range[3] ? Number.parseInt(range[3], 10) : 1
      if (start > end || step < 1 || start < min || end > (dow ? 7 : max)) return null
      for (let n = start; n <= end; n += step) values.add(dow && n === 7 ? 0 : n)
      continue
    }
    if (!/^\d+$/.test(term)) return null
    let n = Number.parseInt(term, 10)
    if (dow && n === 7) n = 0
    if (n < min || n > max) return null
    values.add(n)
  }
  return values.size ? [...values].sort((a, b) => a - b) : null
}

export function parseCliCron(text: string): number[][] | null {
  const fields = text.trim().split(/\s+/)
  if (fields.length !== FIELD_BOUNDS.length) return null
  const parsed: number[][] = []
  for (let i = 0; i < fields.length; i++) {
    const [min, max] = FIELD_BOUNDS[i]
    const values = parseField(fields[i], min, max)
    if (!values) return null
    parsed.push(values)
  }
  return parsed
}

// Local calendar increments preserve the CLI's behavior across DST changes.
export function nextCliCronMinute(text: string, after: number): number | null {
  const parsed = parseCliCron(text)
  if (!parsed) return null
  const [minute, hour, day, month, weekday] = parsed.map((values) => new Set(values))
  const everyDay = day.size === 31
  const everyWeekday = weekday.size === 7
  const time = new Date(after)
  time.setSeconds(0, 0)
  time.setMinutes(time.getMinutes() + 1)
  for (let i = 0; i < 527040; i++) {
    if (!month.has(time.getMonth() + 1)) {
      time.setMonth(time.getMonth() + 1, 1)
      time.setHours(0, 0, 0, 0)
      continue
    }
    const dayMatches = everyDay && everyWeekday ? true
      : everyDay ? weekday.has(time.getDay())
        : everyWeekday ? day.has(time.getDate())
          : day.has(time.getDate()) || weekday.has(time.getDay())
    if (!dayMatches) {
      time.setDate(time.getDate() + 1)
      time.setHours(0, 0, 0, 0)
      continue
    }
    if (!hour.has(time.getHours())) {
      time.setHours(time.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!minute.has(time.getMinutes())) {
      time.setMinutes(time.getMinutes() + 1)
      continue
    }
    return time.getTime()
  }
  return null
}

export function cliOneShotTime(cron: string, createdAt: number, id: string, config: CronRestoreConfig): number | null {
  const next = nextCliCronMinute(cron, createdAt)
  if (next === null) return null
  if (new Date(next).getMinutes() % config.oneShotMinuteMod !== 0) return next
  const parsed = Number.parseInt(id.slice(0, 8), 16) / 4294967296
  const fraction = Number.isFinite(parsed) ? parsed : 0
  const early = config.oneShotFloorMs + fraction * (config.oneShotMaxMs - config.oneShotFloorMs)
  return Math.max(next - early, createdAt)
}

export function cliCronRestoreConfig(features: Record<string, unknown>, disabled: boolean): CronRestoreConfig {
  const config: CronRestoreConfig = { ...DEFAULT_CRON_RESTORE_CONFIG, enabled: !disabled && Boolean(features.tengu_kairos_cron ?? true) }
  const raw = features.tengu_kairos_cron_config
  if (!raw || typeof raw !== 'object') return config
  const r = raw as Record<string, unknown>
  const integer = (key: string, min: number, max: number) => typeof r[key] === 'number'
    && Number.isInteger(r[key]) && (r[key] as number) >= min && (r[key] as number) <= max
  if (typeof r.recurringFrac !== 'number' || !(r.recurringFrac >= 0 && r.recurringFrac <= 1)
    || !integer('recurringCapMs', 0, 1800000) || !integer('oneShotMaxMs', 0, 1800000)
    || !integer('oneShotFloorMs', 0, 1800000) || !integer('oneShotMinuteMod', 1, 60)
    || (r.recurringMaxAgeMs !== undefined && !integer('recurringMaxAgeMs', 0, 2592000000))
    || (r.cacheLeadMs !== undefined && !integer('cacheLeadMs', 0, 60000))
    || (r.oneShotFloorMs as number) > (r.oneShotMaxMs as number)) return config
  return {
    enabled: config.enabled,
    recurringMaxAgeMs: r.recurringMaxAgeMs as number | undefined ?? config.recurringMaxAgeMs,
    oneShotMaxMs: r.oneShotMaxMs as number,
    oneShotFloorMs: r.oneShotFloorMs as number,
    oneShotMinuteMod: r.oneShotMinuteMod as number,
  }
}
