/**
 * Pins how the session daemon (daemon-standalone.ts) wires `createCronMetadataTracker`:
 * the wiring is hand-written text in a large file, and text drifts silently, so
 * the call site is asserted as text. The tracker itself is driven by one scripted
 * session life (the values it emits) and by the edge cases below.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CRON_PROMPT_LIMIT, createCronMetadataTracker, type CronMetadataProcess } from '../../src/providers/daemon-cron-metadata.js'
import { cliOneShotTime, nextCliCronMinute } from '../../src/providers/daemon-cron-schedule.js'
import { DEFAULT_CRON_RESTORE_CONFIG } from '../../src/providers/daemon-cron-transcript.js'
import { SESSION_CRON_JOB_LIMIT, SESSION_CRON_PROMPT_LIMIT, type SessionCronMetadata } from '../../src/core/types.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PROC: CronMetadataProcess = { identity: 'process-1', alive: true, version: '2.1.258' }
const AT = Date.UTC(2026, 8, 11, 12)
const CONFIG = { enabled: true, recurringMaxAgeMs: 604_800_000 }
const call = (name: string, input: Record<string, unknown> = {}, id = 'call') => JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
})
const result = (value: unknown, id = 'call', error = false) => JSON.stringify({
  type: 'user', tool_use_result: value,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] },
})

/**
 * One scripted life of a session: two jobs created, a list refresh, a delete, a
 * clock jump past one expiry, a refresh, and a rename. Every branch that touches
 * the tracker's closure state (mutation counter, list serial, next-run cache,
 * entry map keys) is on this path, so a body that lost a helper cannot produce
 * the same value sequence by accident.
 */
function script(make: typeof createCronMetadataTracker): SessionCronMetadata[] {
  let now = AT
  const values: SessionCronMetadata[] = []
  const tracker = make({
    epoch: 'daemon-1', clock: () => now, changed: (value) => values.push(value),
    nextRun: nextCliCronMinute,
    oneShotTime: (cron, createdAt, id) => cliOneShotTime(cron, createdAt, id, DEFAULT_CRON_RESTORE_CONFIG),
    promptLimit: CRON_PROMPT_LIMIT,
  })
  tracker.configure('session', PROC, CONFIG)
  tracker.state('session', PROC, false, true)
  tracker.observe('session', PROC, call('CronCreate', { cron: '0 9 * * *', prompt: 'Daily' }, 'a'))
  tracker.observe('session', PROC, result({ id: 'daily', humanSchedule: 'Every day at 9 AM', recurring: true, durable: false }, 'a'))
  now += 60_000
  tracker.observe('session', PROC, call('CronCreate', { cron: '*/5 * * * *', prompt: 'x'.repeat(CRON_PROMPT_LIMIT + 5) }, 'b'))
  tracker.observe('session', PROC, result({ id: 'often', recurring: true, durable: false }, 'b'))
  tracker.observe('session', PROC, call('CronList', {}, 'c'))
  tracker.observe('session', PROC, result({
    jobs: [
      { id: 'often', cron: '*/5 * * * *', humanSchedule: 'Every 5 minutes', recurring: true, durable: false },
      { id: 'daily', cron: '0 9 * * *', recurring: true, durable: false },
    ],
  }, 'c'))
  tracker.observe('session', PROC, call('CronDelete', { id: 'daily' }, 'd'))
  tracker.observe('session', PROC, result({}, 'd'))
  now += 6 * 60_000
  tracker.refresh()
  now += CONFIG.recurringMaxAgeMs
  tracker.refresh()
  tracker.observe('session', PROC, call('CronCreate', { cron: '30 14 16 9 *', prompt: 'Once' }, 'e'))
  tracker.observe('session', PROC, result({ id: 'once', recurring: false, durable: false }, 'e'))
  tracker.rename('session', 'renamed', PROC)
  tracker.observe('session', PROC, '{"type":"user","tool_use_result":"CronDelete"')
  return [...values, ...tracker.list()]
}

