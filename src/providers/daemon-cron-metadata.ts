import fs from 'node:fs'
import type { SessionCronMetadata } from '../core/types.js'

/** Every cron tool name shares this prefix, so one byte scan covers all three. */
const CRON_LINE_MARKER = Buffer.from('"Cron')
/** The init line carries the CLI version the parser gates on. */
const INIT_LINE_MARKER = Buffer.from('"init"')

/**
 * `pendingIds` is what makes the byte prefilter safe: a cron tool_result line
 * names no tool, only the `tool_use_id` it answers, so the reader has to ask the
 * tracker which calls are still open before it may skip a line. Omit it and
 * every line is decoded, as before.
 */
export async function readCronMetadataStream(file: string, start: number, end: number, signal: AbortSignal, observe: (line: string, offset: number) => void, options: { processBoundary?: boolean; expectedEpoch?: string; onGap?: () => void; pendingIds?: () => string[] } = {}): Promise<void> {
  signal.throwIfAborted()
  if (end < start) throw new Error('Cron metadata stream was truncated')
  const handle = await fs.promises.open(file, 'r')
  let stream: fs.ReadStream | undefined
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < end) throw new Error('Cron metadata stream was truncated')
    if (options.expectedEpoch && `${before.dev}:${before.ino}:${Math.floor(before.birthtimeMs)}` !== options.expectedEpoch) {
      throw new Error('Cron metadata stream changed')
    }
    if (end === start) return
    if (start > 0 && !options.processBoundary) {
      const boundary = Buffer.alloc(1)
      await handle.read(boundary, 0, 1, start - 1)
      if (boundary[0] !== 10) throw new Error('Cron metadata cursor is not a line boundary')
    }
    stream = handle.createReadStream({ start, end: end - 1, signal, autoClose: false })
    let parts: Buffer[] = []
    let size = 0
    let skipped = false
    let lineOffset = start
    for await (const chunk of stream) {
      signal.throwIfAborted()
      const bytes = chunk as Buffer
      let offset = 0
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset)
        const part = bytes.subarray(offset, newline === -1 ? bytes.length : newline)
        size += part.length
        if (!skipped && size > 32 * 1024 * 1024) {
          if (!options.onGap) throw new Error('Cron metadata stream line exceeds the tailer limit')
          options.onGap()
          parts = []
          skipped = true
        }
        if (!skipped) parts.push(part)
        if (newline === -1) break
        // Only a line that could carry cron evidence is decoded and parsed: a
        // whale stream is gigabytes of tool output, and stringifying every line
        // to JSON.parse it burned the whole replay budget before reaching the end
        // (a 1GB stream aborted at 10s and the session lost its jobs entirely).
        // One part is the common case (a line inside a single chunk); concat
        // would copy every byte of a whole-stream replay for nothing.
        const raw = skipped ? null : parts.length === 1 ? parts[0] : Buffer.concat(parts, size)
        const relevant = raw !== null && (!options.pendingIds
          || raw.includes(CRON_LINE_MARKER) || raw.includes(INIT_LINE_MARKER)
          || options.pendingIds().some((id) => raw.includes(id)))
        const nextOffset = lineOffset + size + 1
        parts = []
        size = 0
        skipped = false
        if (raw !== null && raw.length > 0) {
          let valid = false
          if (relevant) {
            const line = raw.toString('utf8')
            try {
              const parsed = JSON.parse(line)
              valid = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            } catch {}
            if (valid) observe(line, lineOffset)
          } else {
            // Cheap structural check for the lines we skip, so a torn or corrupt
            // stream is still reported instead of silently passed over.
            let head = 0
            let tail = raw.length - 1
            while (head < raw.length && raw[head] <= 32) head++
            while (tail > head && raw[tail] <= 32) tail--
            valid = head > tail || (raw[head] === 123 && raw[tail] === 125)
          }
          if (!valid) {
            if (options.onGap) options.onGap()
            else throw new Error('Invalid cron metadata stream line')
          }
        }
        lineOffset = nextOffset
        offset = newline + 1
      }
    }
    signal.throwIfAborted()
    if (size) throw new Error('Cron metadata stream ended inside a line')
    const after = await fs.promises.stat(file)
    if (before.dev !== after.dev || before.ino !== after.ino || after.size < end
      || (before.size === after.size && before.mtimeMs !== after.mtimeMs)) throw new Error('Cron metadata stream changed')
  } finally {
    stream?.destroy()
    await handle.close()
  }
}

