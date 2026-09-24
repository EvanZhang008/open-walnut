import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CronSupervisionRecord } from './daemon-cron-supervision.js'

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATES = new Set(['watching', 'restarting', 'checking', 'disabled', 'inactive', 'blocked'])

function isRecord(value: unknown, sid: string): value is CronSupervisionRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as CronSupervisionRecord
  if (r.sid !== sid || !Number.isSafeInteger(r.generation) || r.generation < 1
    || (r.stopRequestId !== undefined && (typeof r.stopRequestId !== 'string' || !SID.test(r.stopRequestId)))
    || typeof r.enabled !== 'boolean' || !STATES.has(r.state)
    || !Array.isArray(r.attempts) || r.attempts.some((v) => !Number.isFinite(v))
    || !(r.retryAt === null || Number.isFinite(r.retryAt))
    || !(r.reason === null || typeof r.reason === 'string') || !Number.isFinite(r.updatedAt)) return false
  if (r.launch !== null) {
    const launch = r.launch
    if (!launch || typeof launch.cwd !== 'string' || !path.isAbsolute(launch.cwd)
      || !Array.isArray(launch.args) || launch.args.length === 0
      || launch.args.some((v) => typeof v !== 'string' || v.includes('\0'))
      || typeof launch.mode !== 'string' || typeof launch.cliVersion !== 'string'
      || !(launch.hooksHash === undefined || launch.hooksHash === null || typeof launch.hooksHash === 'string')) return false
  }
  if (r.process !== null) {
    const process = r.process
    if (!process || !Number.isSafeInteger(process.pid) || process.pid <= 1
      || typeof process.bootId !== 'string' || !process.bootId
      || typeof process.startTime !== 'string' || !process.startTime) return false
  }
  return true
}

export class CronSupervisionStore {
  private readonly records = new Map<string, CronSupervisionRecord>()
  private readonly pending = new Map<string, Promise<unknown>>()
  private loaded = false

  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('Supervision directory must be absolute')
  }

  async load(): Promise<void> {
    if (this.pending.size > 0) throw new Error('Cron supervision writes are still pending')
    this.loaded = false
    const records = new Map<string, CronSupervisionRecord>()
    let names: string[]
    try {
      const stat = await fs.lstat(this.directory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('Cron supervision directory is not private')
      names = await fs.readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      names = []
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const sid = name.slice(0, -5)
      if (!SID.test(sid)) continue
      const target = path.join(this.directory, name)
      const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)
        || (process.getuid && stat.uid !== process.getuid())) throw new Error(`Cron supervision record is not private: ${sid}`)
      const parsed = JSON.parse(await fs.readFile(target, 'utf8'))
      if (parsed?.version !== 1 || !isRecord(parsed.record, sid)) {
        throw new Error(`Invalid cron supervision record: ${sid}`)
      }
      records.set(sid, parsed.record)
    }
    this.records.clear()
    for (const [sid, record] of records) this.records.set(sid, record)
    this.loaded = true
  }

  get(sid: string): CronSupervisionRecord | null {
    if (!this.loaded) throw new Error('Cron supervision store is not loaded')
    const record = this.records.get(sid)
    return record ? structuredClone(record) : null
  }

  list(): CronSupervisionRecord[] {
    if (!this.loaded) throw new Error('Cron supervision store is not loaded')
    return [...this.records.values()].map((record) => structuredClone(record))
  }

  async update(
    sid: string,
    change: (current: CronSupervisionRecord | null) => CronSupervisionRecord | null,
  ): Promise<CronSupervisionRecord | null> {
    if (!this.loaded) throw new Error('Cron supervision store is not loaded')
    if (!SID.test(sid)) throw new Error('Invalid session id')
    const previous = this.pending.get(sid) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      const record = change(this.get(sid))
      if (record === null) return null
      if (!isRecord(record, sid)) throw new Error(`Invalid cron supervision record: ${sid}`)
      try {
        await this.persist(sid, record)
      } catch (error) {
        // If fsync fails after rename, the disk may be ahead of memory, so further automatic writes must stop.
        this.loaded = false
        throw error
      }
      this.records.set(sid, structuredClone(record))
      return structuredClone(record)
    })
    this.pending.set(sid, next)
    try {
      return await next
    } finally {
      if (this.pending.get(sid) === next) this.pending.delete(sid)
    }
  }

  private async persist(sid: string, record: CronSupervisionRecord): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('Cron supervision directory is not private')
    const target = path.join(this.directory, `${sid}.json`)
    const temporary = `${target}.${randomUUID()}.tmp`
    const file = await fs.open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({ version: 1, record }) + '\n')
      await file.sync()
    } finally {
      await file.close()
    }
    await fs.rename(temporary, target)
    const directory = await fs.open(this.directory, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
}