describe('cron metadata tracker', () => {
  it('emits every presence over one scripted session life', () => {
    const emitted = script(createCronMetadataTracker)
    // The scenario has to be doing something, or the checks below mean nothing.
    expect(emitted.length).toBeGreaterThan(6)
    expect(new Set(emitted.map((value) => value.presence))).toEqual(new Set(['active', 'inactive', 'unknown']))
    expect(emitted.some((value) => (value.jobs ?? []).some((job) => job.promptTruncated))).toBe(true)
    expect(emitted.some((value) => value.sessionId === 'renamed')).toBe(true)
  })

  it('is wired into the daemon the way the daemon file spells it', () => {
    const standalone = fs.readFileSync(path.join(REPO, 'src/providers/daemon-standalone.ts'), 'utf-8')
    expect(standalone).toContain('nextRun: nextCliCronMinute,')
    expect(standalone).toContain('promptLimit: CRON_PROMPT_LIMIT,')
    expect(standalone).toContain('oneShotTime: (cron, createdAt, id) => cronMetadataConfig ? cliOneShotTime(cron, createdAt, id, cronMetadataConfig) : null,')
    expect(standalone).toMatch(/setInterval\(\(\) => cronMetadata\.refresh\(\), SESSION_SCAN_INTERVAL_MS\)/)
    expect(standalone).toContain('pendingIds: () => cronMetadata.pendingIds(sid),')
    // The daemon synthesizes an adopt origin for a pre-feature session: the
    // watcher boundary as the offset (so a daemon rolled back to a build without
    // `byTime` still reads the record its own, narrower way), plus the OS process
    // start that switches attribution to time, and the extra stream pass is paid
    // for only when the fold actually saw an armed job.
    expect(standalone).toMatch(/cronMetadataOrigin = \{[\s\S]{0,240}offset: adoptFold\.boundary/)
    expect(standalone).toMatch(/processStartedAtMs\((entry\.pid|pid), entry\.startTime\)/)
    expect(standalone).toMatch(/cronIds[\s\S]{0,20}\)\.length > 0/)
    // A derived origin is re-derived on the next adopt, and a pre-marker record
    // is caught by claiming a start long after the OS says the process began.
    expect(standalone).toMatch(/derived === true/)
    expect(standalone).toMatch(/startedAt > (processStart|cronProcessStart) \+ 5_?000/)
    expect(standalone).toMatch(/derived: true/)
    expect(standalone).toMatch(/byTime/)
    expect(standalone).toMatch(/attributeByTime \? 0 :/)
    expect(standalone).toMatch(/attributeByTime \? 120_?000 : 10_?000/)

    // The refresh cadence, read as a number so 60_000 vs 60000 does not hide a real change.
    const match = /const SESSION_SCAN_INTERVAL_MS = ([0-9_]+)/.exec(standalone)
    expect(Number(match![1].replaceAll('_', ''))).toBe(60_000)
  })

  it('agrees with the core contract on the prompt limit and the job cap', () => {
    expect(CRON_PROMPT_LIMIT).toBe(SESSION_CRON_PROMPT_LIMIT)
    // The tracker hardcodes the cap inside emit(), so assert it by behaviour:
    // 33 confirmed jobs must report exactly SESSION_CRON_JOB_LIMIT of them.
    let now = AT
    const values: SessionCronMetadata[] = []
    const tracker = createCronMetadataTracker({
      epoch: 'daemon-1', clock: () => now, changed: (value) => values.push(value),
      promptLimit: CRON_PROMPT_LIMIT,
    })
    tracker.configure('session', PROC, CONFIG)
    tracker.state('session', PROC, false, true)
    for (let i = 0; i < SESSION_CRON_JOB_LIMIT + 1; i++) {
      const id = `job-${String(i).padStart(2, '0')}`
      tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: id }, id))
      tracker.observe('session', PROC, result({ id, recurring: true, durable: false }, id))
    }
    const value = tracker.list()[0]!
    expect(value.presence).toBe('active')
    expect(value.jobs).toHaveLength(SESSION_CRON_JOB_LIMIT)
    // The cap is a REPORT cap, not an inventory cap: validUntil still covers the
    // 33rd job, which is how a client learns the badge outlives the rows shown.
    expect(value.validUntil).toBe(AT + CONFIG.recurringMaxAgeMs)
    // A prompt at the limit survives whole; one past it is cut and flagged.
    const long = 'y'.repeat(SESSION_CRON_PROMPT_LIMIT + 1)
    tracker.observe('session', PROC, call('CronCreate', { cron: '* * * * *', prompt: long }, 'long'))
    tracker.observe('session', PROC, result({ id: 'job-00', recurring: true, durable: false }, 'long'))
    const updated = tracker.list()[0]!.jobs!.find((job) => job.id === 'job-00')!
    expect(updated.prompt).toHaveLength(SESSION_CRON_PROMPT_LIMIT)
    expect(updated.promptTruncated).toBe(true)
  })
})

