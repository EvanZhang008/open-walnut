import { afterEach, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validatePlugin } from '../../packages/plugin-cli/src/manifest.js'
import {
  MAX_JOB_EVERY_MS,
  MIN_JOB_EVERY_MS,
  moduleHasJobs,
  parseEvery,
  parseManifestJobs,
} from '../../src/core/plugin-jobs/manifest.js'

const NAME_RULE = 'a job name is 1 to 40 lowercase letters, digits or dashes'
const RANGE_RULE = '"every" must be between 1m and 7d'

describe('parseEvery', () => {
  it.each([
    ['30s', 30_000],
    ['90s', 90_000],
    ['5m', 300_000],
    ['1h', 3_600_000],
    ['1d', 86_400_000],
    [' 5m ', 300_000],
    ['999999s', 999_999_000],
  ])('%j is %d ms', (raw, ms) => {
    expect(parseEvery(raw)).toBe(ms)
  })

  it.each([
    ['5'],
    ['5x'],
    ['1.5m'],
    [''],
    ['5m10s'],
    ['-5m'],
    ['1234567s'],
    [5],
    [null],
    [undefined],
    [{ every: '5m' }],
  ])('%j is not a period', (raw) => {
    expect(parseEvery(raw)).toBeNull()
  })
})

describe('parseManifestJobs', () => {
  it('a manifest without a jobs block declares no jobs and drops nothing', () => {
    const r = parseManifestJobs(undefined)
    expect(r).toEqual({ dropped: [] })
    expect('jobs' in r).toBe(false)
  })

  it.each([[null], ['poll every 5m'], [42], [true], [[{ every: '5m' }]]])('a jobs block that is %j is dropped whole', (raw) => {
    const r = parseManifestJobs(raw)
    expect(r).toEqual({ dropped: ['"jobs" must be an object of job names'] })
    expect('jobs' in r).toBe(false)
  })

  it('reads every job and long-running job, the period trimmed', () => {
    const r = parseManifestJobs({
      'poll-queue': { every: '5m' },
      worker: { kind: 'long-running' },
      nightly: { kind: 'every', every: ' 1d ' },
    })
    expect(r.dropped).toEqual([])
    expect(r.jobs).toStrictEqual({
      'poll-queue': { kind: 'every', everyMs: 300_000, every: '5m' },
      worker: { kind: 'long-running' },
      nightly: { kind: 'every', everyMs: 86_400_000, every: '1d' },
    })
  })

  it('keeps a period of exactly 1m or 7d and drops one outside that range', () => {
    expect(MIN_JOB_EVERY_MS).toBe(60_000)
    expect(MAX_JOB_EVERY_MS).toBe(7 * 86_400_000)
    const r = parseManifestJobs({
      'at-min': { every: '60s' },
      'at-max': { every: '7d' },
      'at-max-hours': { every: '168h' },
      fast: { every: '30s' },
      'just-fast': { every: '59s' },
      slow: { every: '8d' },
      'just-slow': { every: '169h' },
    })
    expect(Object.keys(r.jobs ?? {})).toEqual(['at-min', 'at-max', 'at-max-hours'])
    expect(r.jobs?.['at-min']).toEqual({ kind: 'every', everyMs: 60_000, every: '60s' })
    expect(r.dropped).toEqual([
      `fast: ${RANGE_RULE}`,
      `just-fast: ${RANGE_RULE}`,
      `slow: ${RANGE_RULE}`,
      `just-slow: ${RANGE_RULE}`,
    ])
  })

  it('drops a job whose name is not lowercase letters, digits and dashes of at most 40', () => {
    const forty = 'a'.repeat(40)
    const fortyOne = 'a'.repeat(41)
    const r = parseManifestJobs({
      Poll: { every: '5m' },
      [fortyOne]: { every: '5m' },
      '-poll': { every: '5m' },
      poll_queue: { every: '5m' },
      '': { every: '5m' },
      [forty]: { every: '5m' },
      '9lives': { every: '5m' },
    })
    expect(Object.keys(r.jobs ?? {})).toEqual([forty, '9lives'])
    expect(r.dropped).toEqual([
      `Poll: ${NAME_RULE}`,
      `${fortyOne}: ${NAME_RULE}`,
      `-poll: ${NAME_RULE}`,
      `poll_queue: ${NAME_RULE}`,
      `: ${NAME_RULE}`,
    ])
  })

  it('drops a long-running job that also gives "every"', () => {
    const r = parseManifestJobs({ worker: { kind: 'long-running', every: '5m' } })
    expect(r).toEqual({ dropped: ['worker: a long-running job has no "every"'] })
  })

  it('drops a job of an unknown kind', () => {
    const r = parseManifestJobs({ nightly: { kind: 'cron', every: '1d' } })
    expect(r).toEqual({ dropped: ['nightly: "kind" is "long-running", or leave it out and give "every"'] })
  })

  it('drops a job that is not an object, or gives no usable period', () => {
    const r = parseManifestJobs({
      text: '5m',
      empty: null,
      list: ['5m'],
      none: {},
      odd: { every: 300 },
    })
    expect(r.dropped).toEqual([
      'text: must be an object',
      'empty: must be an object',
      'list: must be an object',
      'none: "every" must be like "30s", "5m", "1h" or "1d"',
      'odd: "every" must be like "30s", "5m", "1h" or "1d"',
    ])
    expect('jobs' in r).toBe(false)
  })

  it('keeps at most 16 jobs; a dropped entry does not count toward them', () => {
    const raw: Record<string, unknown> = { Broken: { every: '5m' } }
    for (let i = 0; i < 18; i++) raw[`job-${String(i).padStart(2, '0')}`] = { every: '5m' }
    const r = parseManifestJobs(raw)
    expect(Object.keys(r.jobs ?? {})).toHaveLength(16)
    expect(Object.keys(r.jobs ?? {}).at(-1)).toBe('job-15')
    expect(r.dropped).toEqual([`Broken: ${NAME_RULE}`, 'job-16: at most 16 jobs', 'job-17: at most 16 jobs'])
  })

  it('a block whose every entry is dropped has no jobs key at all', () => {
    const r = parseManifestJobs({ Bad: { every: '5m' }, fast: { every: '1s' }, worker: { kind: 'long-running', every: '1h' } })
    expect('jobs' in r).toBe(false)
    expect(r.dropped).toHaveLength(3)
  })
})