export interface CronMetadataProcess {
  identity: string
  alive: boolean
  version?: string
  startedAt?: number
  startOffset?: number
  /** Decide a replayed line's owner by its own timestamp against `startedAt`
   *  instead of by `startOffset`. Set for a session this daemon adopted rather
   *  than spawned: there is no recorded spawn offset, but the OS knows when the
   *  live process started and every cron tool line carries a CLI timestamp. */
  attributeByTime?: boolean
}

export interface CronMetadataOrigin {
  identity: string
  offset: number
  startedAt: number
  fresh?: boolean
  /** See CronMetadataProcess.attributeByTime. `offset` stays the adopt boundary
   *  so a daemon rolled back to a build without this field keeps its old,
   *  strictly narrower reading of the same record. */
  byTime?: boolean
  /** This record was DERIVED at adopt, not recorded at spawn, so it is a guess
   *  about a process this daemon never started. Every later generation re-derives
   *  it instead of inheriting it: the first guess must not outlive the evidence it
   *  was made from (an inherited boundary guess is what kept a live session's
   *  badge off even after the daemon learned how to attribute by time). Only a
   *  spawn-time origin, which owns an exact offset, is authoritative. */
  derived?: boolean
}

export interface CronMetadataConfig {
  enabled: boolean
  recurringMaxAgeMs: number
}

/** Mirrors SESSION_CRON_PROMPT_LIMIT in core/types.ts; the daemon bundle cannot
 *  import core/, so tests/providers/daemon-cron-metadata pins the two equal. */
export const CRON_PROMPT_LIMIT = 2000

