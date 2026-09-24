/**
 * Regression lock for stream-capture retention (the 15GB tmp/streams pileup,
 * 2026-09-24). Every case runs against its own mkdtemp roots — the sweep must
 * never see the real SESSION_STREAMS_DIR or ~/.claude here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { STREAM_RETENTION_MS, sweepRecoverableStreamFiles } from '../../src/core/stream-retention.js'

let streams: string
let projects: string

beforeEach(() => {
  streams = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-retention-streams-'))
  projects = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-retention-projects-'))
})
afterEach(() => {
  fs.rmSync(streams, { recursive: true, force: true })
  fs.rmSync(projects, { recursive: true, force: true })
})

const DAY = 24 * 3600_000
const NOW = Date.now()

/** Create a stream capture aged `ageMs`, with an optional .err sidecar. */
function capture(name: string, ageMs: number, withErr = false): string {
  const file = path.join(streams, name)
  fs.writeFileSync(file, '{"type":"system"}\n')
  const t = new Date(NOW - ageMs)
  fs.utimesSync(file, t, t)
  if (withErr) fs.writeFileSync(file + '.err', 'stderr tail')
  return file
}

/** Register a canonical transcript under projects/<slug>/<name>. */
function canonical(name: string, slug = '-Users-me-repo'): void {
  const dir = path.join(projects, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), '{"type":"user"}\n')
}

const sweep = (activeIds: ReadonlySet<string> = new Set()) =>
  sweepRecoverableStreamFiles({
    streamsDir: streams,
    claudeProjectsDir: projects,
    activeIds,
    now: NOW,
  })

describe('sweepRecoverableStreamFiles', () => {
  it('deletes an old capture (and its .err sidecar) whose canonical transcript exists', async () => {
    const old = capture('aaa.jsonl', 8 * DAY, true)
    canonical('aaa.jsonl')

    const deleted = await sweep()

    expect(deleted).toEqual([old])
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(old + '.err')).toBe(false)
  })

  it('keeps a capture younger than the retention window even with a canonical copy', async () => {
    const young = capture('bbb.jsonl', 6 * DAY)
    canonical('bbb.jsonl')

    expect(await sweep()).toEqual([])
    expect(fs.existsSync(young)).toBe(true)
    expect(STREAM_RETENTION_MS).toBe(7 * DAY)
  })

  it('keeps an old capture with NO canonical transcript — it is the only copy', async () => {
    const orphan = capture('ccc.jsonl', 400 * DAY)
    const acp = capture('acp-ce4609d8bc830864.acp.jsonl', 400 * DAY)
    const embedded = capture('embedded-ddd.jsonl', 400 * DAY)
    canonical('ddd.jsonl') // canonical for the SESSION, not for the embedded-* capture name

    expect(await sweep()).toEqual([])
    for (const f of [orphan, acp, embedded]) expect(fs.existsSync(f), f).toBe(true)
  })

  it('keeps an old recoverable capture whose session is still active', async () => {
    const live = capture('eee.jsonl', 30 * DAY)
    canonical('eee.jsonl')

    expect(await sweep(new Set(['eee']))).toEqual([])
    expect(fs.existsSync(live)).toBe(true)
  })

  it('never touches non-jsonl entries or orphan sidecars', async () => {
    const pipe = path.join(streams, 'fff.pipe')
    fs.writeFileSync(pipe, '')
    const orphanErr = path.join(streams, 'ggg.jsonl.err')
    fs.writeFileSync(orphanErr, 'stderr tail')
    canonical('fff.jsonl')
    canonical('ggg.jsonl')

    expect(await sweep()).toEqual([])
    expect(fs.existsSync(pipe)).toBe(true)
    expect(fs.existsSync(orphanErr)).toBe(true)
  })

  it('finds canonical transcripts across project slugs and ignores stray files in projects/', async () => {
    fs.writeFileSync(path.join(projects, 'not-a-dir.txt'), 'x')
    const a = capture('hhh.jsonl', 8 * DAY)
    const b = capture('iii.jsonl', 8 * DAY)
    canonical('hhh.jsonl', '-Users-me-alpha')
    canonical('iii.jsonl', '-Users-me-beta')

    const deleted = await sweep()

    expect(deleted.sort()).toEqual([a, b].sort())
  })

  it('is a no-op when the streams dir or the projects dir is missing', async () => {
    const kept = capture('jjj.jsonl', 8 * DAY)
    await expect(sweepRecoverableStreamFiles({
      streamsDir: path.join(streams, 'nope'),
      claudeProjectsDir: projects,
      activeIds: new Set(),
      now: NOW,
    })).resolves.toEqual([])
    await expect(sweepRecoverableStreamFiles({
      streamsDir: streams,
      claudeProjectsDir: path.join(projects, 'nope'),
      activeIds: new Set(),
      now: NOW,
    })).resolves.toEqual([])
    expect(fs.existsSync(kept)).toBe(true)
  })

  it('a custom retentionMs overrides the default window', async () => {
    const f = capture('kkk.jsonl', 2 * DAY)
    canonical('kkk.jsonl')

    const deleted = await sweepRecoverableStreamFiles({
      streamsDir: streams,
      claudeProjectsDir: projects,
      activeIds: new Set(),
      retentionMs: DAY,
      now: NOW,
    })
    expect(deleted).toEqual([f])
  })
})
