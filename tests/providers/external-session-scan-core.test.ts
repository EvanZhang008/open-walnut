/**
 * External-session scanner tests — the classifier is the risky part: a wrong
 * predicate would sweep Walnut's OWN thousands of sdk-cli transcripts into the
 * import bucket. These tests build real transcript trees on disk (temp HOME)
 * and assert exactly which ones are picked up.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { scanExternalSessions } from '../../src/providers/external-session-scan-core.js'

let home: string

function writeJsonl(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** A claude transcript as the CLI writes it. */
function claudeSession(opts: {
  sid: string
  cwd?: string
  entrypoint: string
  firstUserText?: string
  aiTitle?: string
  isSidechain?: boolean
  encodedDir?: string
  mtimeMs?: number
}): string {
  const cwd = opts.cwd ?? '/Users/dev/proj'
  const dir = opts.encodedDir ?? cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const filePath = path.join(home, '.claude', 'projects', dir, `${opts.sid}.jsonl`)
  const lines: unknown[] = [
    {
      type: 'user',
      message: { role: 'user', content: opts.firstUserText ?? 'fix the login bug' },
      uuid: 'u1',
      timestamp: '2026-08-10T10:00:00.000Z',
      cwd,
      sessionId: opts.sid,
      entrypoint: opts.entrypoint,
      isSidechain: opts.isSidechain ?? false,
    },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: '2026-08-10T10:00:05.000Z' },
  ]
  if (opts.aiTitle) lines.push({ type: 'ai-title', aiTitle: opts.aiTitle, sessionId: opts.sid })
  writeJsonl(filePath, lines)
  if (opts.mtimeMs !== undefined) {
    const t = new Date(opts.mtimeMs)
    fs.utimesSync(filePath, t, t)
  }
  return filePath
}

/** A codex rollout file as the codex CLI writes it. */
function codexSession(opts: {
  id: string
  originator: string
  cwd?: string
  firstUserText?: string
  day?: string
  stamp?: string
  mtimeMs?: number
}): string {
  const day = opts.day ?? '2026/08/10'
  const stamp = opts.stamp ?? '2026-08-10T10-00-00'
  const filePath = path.join(home, '.codex', 'sessions', day, `rollout-${stamp}-${opts.id}.jsonl`)
  const lines: unknown[] = [
    {
      timestamp: '2026-08-10T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        session_id: opts.id,
        id: opts.id,
        timestamp: '2026-08-10T10:00:00.000Z',
        cwd: opts.cwd ?? '/Users/dev/proj',
        originator: opts.originator,
        cli_version: '0.146.1',
      },
    },
    {
      timestamp: '2026-08-10T10:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: opts.firstUserText ?? 'add retry to the uploader' },
    },
    { timestamp: '2026-08-10T10:00:09.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
  ]
  writeJsonl(filePath, lines)
  if (opts.mtimeMs !== undefined) {
    const t = new Date(opts.mtimeMs)
    fs.utimesSync(filePath, t, t)
  }
  return filePath
}