// The JS daemon twin embeds this function by `toString()`, so its body must
// stay self-contained: no module-scope helpers or imports may be referenced.
export function createCronMetadataTracker(options: {
  epoch: string
  clock?: () => number
  changed(value: SessionCronMetadata): void
  oneShotTime?(cron: string, createdAt: number, id: string): number | null
  /** The CLI's next scheduled minute for `cron` after `after` (host-local calendar). */
  nextRun?(cron: string, after: number): number | null
  /** Callers pass SESSION_CRON_PROMPT_LIMIT; the literal below only guards a bare tracker. */
  promptLimit?: number
}) {
  type Job = {
    until: number | null
    cron: string | null
    schedule: string | null
    prompt: string | null
    promptTruncated: boolean
    recurring: boolean
    durable: boolean
    createdAt: number | null
    /** Cached nextRun result; undefined = not computed yet, null = not computable. */
    next?: number | null
  }
  type Entry = {
    process: CronMetadataProcess
    jobs: Map<string, Job>
    pending: Map<string, { name: string; input: Record<string, unknown>; at: number; historical: boolean; replay: boolean; mutation: number; listSerial: number }>
    mutation: number
    listSerial: number
    lastListApplied: number
    known: boolean
    complete: boolean
    config: CronMetadataConfig | null
    value: SessionCronMetadata | null
    jobsKey: string
    replaying?: boolean
    /** A cron result arrived in a shape this parser does not know. */
    foreignFormat?: boolean
  }
  const entries = new Map<string, Entry>()
  const now = options.clock ?? Date.now
  const promptLimit = options.promptLimit ?? 2000
  let revision = 0
  /**
   * The CLI's cron tool contract, verified unchanged from 2.1.224 through
   * 2.1.265 on real transcripts: CronCreate input {cron, prompt, recurring},
   * result {id, humanSchedule, recurring, durable}; CronDelete input {id};
   * CronList result {jobs:[{id, cron, humanSchedule, prompt, ...}]}.
   * Anything outside 2.1.x stays unknown (no badge) until someone re-checks the
   * shapes on that build and widens this. `foreignFormat` is the second guard:
   * a result that does not match, on any version, drops the session to unknown.
   */
  const versionOk = (version: string | undefined): boolean => {
    const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
    if (!parts) return false
    return parts[1] === '2' && parts[2] === '1' && Number(parts[3]) >= 224
  }
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  // A code-unit cut can split a surrogate pair; the orphaned half is dropped.
  const text = (value: unknown, limit: number): string | null =>
    typeof value === 'string' && value.length > 0 ? value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') : null
  const details = (input: Record<string, unknown> | null, result: Record<string, unknown> | null, previous: Job | undefined): Omit<Job, 'until' | 'createdAt'> => {
    const rawPrompt = typeof result?.prompt === 'string' ? result.prompt : typeof input?.prompt === 'string' ? input.prompt : null
    const prompt = rawPrompt === null ? previous?.prompt ?? null : text(rawPrompt, promptLimit)
    return {
      cron: text(result?.cron, 128) ?? text(input?.cron, 128) ?? previous?.cron ?? null,
      schedule: text(result?.humanSchedule, 200) ?? previous?.schedule ?? null,
      prompt,
      promptTruncated: rawPrompt === null ? previous?.promptTruncated ?? false : rawPrompt.length > promptLimit,
      recurring: typeof result?.recurring === 'boolean' ? result.recurring : previous?.recurring ?? true,
      durable: result?.durable === true,
    }
  }
  // A CLI line's own stamp is the creation time; a replayed line without one
  // only tells us the job existed when the process started.
  const stampOf = (parsed: Record<string, unknown>): number | null => {
    if (typeof parsed.timestamp !== 'string') return null
    const stamp = Date.parse(parsed.timestamp)
    return Number.isFinite(stamp) && stamp > 0 && stamp <= now() + 60_000 ? stamp : null
  }
  const emit = (sid: string, entry: Entry) => {
    const time = now()
    const supported = versionOk(entry.process.version) && !entry.foreignFormat
    const jobs = [...entry.jobs]
    const active = !entry.replaying && supported && entry.process.alive
      ? jobs.filter(([, job]) => job.until === null || job.until > time) : []
    const presence = active.length ? 'active'
      : entry.replaying || jobs.length || !supported || !entry.complete ? 'unknown' : 'inactive'
    const source = jobs.length ? 'cron' : null
    const validUntil = active.some(([, job]) => job.until === null) ? null
      : active.length ? Math.max(...active.map(([, job]) => job.until!)) : null
    // Ids outside the wire contract (normalizeSessionCronJobs: 1..64 chars) still
    // count for presence but are not reported, so one odd row cannot drop the
    // details of every other job. The cap keeps the 32 soonest runs.
    const reported = active.filter(([id]) => id.length > 0 && id.length <= 64).map(([id, job]) => {
      // Recomputed only once the cached minute has passed: the CLI rule walks
      // the calendar minute by minute, and emit runs on every observation.
      if (job.cron && options.nextRun && (job.next === undefined || (job.next !== null && job.next <= time))) {
        job.next = options.nextRun(job.cron, time)
      }
      return {
        id, cron: job.cron, schedule: job.schedule, prompt: job.prompt, promptTruncated: job.promptTruncated,
        recurring: job.recurring, durable: job.durable, createdAt: job.createdAt,
        nextRunAt: job.next ?? null,
        expiresAt: job.until !== null && job.until > 0 ? job.until : null,
      }
    }).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 32)
    const jobsKey = JSON.stringify(reported)
    const old = entry.value
    if (old && old.presence === presence && old.source === source && old.known === entry.known
      && old.validUntil === validUntil && old.stale === !entry.process.alive && entry.jobsKey === jobsKey) return old
    entry.jobsKey = jobsKey
    entry.value = {
      sessionId: sid, epoch: options.epoch, revision: ++revision, presence, source,
      known: entry.known, stale: !entry.process.alive, observedAt: time, validUntil, jobs: reported,
    }
    options.changed(entry.value)
    return entry.value
  }
  const ensure = (sid: string, process: CronMetadataProcess) => {
    let entry = entries.get(sid)
    if (!entry || entry.process.identity !== process.identity) {
      const known = entry?.known ?? false
      entry = { process, jobs: new Map(), pending: new Map(), mutation: 0, listSerial: 0, lastListApplied: 0, known, complete: false, config: null, value: null, jobsKey: '' }
      entries.set(sid, entry)
    }
    entry.process = { ...process, version: process.version ?? entry.process.version }
    return entry
  }
  return {
    replay(sid: string, process: CronMetadataProcess, loading: boolean, failed = false) {
      const entry = ensure(sid, process)
      entry.replaying = loading
      if (failed) {
        entry.jobs.clear()
        entry.pending.clear()
        entry.complete = false
      }
      return emit(sid, entry)
    },
    configure(sid: string, process: CronMetadataProcess, config: CronMetadataConfig | null) {
      const entry = ensure(sid, process)
      if (entry.config === config && entry.value && entry.value.stale === !process.alive) return entry.value
      entry.config = config
      return emit(sid, entry)
    },
    observe(sid: string, process: CronMetadataProcess, raw: string, replay = false, offset?: number) {
      const entry = ensure(sid, process)
      const relatedResult = entry.pending.size > 0 && raw.includes('tool_result')
        && [...entry.pending.keys()].some((id) => raw.includes(JSON.stringify(id)))
      if (!relatedResult && !/CronCreate|CronDelete|CronList|"init"/.test(raw)) return
      let parsed: Record<string, unknown> | null
      try { parsed = object(JSON.parse(raw)) } catch {
        entry.jobs.clear()
        entry.pending.clear()
        entry.complete = false
        return emit(sid, entry)
      }
      if (!parsed || parsed.parent_tool_use_id || parsed.isSidechain === true) return
      const stamp = stampOf(parsed)
      // Two ways to tell whether a REPLAYED line is the live process's own work.
      // A session this daemon spawned recorded the stream size at spawn, so the
      // byte offset decides. A session it merely adopted has no such offset, so
      // the CLI's own stamp decides against the OS process start: a line written
      // before the process existed cannot be its work, and an unstamped line
      // (every `init`) stays history rather than guessing.
      const currentProcess = !replay || (process.attributeByTime
        ? stamp !== null && process.startedAt !== undefined && stamp >= process.startedAt
        : process.startOffset !== undefined && offset !== undefined && offset >= process.startOffset)
      if (currentProcess && parsed.type === 'system' && parsed.subtype === 'init' && typeof parsed.claude_code_version === 'string') {
        entry.process = { ...process, version: parsed.claude_code_version }
        return emit(sid, entry)
      }
      const message = object(parsed.message)
      const blocks = Array.isArray(message?.content) ? message.content : []
      for (const rawBlock of blocks) {
        const block = object(rawBlock)
        if (!block) continue
        if (parsed.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string'
          && ['CronCreate', 'CronDelete', 'CronList'].includes(String(block.name))) {
          const input = object(block.input)
          if (input) {
            entry.pending.set(block.id, {
              name: String(block.name), input: { id: input.id, cron: input.cron, prompt: input.prompt },
              at: replay ? process.startedAt ?? 0 : now(),
              historical: !currentProcess, replay, mutation: entry.mutation,
              listSerial: block.name === 'CronList' ? ++entry.listSerial : 0,
            })
          }
        }
        if (parsed.type !== 'user' || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const call = entry.pending.get(block.tool_use_id)
        if (!call) continue
        entry.pending.delete(block.tool_use_id)
        if (block.is_error) continue
        const result = object(parsed.tool_use_result)
        const historical = call.historical || !currentProcess
        // A result this parser cannot read means the CLI's cron contract may have
        // moved, so the session answers `unknown` (no badge) rather than guess.
        // The next readable result clears it: a genuinely changed contract never
        // produces one, while a single odd line must not disable the session for
        // good. A delete carries no shape to judge, so it leaves this alone.
        if (result && (call.name === 'CronCreate' || call.name === 'CronList')) {
          entry.foreignFormat = call.name === 'CronCreate'
            ? typeof result.id !== 'string' : !Array.isArray(result.jobs)
        }
        if (call.name === 'CronCreate' && typeof result?.id === 'string') {
          entry.known = true
          const recurring = result.recurring !== false
          const maxAge = entry.config?.recurringMaxAgeMs
          const at = stamp ?? call.at
          const oneShot = (stamp !== null || !call.replay) && !recurring && typeof call.input.cron === 'string'
            ? options.oneShotTime?.(call.input.cron, at, result.id) : null
          // A process start is only a lower bound for an unstamped creation time.
          const until = historical || result.durable === true || at <= 0 ? 0 : recurring && maxAge === 0 ? null
            : recurring && typeof maxAge === 'number' ? at + maxAge : oneShot ?? 0
          const createdAt = historical || at <= 0 || (call.replay && stamp === null) ? null : at
          // The flag that aged the job is the flag that gets reported.
          entry.jobs.set(result.id, { until, createdAt, ...details(call.input, result, entry.jobs.get(result.id)), recurring })
          entry.mutation++
        } else if (call.name === 'CronDelete' && typeof call.input.id === 'string') {
          entry.jobs.delete(call.input.id)
          entry.mutation++
        } else if (call.name === 'CronList' && Array.isArray(result?.jobs)) {
          if (call.mutation !== entry.mutation || call.listSerial <= entry.lastListApplied) continue
          const listed = result.jobs.map(object)
          if (listed.some((job) => typeof job?.id !== 'string')) continue
          const next = new Map<string, Job>()
          for (const job of listed) {
            const id = job!.id as string
            const previous = entry.jobs.get(id)
            next.set(id, {
              until: historical || job!.durable === true ? 0 : previous ? previous.until : call.at,
              createdAt: previous?.createdAt ?? null,
              ...details(null, job, previous),
            })
          }
          entry.jobs = next
          entry.lastListApplied = call.listSerial
          entry.complete = !historical
          if (listed.length) entry.known = true
        }
      }
      return emit(sid, entry)
    },
    state(sid: string, process: CronMetadataProcess, known = false, fresh = false) {
      const entry = ensure(sid, process)
      entry.known ||= known
      if (fresh) entry.complete = true
      return emit(sid, entry)
    },
    list() {
      return [...entries].map(([sid, entry]) => emit(sid, entry))
    },
    /** Cron calls still awaiting their result; the stream reader needs these to
     *  know a result line matters before it decides to skip it. */
    pendingIds(sid: string) {
      const entry = entries.get(sid)
      return entry ? [...entry.pending.keys()] : []
    },
    /** Re-evaluates every entry against the clock so a passed run or expiry
     *  is published without waiting for the next CLI line. */
    refresh() {
      for (const [sid, entry] of entries) emit(sid, entry)
    },
    rename(oldSid: string, newSid: string, process: CronMetadataProcess) {
      const previous = entries.get(oldSid)
      if (!previous) return false
      entries.delete(oldSid)
      options.changed({ sessionId: oldSid, epoch: options.epoch, revision: ++revision,
        presence: 'inactive', source: null, known: false, stale: false, observedAt: now(), validUntil: null, jobs: [] })
      const reusable = previous.process.identity === process.identity && !previous.replaying
      if (reusable) {
        previous.value = null
        previous.process = process
        entries.set(newSid, previous)
      }
      const entry = ensure(newSid, process)
      entry.known ||= previous.known
      emit(newSid, entry)
      return reusable
    },
    remove(sid: string) { entries.delete(sid) },
  }
}