describe('cron metadata tracker defaults and degenerate inputs', () => {
  it('falls back to the wall clock when no clock is injected', () => {
    const values: SessionCronMetadata[] = []
    const tracker = createCronMetadataTracker({ epoch: 'daemon-1', changed: (value) => values.push(value) })
    tracker.configure('session', PROC, CONFIG)
    const before = Date.now()
    tracker.state('session', PROC, false, true)
    expect(values.at(-1)?.observedAt).toBeGreaterThanOrEqual(before)
    expect(values.at(-1)?.observedAt).toBeLessThanOrEqual(Date.now())
  })

  it('skips content blocks that are not objects and pairs the remaining ones', () => {
    const values: SessionCronMetadata[] = []
    const tracker = createCronMetadataTracker({ epoch: 'daemon-1', clock: () => AT, changed: (value) => values.push(value) })
    tracker.configure('session', PROC, CONFIG)
    tracker.state('session', PROC, false, true)
    tracker.observe('session', PROC, JSON.stringify({
      type: 'assistant',
      message: { content: [null, 'CronCreate as text', 7, { type: 'tool_use', id: 'call', name: 'CronCreate', input: { cron: '* * * * *' } }] },
    }))
    tracker.observe('session', PROC, JSON.stringify({
      type: 'user', tool_use_result: { id: 'job', recurring: true, durable: false },
      message: { content: [[], { type: 'tool_result', tool_use_id: 'call' }] },
    }))
    expect(values.at(-1)).toMatchObject({ presence: 'active', jobs: [expect.objectContaining({ id: 'job' })] })
  })

  it('treats a replayed process with no known start time as starting at zero', () => {
    const values: SessionCronMetadata[] = []
    const tracker = createCronMetadataTracker({ epoch: 'daemon-1', clock: () => AT, changed: (value) => values.push(value) })
    const adopted: CronMetadataProcess = { identity: 'adopted', alive: true, version: '2.1.258' }
    tracker.configure('session', adopted, CONFIG)
    tracker.replay('session', adopted, true)
    tracker.observe('session', adopted, call('CronCreate', { cron: '* * * * *', prompt: 'Replayed' }), true, 0)
    tracker.observe('session', adopted, result({ id: 'job', recurring: true, durable: false }), true, 100)
    tracker.replay('session', adopted, false)
    // No start offset means the lines count as historical: the job is known but cannot be aged.
    expect(values.at(-1)).toMatchObject({ presence: 'unknown', known: true, source: 'cron', jobs: [] })
  })
})