describe('moduleHasJobs', () => {
  it.each([
    ['a jobs export of functions', { jobs: { a() {} } }, true],
    ['jobs on the default export', { default: { jobs: { a() {} } } }, true],
    ['one async function among values', { jobs: { a: 1, b: async () => {} } }, true],
    ['a jobs export with no function', { jobs: { a: 1 } }, false],
    ['no jobs export', {}, false],
    ['a null jobs export', { jobs: null }, false],
    ['a null default export', { default: null }, false],
    ['an empty jobs object on the default export', { default: { jobs: {} } }, false],
  ])('%s', (_label, mod, expected) => {
    expect(moduleHasJobs(mod as Record<string, unknown>)).toBe(expected)
  })
})

describe('walnut-plugin validate: jobs', () => {
  const roots: string[] = []
  afterEach(async () => { for (const r of roots.splice(0)) await fsp.rm(r, { recursive: true, force: true }) })
  async function dir(extra: Record<string, unknown>): Promise<string> {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'plugin-jobs-validate-'))
    roots.push(base)
    await fsp.writeFile(path.join(base, 'manifest.json'), JSON.stringify({
      id: 'acme-jobs', name: 'Acme Jobs', version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs', ...extra,
    }))
    return base
  }

  it('accepts the two kinds', async () => {
    expect((await validatePlugin(await dir({ jobs: { worker: { kind: 'long-running' }, sweep: { every: '5m' }, daily: { kind: 'every', every: '1d' } } }))).errors).toEqual([])
  })

  it('reports what the host would drop, the same rules', async () => {
    const r = await validatePlugin(await dir({
      jobs: { Bad: { every: '5m' }, fast: { every: '30s' }, odd: { every: 'often' }, both: { kind: 'long-running', every: '5m' }, cron: { kind: 'cron' }, flat: 5 },
    }))
    expect(r.errors).toEqual([
      'manifest.jobs.Bad: a job name is 1 to 40 lowercase letters, digits or dashes',
      'manifest.jobs.fast.every must be between 1m and 7d',
      'manifest.jobs.odd.every must be like "30s", "5m", "1h" or "1d"',
      'manifest.jobs.both: a long-running job has no "every"',
      'manifest.jobs.cron.kind must be "long-running", or leave it out and give "every"',
      'manifest.jobs.flat must be an object',
    ])
    for (const e of r.errors) {
      const name = /^manifest\.jobs\.([^.:]+)/.exec(e)![1]!
      // The host drops the same jobs.
      expect(Object.keys(parseManifestJobs({ [name]: { Bad: { every: '5m' }, fast: { every: '30s' }, odd: { every: 'often' }, both: { kind: 'long-running', every: '5m' }, cron: { kind: 'cron' }, flat: 5 }[name] }).jobs ?? {})).toEqual([])
    }
  })

  it('needs a server entry, and an object', async () => {
    expect((await validatePlugin(await dir({ server: undefined, jobs: { sweep: { every: '5m' } } }))).errors).toEqual(['manifest.jobs needs a "server" entry: the jobs are exported from it'])
    expect((await validatePlugin(await dir({ jobs: ['sweep'] }))).errors).toEqual(['manifest.jobs must be an object of job names'])
  })
})
