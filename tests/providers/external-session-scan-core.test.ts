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
import { describeExternalSessions, scanExternalSessions } from '../../src/providers/external-session-scan-core.js'

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
  it('picks up a terminal-typed session', () => {
    claudeSession({ sid: 'human-1', entrypoint: 'cli', aiTitle: 'Fix login redirect' })

    const { candidates } = scan()
    expect(candidates.map((c) => c.sessionId)).toEqual(['human-1'])
    expect(candidates[0]).toMatchObject({
      engine: 'claude',
      origin: 'cli',
      title: 'Fix login redirect',
      cwd: '/Users/dev/proj',
    })
  })

  it('picks up other SDK apps with a real cwd, but never temp-dir test debris', () => {
    // An SDK-based agent orchestrator records entrypoint 'sdk-cli' — same
    // as Walnut's own spawns. Walnut's own are excluded by knownSessionIds;
    // what separates the rest from ephemeral-server test debris is the cwd.
    claudeSession({ sid: 'sdk-real', entrypoint: 'sdk-cli', cwd: '/Users/dev/agent-orchestrator', firstUserText: 'Investigate ticket 12345' })
    claudeSession({ sid: 'sdk-tmp1', entrypoint: 'sdk-cli', cwd: '/private/tmp' })
    claudeSession({ sid: 'sdk-tmp2', entrypoint: 'sdk-cli', cwd: '/tmp/modetest' })
    claudeSession({ sid: 'sdk-tmp3', entrypoint: 'sdk-cli', cwd: '/private/var/folders/ph/x/T/walnut-test-123/memory' })

    const { candidates } = scan()
    expect(candidates.map((c) => c.sessionId)).toEqual(['sdk-real'])
    expect(candidates[0].origin).toBe('sdk-cli')
    // Regression: the entrypoint check used to stop the walk on ANY non-human
    // entrypoint — including accepted SDK apps — before the first user message
    // was captured, so every SDK import fell back to "Claude session <id>".
    expect(candidates[0].title).toBe('Investigate ticket 12345')
    expect(candidates[0].messageCount).toBe(2)
  })

  it('excludes configured directories for every entrypoint, without matching sibling paths', () => {
    for (const entrypoint of ['cli', 'claude-desktop', 'sdk-cli']) {
      claudeSession({ sid: `probe-${entrypoint}`, entrypoint, cwd: '/Users/dev/probes/run-1' })
    }
    claudeSession({ sid: 'real', entrypoint: 'cli', cwd: '/Users/dev/probes-app' })
    claudeSession({ sid: 'scratch', entrypoint: 'cli', cwd: '/tmp/real-work' })
    codexSession({ id: 'probe-codex', originator: 'codex-tui', cwd: '/Users/dev/probes/run-2' })
    expect(scan({ excludedCwds: ['/Users/dev/probes/'] }).candidates.map(c => c.sessionId).sort())
      .toEqual(['real', 'scratch'])
  })

  it('filters before the candidate limit so excluded probes cannot starve real sessions', () => {
    for (let i = 0; i < 205; i++) {
      claudeSession({ sid: `probe-${i}`, entrypoint: 'cli', cwd: '/Users/dev/probes' })
    }
    claudeSession({ sid: 'real', entrypoint: 'sdk-cli', cwd: '/Users/dev/work', mtimeMs: Date.now() - 10_000 })
    expect(scan({ excludedCwds: ['/Users/dev/probes'], limit: 1 }).candidates.map(c => c.sessionId))
      .toEqual(['real'])
    expect(scan({ excludedCwds: ['/Users/dev/probes'], limit: 1 }).truncated).toBe(false)
  })

  it('still excludes tracked sdk sessions via knownSessionIds (Walnut\'s own)', () => {
    claudeSession({ sid: 'walnut-own', entrypoint: 'sdk-cli', cwd: '/Users/dev/proj' })
    expect(scan({ knownSessionIds: ['walnut-own'] }).candidates).toHaveLength(0)
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
    // A reply, as every importable transcript has (a reply-less one is skipped).
    lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
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

/**
 * Title rule parity with the CLI (sessionStorage: customTitle > aiTitle > the
 * first user line that is neither meta nor a compaction summary). The bug this
 * pins: a compacted session resumed into a fresh transcript starts with the
 * compaction summary as its first user line, and titling by "first user line"
 * produced screens full of "This session is being continued from a previous…".
 */
describe('scanExternalSessions — title rule (CLI parity)', () => {
  const COMPACT = 'This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\nAnalysis: …'
  const user = (text: string, extra: Record<string, unknown> = {}) => ({
    type: 'user', message: { role: 'user', content: text }, uuid: 'u', timestamp: '2026-08-10T10:00:00.000Z',
    cwd: '/Users/dev/proj', sessionId: 'sid', entrypoint: 'cli', isSidechain: false, ...extra,
  })
  const assistant = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, timestamp: '2026-08-10T10:00:05.000Z' }
  const transcript = (sid: string, lines: unknown[]): void =>
    writeJsonl(path.join(home, '.claude', 'projects', '-Users-dev-proj', `${sid}.jsonl`), lines)
  const titleOf = (sid: string): string | undefined => scan().candidates.find((c) => c.sessionId === sid)?.title

  it('skips a flagged compaction summary and titles by the human message after it', () => {
    transcript('cont-1', [user(COMPACT, { isCompactSummary: true }), assistant, user('now fix the flaky test'), assistant])
    expect(titleOf('cont-1')).toBe('now fix the flaky test')
  })

  it('skips the compaction summary by its text when an older CLI left no flag', () => {
    transcript('cont-2', [user(COMPACT), assistant, user('continue with the migration'), assistant])
    expect(titleOf('cont-2')).toBe('continue with the migration')
  })

  it('yields no title when the summary is the only user line (server mints the fallback)', () => {
    transcript('cont-3', [user(COMPACT, { isCompactSummary: true }), assistant])
    expect(titleOf('cont-3')).toBeUndefined()
  })

  it('skips any line that opens with a markup tag, as the CLI does (Walnut envelopes included)', () => {
    transcript('warm-1', [user('<walnut-cache-warmup>This is a cache warm-up from Walnut.</walnut-cache-warmup>'), assistant, user('look at the failing build'), assistant])
    transcript('digest-1', [user('<walnut-side-thread-digest>summary</walnut-side-thread-digest>'), assistant, user('next step please'), assistant])
    transcript('ctx-1', [user('<context_entry> You are an agent</context_entry>'), assistant, user('check the queue'), assistant])
    transcript('only-tag', [user('<walnut-message from="task x">please rebase</walnut-message>'), assistant])
    expect(titleOf('warm-1')).toBe('look at the failing build')
    expect(titleOf('digest-1')).toBe('next step please')
    expect(titleOf('ctx-1')).toBe('check the queue')
    expect(titleOf('only-tag')).toBeUndefined()
  })

  it('skips interrupt markers', () => {
    transcript('int-1', [user('[Request interrupted by user for tool use]'), assistant, user('[Request interrupted by user]'), user('try the other approach'), assistant])
    expect(titleOf('int-1')).toBe('try the other approach')
  })

  it('skips built-in commands even with args, titles a custom one with args as "/name args"', () => {
    transcript('cmd-1', [user('<command-name>/model</command-name>\n<command-args>sonnet</command-args>'), assistant, user('start over'), assistant])
    transcript('cmd-2', [user('<command-name>/clear</command-name>\n<command-args></command-args>'), assistant, user('start over on the parser'), assistant])
    transcript('cmd-3', [user('<command-name>/deploy</command-name>\n<command-args>staging now</command-args>'), assistant])
    expect(titleOf('cmd-1')).toBe('start over')
    expect(titleOf('cmd-2')).toBe('start over on the parser')
    expect(titleOf('cmd-3')).toBe('/deploy staging now')
  })

  it('titles bash-mode input as "! cmd"', () => {
    transcript('bash-1', [user('<bash-input>git status</bash-input>'), assistant])
    expect(titleOf('bash-1')).toBe('! git status')
  })

  it('looks past leading metadata blocks inside one message', () => {
    transcript('ide-1', [{
      type: 'user', uuid: 'u', timestamp: '2026-08-10T10:00:00.000Z', cwd: '/Users/dev/proj', sessionId: 'ide-1', entrypoint: 'cli',
      message: { role: 'user', content: [
        { type: 'text', text: '<ide_opened_file>The user opened src/a.ts</ide_opened_file>' },
        { type: 'image', source: { type: 'base64', data: 'x' } },
        { type: 'text', text: 'why does this throw' },
      ] },
    }, assistant])
    expect(titleOf('ide-1')).toBe('why does this throw')
  })

  it('skips meta user lines exactly like the CLI', () => {
    transcript('meta-1', [user('<injected instruction>', { isMeta: true }), assistant, user('real question here'), assistant])
    expect(titleOf('meta-1')).toBe('real question here')
  })

  it('prefers a /rename custom-title over the ai-title and the first prompt', () => {
    transcript('custom-1', [
      user('first prompt'), assistant,
      { type: 'ai-title', aiTitle: 'AI picked this', sessionId: 'custom-1' },
      { type: 'custom-title', customTitle: 'Human named it', sessionId: 'custom-1' },
    ])
    expect(titleOf('custom-1')).toBe('Human named it')
  })

  it('treats an emptied custom-title as cleared and falls back to the ai-title', () => {
    transcript('custom-2', [
      user('first prompt'), assistant,
      { type: 'custom-title', customTitle: 'Old name', sessionId: 'custom-2' },
      { type: 'ai-title', aiTitle: 'AI picked this', sessionId: 'custom-2' },
      { type: 'custom-title', customTitle: '', sessionId: 'custom-2' },
    ])
    expect(titleOf('custom-2')).toBe('AI picked this')
  })

  it('finds an ai-title that scrolled out of the tail window', () => {
    // 128KB tail: bury the title line under ~300KB of later turns.
    const filler = Array.from({ length: 300 }, (_, i) => ({
      type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] },
      timestamp: `2026-08-10T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
    }))
    transcript('head-title', [user('first prompt'), { type: 'ai-title', aiTitle: 'Early AI title', sessionId: 'head-title' }, ...filler])
    expect(titleOf('head-title')).toBe('Early AI title')
  })

  it('leaves codex titling unchanged (first human message)', () => {
    codexSession({ id: 'cdx-1', originator: 'codex-tui', firstUserText: 'refactor the parser' })
    expect(scan().candidates.find((c) => c.sessionId === 'cdx-1')?.title).toBe('refactor the parser')
  })
})

/**
 * describeExternalSessions: the retitle path for imports whose transcript aged
 * out of the scan window. Looks up exact ids, applies the same title rule, and
 * never classifies (the ids are ones Walnut already owns).
 */
describe('describeExternalSessions — by id, regardless of age', () => {
  const YEAR_AGO = Date.now() - 400 * 24 * 60 * 60 * 1000

  it('finds a claude transcript by id in any project dir even when the scan window misses it', () => {
    claudeSession({ sid: 'old-1', entrypoint: 'cli', firstUserText: 'old but gold', mtimeMs: YEAR_AGO, encodedDir: '-Users-dev-somewhere' })
    expect(scan().candidates.map((c) => c.sessionId)).not.toContain('old-1')
    const { candidates } = describeExternalSessions({ sessionIds: ['old-1', 'missing-9'], homeDir: home })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ sessionId: 'old-1', engine: 'claude', title: 'old but gold', cwd: '/Users/dev/proj' })
  })

  it('applies the CLI title rule (custom-title over the first prompt) and skips sidechains', () => {
    const file = claudeSession({ sid: 'named-1', entrypoint: 'sdk-cli', firstUserText: 'first prompt', mtimeMs: YEAR_AGO })
    fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'Renamed by hand', sessionId: 'named-1' }) + '\n')
    claudeSession({ sid: 'side-1', entrypoint: 'cli', isSidechain: true, mtimeMs: YEAR_AGO })
    const { candidates } = describeExternalSessions({ sessionIds: ['named-1', 'side-1'], homeDir: home })
    expect(candidates.map((c) => c.sessionId)).toEqual(['named-1'])
    expect(candidates[0].title).toBe('Renamed by hand')
  })

  it('finds a codex session by rollout suffix, newest rollout wins', () => {
    codexSession({ id: 'cdx-old', originator: 'codex-tui', firstUserText: 'older rollout', stamp: '2025-01-01T10-00-00', day: '2025/01/01', mtimeMs: YEAR_AGO - 1000 })
    codexSession({ id: 'cdx-old', originator: 'codex-tui', firstUserText: 'newer rollout', stamp: '2025-01-02T10-00-00', day: '2025/01/02', mtimeMs: YEAR_AGO })
    const { candidates } = describeExternalSessions({ sessionIds: ['cdx-old'], homeDir: home })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ sessionId: 'cdx-old', engine: 'codex', title: 'newer rollout' })
  })

  it('answers stat-only activity without parsing, and omits ids with no transcript', () => {
    claudeSession({ sid: 'act-1', entrypoint: 'cli', mtimeMs: YEAR_AGO })
    codexSession({ id: 'act-cdx', originator: 'codex-tui', mtimeMs: YEAR_AGO })
    const { candidates, activity } = describeExternalSessions({ sessionIds: ['act-1', 'act-cdx', 'gone'], activityOnly: true, homeDir: home })
    expect(candidates).toEqual([])
    expect(activity).toEqual(expect.arrayContaining([
      { sessionId: 'act-1', lastActiveAt: new Date(YEAR_AGO).toISOString() },
      { sessionId: 'act-cdx', lastActiveAt: new Date(YEAR_AGO).toISOString() },
    ]))
    expect(activity).toHaveLength(2)
  })

  it('returns nothing for an empty ask or an unreadable home', () => {
    expect(describeExternalSessions({ sessionIds: [], homeDir: home }).candidates).toEqual([])
    expect(describeExternalSessions({ sessionIds: ['x'], homeDir: path.join(home, 'nope') }).candidates).toEqual([])
  })
})

/**
 * Provenance: Walnut's own sessions the server holds no record of (a side-thread
 * fork minted by another Walnut instance on the same host) and probes that never
 * got a reply were imported as outside sessions. Shapes copied from real host
 * transcripts: a fork opens with the queued cache warm-up, then the parent's
 * copied history, whose sends end with the output-mode reminder.
 */
describe('scanExternalSessions — Walnut-driven and reply-less transcripts', () => {
  const PROJ = '/Users/dev/proj'
  const REMINDER = "[Rich output mode is still on — markdown first; add HTML only for colour, diagrams, or layout markdown can't do.]"
  const file = (sid: string) => path.join(home, '.claude', 'projects', '-Users-dev-proj', sid + '.jsonl')
  const user = (sid: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'user', message: { role: 'user', content }, cwd: PROJ, sessionId: sid, entrypoint: 'sdk-cli',
    timestamp: '2026-09-18T17:55:38.049Z', ...extra,
  })
  const reply = (text = 'ok', extra: Record<string, unknown> = {}) => ({
    type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] }, ...extra,
  })

  it('skips a side-thread fork: queued warm-up, copied compaction summary, reminder-wrapped sends', () => {
    writeJsonl(file('fork-1'), [
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'fork-1' },
      { type: 'queue-operation', operation: 'enqueue', sessionId: 'fork-1', content: '<walnut-cache-warmup>This is a cache warm-up. Reply with exactly one word: Ready.' },
      user('fork-1', 'This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true }),
      reply('HLD keeps both designs.'),
      user('fork-1', 'continue\n\n' + REMINDER),
      reply(),
    ])
    expect(scan().candidates).toEqual([])
  })

  it('skips a Walnut-driven session found by the reminder alone, and by the mode switch line', () => {
    writeJsonl(file('rem-1'), [user('rem-1', [{ type: 'text', text: 'fix the flaky test\n\n' + REMINDER }]), reply()])
    writeJsonl(file('edge-1'), [user('edge-1', 'hello\n\n[Rich output mode: ON] Keep writing markdown.'), reply()])
    expect(scan().candidates).toEqual([])
  })

  it('keeps a session whose text merely mentions the markers mid-sentence', () => {
    writeJsonl(file('talk-1'), [
      user('talk-1', 'why does my reply end with [Rich output mode is still on]? and what is <walnut-cache-warmup> for'),
      reply(),
    ])
    expect(scan().candidates.map((c) => c.sessionId)).toEqual(['talk-1'])
  })

  it('keeps a terminal fork of a Walnut session: a person started that work', () => {
    writeJsonl(file('term-fork'), [
      user('term-fork', 'continue\n\n' + REMINDER, { entrypoint: 'cli' }),
      reply(),
      user('term-fork', 'now split the doc in two', { entrypoint: 'cli' }),
      reply(),
    ])
    expect(scan().candidates.map((c) => c.sessionId)).toEqual(['term-fork'])
  })

  it('skips a probe whose only reply is an API error, and one answered by a synthetic stub', () => {
    writeJsonl(file('probe-1'), [
      { type: 'queue-operation', operation: 'enqueue', content: 'Say only Z.' },
      user('probe-1', 'Say only Z.'),
      reply('API Error: 400 capture-only probe', { isApiErrorMessage: true }),
    ])
    writeJsonl(file('stub-1'), [
      user('stub-1', 'ping'),
      { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
    ])
    writeJsonl(file('asked-1'), [user('asked-1', 'still thinking about this one')])
    writeJsonl(file('ok-1'), [user('ok-1', 'Say only Z.'), reply('Z')])
    expect(scan().candidates.map((c) => c.sessionId)).toEqual(['ok-1'])
  })

  it('does not call a transcript reply-less when the head budget could not reach the reply', () => {
    const big = 'x'.repeat(2.5 * 1024 * 1024)
    writeJsonl(file('big-1'), [user('big-1', 'review this log'), user('big-1', big), reply('done')])
    expect(scan().candidates.map((c) => c.sessionId)).toEqual(['big-1'])
  })

  it('describe reports why a known import is not an outside session', () => {
    writeJsonl(file('fork-2'), [
      { type: 'queue-operation', operation: 'enqueue', content: '<walnut-cache-warmup>Reply Ready.' },
      user('fork-2', 'What is a VPC CIDR versus a subnet?'),
      reply(),
    ])
    writeJsonl(file('probe-2'), [user('probe-2', 'Say only Z.'), reply('err', { isApiErrorMessage: true })])
    writeJsonl(file('real-2'), [user('real-2', 'fix the login bug', { entrypoint: 'cli' }), reply()])
    const byId = Object.fromEntries(describeExternalSessions({ sessionIds: ['fork-2', 'probe-2', 'real-2'], homeDir: home })
      .candidates.map((c) => [c.sessionId, c.notExternal]))
    expect(byId).toEqual({ 'fork-2': 'walnut-driven', 'probe-2': 'no-reply', 'real-2': null })
  })

  it('mirrors the markers Walnut actually writes', async () => {
    const { WALNUT_ENVELOPE_MARKERS } = await import('../../src/providers/external-session-scan-core.js')
    const { CACHE_WARMUP_TAG } = await import('../../src/core/sessions/side-thread-warmup.js')
    const { OUTPUT_MODE_INSTRUCTION_MARKER, OUTPUT_MODE_REMINDER_MARKER, RICH_OUTPUT_MODE_REMINDER } =
      await import('../../src/core/sessions/output-mode.js')
    expect(WALNUT_ENVELOPE_MARKERS).toEqual({
      cacheWarmup: CACHE_WARMUP_TAG,
      outputModeInstruction: OUTPUT_MODE_INSTRUCTION_MARKER,
      outputModeReminder: OUTPUT_MODE_REMINDER_MARKER,
    })
    expect(RICH_OUTPUT_MODE_REMINDER).toBe(REMINDER)
  })
})