describe('cron metadata stream reader ranges', () => {
  it('refuses a reversed range and reads nothing from an empty one', async () => {
    const { readCronMetadataStream } = await import('../../src/providers/daemon-cron-metadata.js')
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'cron-stream-'))
    const file = path.join(dir, 'stream.jsonl')
    fs.writeFileSync(file, '{"type":"system"}\n')
    const seen: string[] = []
    await expect(readCronMetadataStream(file, 10, 5, new AbortController().signal, (line) => seen.push(line))).rejects.toThrow('truncated')
    await readCronMetadataStream(file, 0, 0, new AbortController().signal, (line) => seen.push(line))
    expect(seen).toEqual([])
    await readCronMetadataStream(file, 0, 18, new AbortController().signal, (line) => seen.push(line))
    expect(seen).toEqual(['{"type":"system"}'])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('CLI version gate and foreign result shapes', () => {
  const armed = (version: string | undefined) => {
    const proc: CronMetadataProcess = { identity: `p-${version}`, alive: true, version }
    const values: SessionCronMetadata[] = []
    const tracker = createCronMetadataTracker({ epoch: 'daemon-1', clock: () => AT, changed: (value) => values.push(value) })
    tracker.configure('session', proc, CONFIG)
    tracker.state('session', proc, false, true)
    tracker.observe('session', proc, call('CronCreate', { cron: '* * * * *', prompt: 'Loop tick' }))
    tracker.observe('session', proc, result({ id: 'job', humanSchedule: 'Every minute', recurring: true, durable: false }))
    return values.at(-1)!
  }

  // The contract was read off real transcripts from 2.1.224 and 2.1.265 hosts and
  // matches 2.1.258 exactly; a version outside 2.1.x has not been checked.
  it.each(['2.1.224', '2.1.258', '2.1.265', '2.1.299', '2.1.1000'])('reports jobs on verified CLI %s', (version) => {
    expect(armed(version)).toMatchObject({ presence: 'active', jobs: [expect.objectContaining({ id: 'job' })] })
  })

  it.each(['2.1.223', '2.0.999', '2.2.0', '3.0.0', 'dev', '', undefined])('stays unknown on unverified CLI %s', (version) => {
    expect(armed(version)).toMatchObject({ presence: 'unknown', jobs: [] })
  })

  it('accepts a version string that carries a build suffix', () => {
    expect(armed('2.1.265 (Claude Code)')).toMatchObject({ presence: 'active' })
  })

  it('drops to unknown while cron results are unreadable, and recovers on a readable one', () => {
    const proc: CronMetadataProcess = { identity: 'p', alive: true, version: '2.1.265' }
    const values: SessionCronMetadata[] = []
    const tracker = createCronMetadataTracker({ epoch: 'daemon-1', clock: () => AT, changed: (value) => values.push(value) })
    tracker.configure('session', proc, CONFIG)
    tracker.state('session', proc, false, true)
    tracker.observe('session', proc, call('CronCreate', { cron: '* * * * *' }, 'good'))
    tracker.observe('session', proc, result({ id: 'job', recurring: true, durable: false }, 'good'))
    expect(values.at(-1)).toMatchObject({ presence: 'active' })
    // A create whose result no longer names an id: the contract moved under us.
    tracker.observe('session', proc, call('CronCreate', { cron: '* * * * *' }, 'moved'))
    tracker.observe('session', proc, result({ jobId: 'new-shape' }, 'moved'))
    expect(values.at(-1)).toMatchObject({ presence: 'unknown', jobs: [] })
    // A readable create proves the parser and the CLI still agree.
    tracker.observe('session', proc, call('CronCreate', { cron: '* * * * *' }, 'after'))
    tracker.observe('session', proc, result({ id: 'later', recurring: true, durable: false }, 'after'))
    expect(values.at(-1)!.jobs!.map((entry) => entry.id)).toEqual(['job', 'later'])
    // A list whose rows are not an array is the same kind of mismatch.
    tracker.observe('session', proc, call('CronList', {}, 'list-moved'))
    tracker.observe('session', proc, result({ jobs: { '0': { id: 'job' } } }, 'list-moved'))
    expect(values.at(-1)).toMatchObject({ presence: 'unknown', jobs: [] })
    tracker.observe('session', proc, call('CronList', {}, 'list-ok'))
    tracker.observe('session', proc, result({ jobs: [{ id: 'job', cron: '* * * * *', recurring: true, durable: false }] }, 'list-ok'))
    expect(values.at(-1)!.jobs!.map((entry) => entry.id)).toEqual(['job'])
  })

  it('stays unknown for a CLI whose results never become readable', () => {
    const proc: CronMetadataProcess = { identity: 'p', alive: true, version: '2.1.265' }
    const values: SessionCronMetadata[] = []
    const tracker = createCronMetadataTracker({ epoch: 'daemon-1', clock: () => AT, changed: (value) => values.push(value) })
    tracker.configure('session', proc, CONFIG)
    tracker.state('session', proc, false, true)
    for (let i = 0; i < 3; i++) {
      tracker.observe('session', proc, call('CronCreate', { cron: '* * * * *' }, `c${i}`))
      tracker.observe('session', proc, result({ jobId: `new-shape-${i}` }, `c${i}`))
      expect(values.at(-1), `create ${i}`).toMatchObject({ presence: 'unknown', jobs: [] })
    }
  })

  it('does not blame the CLI for a create it refused', () => {
    const proc: CronMetadataProcess = { identity: 'p', alive: true, version: '2.1.265' }
    const values: SessionCronMetadata[] = []
    const tracker = createCronMetadataTracker({ epoch: 'daemon-1', clock: () => AT, changed: (value) => values.push(value) })
    tracker.configure('session', proc, CONFIG)
    tracker.state('session', proc, false, true)
    tracker.observe('session', proc, call('CronCreate', { cron: 'nonsense' }, 'denied'))
    tracker.observe('session', proc, result({ error: 'invalid cron' }, 'denied', true))
    tracker.observe('session', proc, call('CronCreate', { cron: '* * * * *' }, 'ok'))
    tracker.observe('session', proc, result({ id: 'job', recurring: true, durable: false }, 'ok'))
    expect(values.at(-1)).toMatchObject({ presence: 'active', jobs: [expect.objectContaining({ id: 'job' })] })
  })

  it('exposes the open call ids the stream reader needs to pair results', () => {
    const proc: CronMetadataProcess = { identity: 'p', alive: true, version: '2.1.265' }
    const tracker = createCronMetadataTracker({ epoch: 'daemon-1', clock: () => AT, changed: () => {} })
    tracker.configure('session', proc, CONFIG)
    expect(tracker.pendingIds('session')).toEqual([])
    expect(tracker.pendingIds('never-seen')).toEqual([])
    tracker.observe('session', proc, call('CronCreate', { cron: '* * * * *' }, 'toolu_open'))
    expect(tracker.pendingIds('session')).toEqual(['toolu_open'])
    tracker.observe('session', proc, result({ id: 'job', recurring: true, durable: false }, 'toolu_open'))
    expect(tracker.pendingIds('session')).toEqual([])
  })
})

describe('cron metadata stream reader prefilter', () => {
  const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'cron-prefilter-'))

  it('skips lines that cannot carry cron evidence and still pairs a result by its open id', async () => {
    const { readCronMetadataStream } = await import('../../src/providers/daemon-cron-metadata.js')
    const dir = tmp()
    const file = path.join(dir, 'stream.jsonl')
    // A whale line (no cron marker) between the call and its result: the result
    // names only the tool_use_id, so the prefilter must consult the open calls.
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', claude_code_version: '2.1.265' }),
      call('CronCreate', { cron: '* * * * *' }, 'toolu_x'),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_other', content: 'z'.repeat(4096) }] } }),
      result({ id: 'job', recurring: true, durable: false }, 'toolu_x'),
    ]
    fs.writeFileSync(file, lines.join('\n') + '\n')
    const seen: string[] = []
    let open: string[] = []
    await readCronMetadataStream(file, 0, fs.statSync(file).size, new AbortController().signal,
      (line) => { seen.push(line); if (line.includes('tool_use')) open = ['toolu_x'] },
      { pendingIds: () => open })
    expect(seen).toHaveLength(3)
    expect(seen[2]).toContain('toolu_x')
    expect(seen.some((line) => line.includes('toolu_other'))).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('still reports a corrupt line it skipped, and decodes everything without a pending source', async () => {
    const { readCronMetadataStream } = await import('../../src/providers/daemon-cron-metadata.js')
    const dir = tmp()
    const file = path.join(dir, 'stream.jsonl')
    fs.writeFileSync(file, `{"type":"assistant","message":{"content":[]}}\nnot json at all\n`)
    let gaps = 0
    const seen: string[] = []
    await readCronMetadataStream(file, 0, fs.statSync(file).size, new AbortController().signal,
      (line) => seen.push(line), { pendingIds: () => [], onGap: () => { gaps++ } })
    expect(gaps).toBe(1)
    expect(seen).toEqual([])
    // Without pendingIds every line is decoded, exactly as before the prefilter.
    const all: string[] = []
    await readCronMetadataStream(file, 0, fs.statSync(file).size, new AbortController().signal,
      (line) => all.push(line), { onGap: () => {} })
    expect(all).toEqual(['{"type":"assistant","message":{"content":[]}}'])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads a 40MB stream with two cron lines well inside a replay budget', async () => {
    const { readCronMetadataStream } = await import('../../src/providers/daemon-cron-metadata.js')
    const dir = tmp()
    const file = path.join(dir, 'whale.jsonl')
    const filler = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_noise', content: 'q'.repeat(64_000) }] } }) + '\n'
    const handle = fs.openSync(file, 'w')
    fs.writeSync(handle, call('CronCreate', { cron: '* * * * *' }, 'toolu_x') + '\n')
    for (let i = 0; i < 620; i++) fs.writeSync(handle, filler)
    fs.writeSync(handle, result({ id: 'job', recurring: true, durable: false }, 'toolu_x') + '\n')
    fs.closeSync(handle)
    const size = fs.statSync(file).size
    expect(size).toBeGreaterThan(39_000_000)
    const seen: string[] = []
    const started = Date.now()
    await readCronMetadataStream(file, 0, size, AbortSignal.timeout(9_000),
      (line) => seen.push(line), { pendingIds: () => ['toolu_x'] })
    const elapsed = Date.now() - started
    expect(seen).toHaveLength(2)
    // Headroom check, not a benchmark: the old path decoded and JSON.parsed all
    // 40MB, which is what made a 1GB stream miss the 10s replay budget.
    expect(elapsed).toBeLessThan(4_000)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