const WINDOW = 30 * 24 * 60 * 60 * 1000
const scan = (over: Partial<Parameters<typeof scanExternalSessions>[0]> = {}) =>
  scanExternalSessions({ sinceMs: WINDOW, homeDir: home, ...over })

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-extscan-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('scanExternalSessions — claude classification', () => {
  it('picks up a terminal-typed session and skips Walnut\'s own sdk-cli spawns', () => {
    claudeSession({ sid: 'human-1', entrypoint: 'cli', aiTitle: 'Fix login redirect' })
    claudeSession({ sid: 'walnut-1', entrypoint: 'sdk-cli' })
    claudeSession({ sid: 'walnut-2', entrypoint: 'sdk-cli' })

    const { candidates } = scan()
    expect(candidates.map((c) => c.sessionId)).toEqual(['human-1'])
    expect(candidates[0]).toMatchObject({
      engine: 'claude',
      origin: 'cli',
      title: 'Fix login redirect',
      cwd: '/Users/dev/proj',
    })
  })

  it('includes the desktop app entrypoint', () => {
    claudeSession({ sid: 'desk-1', entrypoint: 'claude-desktop' })
    expect(scan().candidates.map((c) => c.sessionId)).toEqual(['desk-1'])
  })

  it('skips subagent sidechain transcripts', () => {
    claudeSession({ sid: 'side-1', entrypoint: 'cli', isSidechain: true })
    expect(scan().candidates).toHaveLength(0)
  })

  it('skips ids the server already tracks (never parsed)', () => {
    claudeSession({ sid: 'human-1', entrypoint: 'cli' })
    claudeSession({ sid: 'human-2', entrypoint: 'cli' })
    const { candidates } = scan({ knownSessionIds: ['human-1'] })
    expect(candidates.map((c) => c.sessionId)).toEqual(['human-2'])
  })

  it('honors the time window', () => {
    claudeSession({ sid: 'fresh', entrypoint: 'cli', mtimeMs: Date.now() - 2 * 86400_000 })
    claudeSession({ sid: 'ancient', entrypoint: 'cli', mtimeMs: Date.now() - 200 * 86400_000 })
    expect(scan().candidates.map((c) => c.sessionId)).toEqual(['fresh'])
  })

  it('prefers the CLI ai-title, else falls back to the first user message', () => {
    claudeSession({ sid: 'titled', entrypoint: 'cli', aiTitle: 'Real title', firstUserText: 'raw text' })
    claudeSession({ sid: 'untitled', entrypoint: 'cli', firstUserText: 'raw text here' })
    const byId = new Map(scan().candidates.map((c) => [c.sessionId, c]))
    expect(byId.get('titled')?.title).toBe('Real title')
    expect(byId.get('untitled')?.title).toBe('raw text here')
  })

  it('never titles a session with an injected preamble', () => {
    claudeSession({
      sid: 'pre-1', entrypoint: 'cli',
      firstUserText: '# AGENTS.md instructions for /Users/dev/proj <INSTRUCTIONS> always do X',
    })
    claudeSession({
      sid: 'pre-2', entrypoint: 'cli',
      firstUserText: '<local-command-caveat>Caveat: the messages below were generated…',
    })
    for (const c of scan().candidates) expect(c.title).toBeUndefined()
  })

  it('collapses whitespace and truncates a very long title', () => {
    claudeSession({ sid: 'long-1', entrypoint: 'cli', firstUserText: 'a\nb   c ' + 'x'.repeat(400) })
    const title = scan().candidates[0].title!
    expect(title.startsWith('a b c')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(120)
    expect(title.endsWith('…')).toBe(true)
  })

  it('survives malformed and empty transcripts', () => {
    const bad = path.join(home, '.claude', 'projects', 'dir', 'broken.jsonl')
    fs.mkdirSync(path.dirname(bad), { recursive: true })
    fs.writeFileSync(bad, '{not json\n\n{"type":"user"\n')
    fs.writeFileSync(path.join(home, '.claude', 'projects', 'dir', 'empty.jsonl'), '')
    claudeSession({ sid: 'good', entrypoint: 'cli' })
    expect(scan().candidates.map((c) => c.sessionId)).toEqual(['good'])
  })

  it('returns an empty result when no transcript dirs exist at all', () => {
    expect(scan()).toEqual({ candidates: [], scanned: 0, truncated: false })
  })
})

describe('scanExternalSessions — codex classification', () => {
  it('picks up the TUI/desktop originators and skips Walnut\'s own', () => {
    codexSession({ id: 'cx-tui', originator: 'codex-tui', stamp: '2026-08-10T10-00-00' })
    codexSession({ id: 'cx-desk', originator: 'Codex Desktop', stamp: '2026-08-10T11-00-00' })
    codexSession({ id: 'cx-walnut', originator: 'open-walnut', stamp: '2026-08-10T12-00-00' })
    codexSession({ id: 'cx-exec', originator: 'codex_exec', stamp: '2026-08-10T13-00-00' })

    const ids = scan().candidates.map((c) => c.sessionId).sort()
    expect(ids).toEqual(['cx-desk', 'cx-tui'])
    const tui = scan().candidates.find((c) => c.sessionId === 'cx-tui')!
    expect(tui).toMatchObject({ engine: 'codex', origin: 'codex-tui', title: 'add retry to the uploader' })
  })

  it('dedupes resume rollouts of one session id, keeping the newest file', () => {
    codexSession({
      id: 'cx-1', originator: 'codex-tui', stamp: '2026-08-10T10-00-00',
      firstUserText: 'first run', mtimeMs: Date.now() - 5 * 86400_000,
    })
    codexSession({
      id: 'cx-1', originator: 'codex-tui', stamp: '2026-08-12T10-00-00',
      firstUserText: 'resumed run', mtimeMs: Date.now() - 1 * 86400_000,
    })
    const { candidates } = scan()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].sessionId).toBe('cx-1')
    expect(candidates[0].title).toBe('resumed run')
  })

  it('walks the year/month/day layout', () => {
    codexSession({ id: 'cx-a', originator: 'codex-tui', day: '2026/07/01' })
    codexSession({ id: 'cx-b', originator: 'codex-tui', day: '2026/08/15' })
    expect(scan({ sinceMs: 10 * 365 * 86400_000 }).candidates.map((c) => c.sessionId).sort())
      .toEqual(['cx-a', 'cx-b'])
  })
})

describe('scanExternalSessions — deep-head reads (regression)', () => {
  // Both engines bury the human's first words behind a large synthetic preamble:
  // codex writes its whole system prompt into session_meta (~22KB) and replays
  // AGENTS.md + world_state + turn_context before the first user_message, which
  // on real files lands at byte 86K-155K. A fixed 64KB window found the metadata
  // but never the message, so every codex session imported with no title and a
  // message count of 0. These pin the incremental read.
  it('finds a codex user message that sits past 150KB of preamble', () => {
    const filePath = path.join(home, '.codex', 'sessions', '2026/08/10', 'rollout-2026-08-10T10-00-00-cx-deep.jsonl')
    const bulk = 'y'.repeat(60_000)
    writeJsonl(filePath, [
      {
        timestamp: '2026-08-10T10:00:00.000Z',
        type: 'session_meta',
        payload: { session_id: 'cx-deep', id: 'cx-deep', cwd: '/Users/dev/proj', originator: 'codex-tui', base_instructions: { text: bulk } },
      },
      { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions ' + bulk }] } },
      { type: 'world_state', payload: { blob: bulk } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'the real question' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'answer' } },
    ])
    expect(fs.statSync(filePath).size).toBeGreaterThan(150_000)

    const { candidates } = scan()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ sessionId: 'cx-deep', title: 'the real question', messageCount: 2 })
  })

  it('counts every message in a long claude session, not just the first', () => {
    const lines: unknown[] = [{
      type: 'user', message: { role: 'user', content: 'start the work' },
      timestamp: '2026-08-10T10:00:00.000Z', cwd: '/Users/dev/proj', entrypoint: 'cli', isSidechain: false,
    }]
    for (let i = 0; i < 150; i++) {
      lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'step ' + i + ' ' + 'z'.repeat(500) }] } })
      lines.push({ type: 'user', message: { role: 'user', content: 'next ' + i } })
    }
    writeJsonl(path.join(home, '.claude', 'projects', 'dir', 'long.jsonl'), lines)

    const { candidates } = scan()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].title).toBe('start the work')
    expect(candidates[0].messageCount).toBe(301)
  })

  it('does not lose a value that straddles a read-chunk boundary', () => {
    // Pad past the 128KB chunk size with entries carrying no fields we want, so
    // the ai-title/user-message parse must survive at least one boundary.
    const pad = { type: 'system', message: { role: 'system', content: 'p'.repeat(2000) } }
    const lines: unknown[] = []
    for (let i = 0; i < 80; i++) lines.push(pad)
    lines.push({
      type: 'user', message: { role: 'user', content: 'buried first words' },
      timestamp: '2026-08-10T10:00:00.000Z', cwd: '/Users/dev/proj', entrypoint: 'cli', isSidechain: false,
    })
    writeJsonl(path.join(home, '.claude', 'projects', 'dir', 'straddle.jsonl'), lines)
    expect(fs.statSync(path.join(home, '.claude', 'projects', 'dir', 'straddle.jsonl')).size)
      .toBeGreaterThan(131072)

    const { candidates } = scan()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].title).toBe('buried first words')
    expect(candidates[0].cwd).toBe('/Users/dev/proj')
  })

  it('rejects a Walnut-owned rollout without reading its preamble', () => {
    const filePath = path.join(home, '.codex', 'sessions', '2026/08/10', 'rollout-2026-08-10T10-00-00-cx-own.jsonl')
    writeJsonl(filePath, [
      {
        type: 'session_meta',
        payload: { session_id: 'cx-own', id: 'cx-own', cwd: '/Users/dev/proj', originator: 'open-walnut', base_instructions: { text: 'q'.repeat(80_000) } },
      },
      { type: 'event_msg', payload: { type: 'user_message', message: 'should never be titled' } },
    ])
    expect(scan().candidates).toHaveLength(0)
  })
})

describe('scanExternalSessions — result shape', () => {
  it('sorts newest-first and reports truncation instead of silently dropping', () => {
    for (let i = 0; i < 5; i++) {
      claudeSession({ sid: `s-${i}`, entrypoint: 'cli', mtimeMs: Date.now() - i * 3600_000 })
    }
    const all = scan()
    expect(all.candidates.map((c) => c.sessionId)).toEqual(['s-0', 's-1', 's-2', 's-3', 's-4'])
    expect(all.truncated).toBe(false)

    const capped = scan({ limit: 2 })
    expect(capped.candidates.map((c) => c.sessionId)).toEqual(['s-0', 's-1'])
    expect(capped.truncated).toBe(true)
  })

  it('reports both engines together with counts', () => {
    claudeSession({ sid: 'cl-1', entrypoint: 'cli' })
    codexSession({ id: 'cx-1', originator: 'codex-tui' })
    const res = scan()
    expect(res.candidates.map((c) => c.engine).sort()).toEqual(['claude', 'codex'])
    expect(res.scanned).toBe(2)
    for (const c of res.candidates) {
      expect(c.messageCount).toBeGreaterThan(0)
      expect(typeof c.lastActiveAt).toBe('string')
      expect(c.transcriptPath.startsWith(home)).toBe(true)
    }
  })
})
