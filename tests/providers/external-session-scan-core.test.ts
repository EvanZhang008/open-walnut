/**
 * External-session scanner tests — the classifier is the risky part: a wrong
 * predicate would sweep Walnut's OWN thousands of sdk-cli transcripts, or every
 * run of a user's own scripts, into the import project. These tests build real
 * transcript trees on disk (temp HOME) and assert exactly which ones are picked
 * up.
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
  /** The CLI's stamp on a submitted prompt ('typed', 'sdk', ...). Absent = an older CLI. */
  promptSource?: string
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
      ...(opts.promptSource ? { promptSource: opts.promptSource } : {}),
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
  it('picks up a terminal-typed session', async () => {
    claudeSession({ sid: 'human-1', entrypoint: 'cli', aiTitle: 'Fix login redirect' })

    const { candidates } = await scan()
    expect(candidates.map((c) => c.sessionId)).toEqual(['human-1'])
    expect(candidates[0]).toMatchObject({
      engine: 'claude',
      origin: 'cli',
      title: 'Fix login redirect',
      cwd: '/Users/dev/proj',
    })
  })

  it('imports what a person started and leaves out every run a program started', async () => {
    // A person: the terminal UI (a typed prompt, or a CLI older than
    // promptSource), the desktop app and the VS Code extension (both drive the
    // CLI over the SDK, so their prompts read 'sdk').
    claudeSession({ sid: 'typed', entrypoint: 'cli', promptSource: 'typed', firstUserText: 'fix the login redirect' })
    claudeSession({ sid: 'old-cli', entrypoint: 'cli' })
    claudeSession({ sid: 'desktop', entrypoint: 'claude-desktop', promptSource: 'sdk' })
    claudeSession({ sid: 'vscode', entrypoint: 'claude-vscode', promptSource: 'sdk' })
    // A program: `claude -p` (a script's fan-out, an agent orchestrator, Walnut
    // itself), the Agent SDKs, and `claude -p` run from a shell inside a
    // terminal session, which inherits 'cli' but sends its prompt over the SDK.
    claudeSession({ sid: 'print', entrypoint: 'sdk-cli', promptSource: 'sdk', cwd: '/Users/dev/agent-orchestrator' })
    claudeSession({ sid: 'sdk-ts', entrypoint: 'sdk-ts', promptSource: 'sdk' })
    claudeSession({ sid: 'sdk-py', entrypoint: 'sdk-py' })
    claudeSession({ sid: 'child', entrypoint: 'cli', promptSource: 'sdk' })
    claudeSession({ sid: 'mcp', entrypoint: 'mcp' })

    const { candidates } = await scan()
    expect(candidates.map((c) => c.sessionId).sort()).toEqual(['desktop', 'old-cli', 'typed', 'vscode'])
    expect(candidates.find((c) => c.sessionId === 'typed')).toMatchObject({ origin: 'cli', title: 'fix the login redirect', messageCount: 2 })
    expect(candidates.find((c) => c.sessionId === 'vscode')?.origin).toBe('claude-vscode')
  })

  it('excludes configured directories for every entrypoint, without matching sibling paths', async () => {
    for (const entrypoint of ['cli', 'claude-desktop', 'claude-vscode']) {
      claudeSession({ sid: `probe-${entrypoint}`, entrypoint, cwd: '/Users/dev/probes/run-1' })
    }
    claudeSession({ sid: 'real', entrypoint: 'cli', cwd: '/Users/dev/probes-app' })
    claudeSession({ sid: 'scratch', entrypoint: 'cli', cwd: '/tmp/real-work' })
    codexSession({ id: 'probe-codex', originator: 'codex-tui', cwd: '/Users/dev/probes/run-2' })
    expect((await scan({ excludedCwds: ['/Users/dev/probes/'] })).candidates.map(c => c.sessionId).sort())
      .toEqual(['real', 'scratch'])
  })

  it('filters before the candidate limit so excluded probes cannot starve real sessions', async () => {
    for (let i = 0; i < 205; i++) {
      claudeSession({ sid: `probe-${i}`, entrypoint: 'cli', cwd: '/Users/dev/probes' })
    }
    claudeSession({ sid: 'real', entrypoint: 'claude-desktop', cwd: '/Users/dev/work', mtimeMs: Date.now() - 10_000 })
    expect((await scan({ excludedCwds: ['/Users/dev/probes'], limit: 1 })).candidates.map(c => c.sessionId))
      .toEqual(['real'])
    expect((await scan({ excludedCwds: ['/Users/dev/probes'], limit: 1 })).truncated).toBe(false)
  })

  it('excludes tracked sessions via knownSessionIds whoever started them', async () => {
    claudeSession({ sid: 'walnut-own', entrypoint: 'cli', cwd: '/Users/dev/proj' })
    expect((await scan({ knownSessionIds: ['walnut-own'] })).candidates).toHaveLength(0)
  })

  it('includes the desktop app entrypoint', async () => {
    claudeSession({ sid: 'desk-1', entrypoint: 'claude-desktop' })
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['desk-1'])
  })

  it('skips subagent sidechain transcripts', async () => {
    claudeSession({ sid: 'side-1', entrypoint: 'cli', isSidechain: true })
    expect((await scan()).candidates).toHaveLength(0)
  })

  it('skips ids the server already tracks (never parsed)', async () => {
    claudeSession({ sid: 'human-1', entrypoint: 'cli' })
    claudeSession({ sid: 'human-2', entrypoint: 'cli' })
    const { candidates } = await scan({ knownSessionIds: ['human-1'] })
    expect(candidates.map((c) => c.sessionId)).toEqual(['human-2'])
  })

  it('honors the time window', async () => {
    claudeSession({ sid: 'fresh', entrypoint: 'cli', mtimeMs: Date.now() - 2 * 86400_000 })
    claudeSession({ sid: 'ancient', entrypoint: 'cli', mtimeMs: Date.now() - 200 * 86400_000 })
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['fresh'])
  })

  it('prefers the CLI ai-title, else falls back to the first user message', async () => {
    claudeSession({ sid: 'titled', entrypoint: 'cli', aiTitle: 'Real title', firstUserText: 'raw text' })
    claudeSession({ sid: 'untitled', entrypoint: 'cli', firstUserText: 'raw text here' })
    const byId = new Map((await scan()).candidates.map((c) => [c.sessionId, c]))
    expect(byId.get('titled')?.title).toBe('Real title')
    expect(byId.get('untitled')?.title).toBe('raw text here')
  })

  it('never titles a session with an injected preamble', async () => {
    claudeSession({
      sid: 'pre-1', entrypoint: 'cli',
      firstUserText: '# AGENTS.md instructions for /Users/dev/proj <INSTRUCTIONS> always do X',
    })
    claudeSession({
      sid: 'pre-2', entrypoint: 'cli',
      firstUserText: '<local-command-caveat>Caveat: the messages below were generated…',
    })
    for (const c of (await scan()).candidates) expect(c.title).toBeUndefined()
  })

  it('collapses whitespace and truncates a very long title', async () => {
    claudeSession({ sid: 'long-1', entrypoint: 'cli', firstUserText: 'a\nb   c ' + 'x'.repeat(400) })
    const title = (await scan()).candidates[0].title!
    expect(title.startsWith('a b c')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(120)
    expect(title.endsWith('…')).toBe(true)
  })

  it('survives malformed and empty transcripts', async () => {
    const bad = path.join(home, '.claude', 'projects', 'dir', 'broken.jsonl')
    fs.mkdirSync(path.dirname(bad), { recursive: true })
    fs.writeFileSync(bad, '{not json\n\n{"type":"user"\n')
    fs.writeFileSync(path.join(home, '.claude', 'projects', 'dir', 'empty.jsonl'), '')
    claudeSession({ sid: 'good', entrypoint: 'cli' })
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['good'])
  })

  it('returns an empty result when no transcript dirs exist at all', async () => {
    expect(await scan()).toEqual({ candidates: [], scanned: 0, parsed: 0, truncated: false })
  })
})

describe('scanExternalSessions — codex classification', () => {
  it('picks up the TUI/desktop originators and skips Walnut\'s own', async () => {
    codexSession({ id: 'cx-tui', originator: 'codex-tui', stamp: '2026-08-10T10-00-00' })
    codexSession({ id: 'cx-desk', originator: 'Codex Desktop', stamp: '2026-08-10T11-00-00' })
    codexSession({ id: 'cx-walnut', originator: 'open-walnut', stamp: '2026-08-10T12-00-00' })
    codexSession({ id: 'cx-exec', originator: 'codex_exec', stamp: '2026-08-10T13-00-00' })

    const ids = (await scan()).candidates.map((c) => c.sessionId).sort()
    expect(ids).toEqual(['cx-desk', 'cx-tui'])
    const tui = (await scan()).candidates.find((c) => c.sessionId === 'cx-tui')!
    expect(tui).toMatchObject({ engine: 'codex', origin: 'codex-tui', title: 'add retry to the uploader' })
  })

  it('dedupes resume rollouts of one session id, keeping the newest file', async () => {
    codexSession({
      id: 'cx-1', originator: 'codex-tui', stamp: '2026-08-10T10-00-00',
      firstUserText: 'first run', mtimeMs: Date.now() - 5 * 86400_000,
    })
    codexSession({
      id: 'cx-1', originator: 'codex-tui', stamp: '2026-08-12T10-00-00',
      firstUserText: 'resumed run', mtimeMs: Date.now() - 1 * 86400_000,
    })
    const { candidates } = await scan()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].sessionId).toBe('cx-1')
    expect(candidates[0].title).toBe('resumed run')
  })

  it('walks the year/month/day layout', async () => {
    codexSession({ id: 'cx-a', originator: 'codex-tui', day: '2026/07/01' })
    codexSession({ id: 'cx-b', originator: 'codex-tui', day: '2026/08/15' })
    expect((await scan({ sinceMs: 10 * 365 * 86400_000 })).candidates.map((c) => c.sessionId).sort())
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
  it('finds a codex user message that sits past 150KB of preamble', async () => {
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

    const { candidates } = await scan()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ sessionId: 'cx-deep', title: 'the real question', messageCount: 2 })
  })

  it('counts every message in a long claude session, not just the first', async () => {
    const lines: unknown[] = [{
      type: 'user', message: { role: 'user', content: 'start the work' },
      timestamp: '2026-08-10T10:00:00.000Z', cwd: '/Users/dev/proj', entrypoint: 'cli', isSidechain: false,
    }]
    for (let i = 0; i < 150; i++) {
      lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'step ' + i + ' ' + 'z'.repeat(500) }] } })
      lines.push({ type: 'user', message: { role: 'user', content: 'next ' + i } })
    }
    writeJsonl(path.join(home, '.claude', 'projects', 'dir', 'long.jsonl'), lines)

    const { candidates } = await scan()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].title).toBe('start the work')
    expect(candidates[0].messageCount).toBe(301)
  })

  it('does not lose a value that straddles a read-chunk boundary', async () => {
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

    const { candidates } = await scan()
    expect(candidates).toHaveLength(1)
    expect(candidates[0].title).toBe('buried first words')
    expect(candidates[0].cwd).toBe('/Users/dev/proj')
  })

  it('rejects a Walnut-owned rollout without reading its preamble', async () => {
    const filePath = path.join(home, '.codex', 'sessions', '2026/08/10', 'rollout-2026-08-10T10-00-00-cx-own.jsonl')
    writeJsonl(filePath, [
      {
        type: 'session_meta',
        payload: { session_id: 'cx-own', id: 'cx-own', cwd: '/Users/dev/proj', originator: 'open-walnut', base_instructions: { text: 'q'.repeat(80_000) } },
      },
      { type: 'event_msg', payload: { type: 'user_message', message: 'should never be titled' } },
    ])
    expect((await scan()).candidates).toHaveLength(0)
  })
})

describe('scanExternalSessions — result shape', () => {
  it('sorts newest-first and reports truncation instead of silently dropping', async () => {
    for (let i = 0; i < 5; i++) {
      claudeSession({ sid: `s-${i}`, entrypoint: 'cli', mtimeMs: Date.now() - i * 3600_000 })
    }
    const all = await scan()
    expect(all.candidates.map((c) => c.sessionId)).toEqual(['s-0', 's-1', 's-2', 's-3', 's-4'])
    expect(all.truncated).toBe(false)

    const capped = await scan({ limit: 2 })
    expect(capped.candidates.map((c) => c.sessionId)).toEqual(['s-0', 's-1'])
    expect(capped.truncated).toBe(true)
  })

  it('reports both engines together with counts', async () => {
    claudeSession({ sid: 'cl-1', entrypoint: 'cli' })
    codexSession({ id: 'cx-1', originator: 'codex-tui' })
    const res = await scan()
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
  const titleOf = async (sid: string): Promise<string | undefined> => (await (await scan())).candidates.find((c) => c.sessionId === sid)?.title

  it('skips a flagged compaction summary and titles by the human message after it', async () => {
    transcript('cont-1', [user(COMPACT, { isCompactSummary: true }), assistant, user('now fix the flaky test'), assistant])
    expect(await titleOf('cont-1')).toBe('now fix the flaky test')
  })

  it('skips the compaction summary by its text when an older CLI left no flag', async () => {
    transcript('cont-2', [user(COMPACT), assistant, user('continue with the migration'), assistant])
    expect(await titleOf('cont-2')).toBe('continue with the migration')
  })

  it('yields no title when the summary is the only user line (server mints the fallback)', async () => {
    transcript('cont-3', [user(COMPACT, { isCompactSummary: true }), assistant])
    expect(await titleOf('cont-3')).toBeUndefined()
  })

  it('skips any line that opens with a markup tag, as the CLI does (Walnut envelopes included)', async () => {
    transcript('warm-1', [user('<walnut-cache-warmup>This is a cache warm-up from Walnut.</walnut-cache-warmup>'), assistant, user('look at the failing build'), assistant])
    transcript('digest-1', [user('<walnut-side-thread-digest>summary</walnut-side-thread-digest>'), assistant, user('next step please'), assistant])
    transcript('ctx-1', [user('<context_entry> You are an agent</context_entry>'), assistant, user('check the queue'), assistant])
    transcript('only-tag', [user('<walnut-message from="task x">please rebase</walnut-message>'), assistant])
    expect(await titleOf('warm-1')).toBe('look at the failing build')
    expect(await titleOf('digest-1')).toBe('next step please')
    expect(await titleOf('ctx-1')).toBe('check the queue')
    expect(await titleOf('only-tag')).toBeUndefined()
  })

  it('skips interrupt markers', async () => {
    transcript('int-1', [user('[Request interrupted by user for tool use]'), assistant, user('[Request interrupted by user]'), user('try the other approach'), assistant])
    expect(await titleOf('int-1')).toBe('try the other approach')
  })

  it('skips built-in commands even with args, titles a custom one with args as "/name args"', async () => {
    transcript('cmd-1', [user('<command-name>/model</command-name>\n<command-args>sonnet</command-args>'), assistant, user('start over'), assistant])
    transcript('cmd-2', [user('<command-name>/clear</command-name>\n<command-args></command-args>'), assistant, user('start over on the parser'), assistant])
    transcript('cmd-3', [user('<command-name>/deploy</command-name>\n<command-args>staging now</command-args>'), assistant])
    expect(await titleOf('cmd-1')).toBe('start over')
    expect(await titleOf('cmd-2')).toBe('start over on the parser')
    expect(await titleOf('cmd-3')).toBe('/deploy staging now')
  })

  it('titles bash-mode input as "! cmd"', async () => {
    transcript('bash-1', [user('<bash-input>git status</bash-input>'), assistant])
    expect(await titleOf('bash-1')).toBe('! git status')
  })

  it('looks past leading metadata blocks inside one message', async () => {
    transcript('ide-1', [{
      type: 'user', uuid: 'u', timestamp: '2026-08-10T10:00:00.000Z', cwd: '/Users/dev/proj', sessionId: 'ide-1', entrypoint: 'cli',
      message: { role: 'user', content: [
        { type: 'text', text: '<ide_opened_file>The user opened src/a.ts</ide_opened_file>' },
        { type: 'image', source: { type: 'base64', data: 'x' } },
        { type: 'text', text: 'why does this throw' },
      ] },
    }, assistant])
    expect(await titleOf('ide-1')).toBe('why does this throw')
  })

  it('skips meta user lines exactly like the CLI', async () => {
    transcript('meta-1', [user('<injected instruction>', { isMeta: true }), assistant, user('real question here'), assistant])
    expect(await titleOf('meta-1')).toBe('real question here')
  })

  it('prefers a /rename custom-title over the ai-title and the first prompt', async () => {
    transcript('custom-1', [
      user('first prompt'), assistant,
      { type: 'ai-title', aiTitle: 'AI picked this', sessionId: 'custom-1' },
      { type: 'custom-title', customTitle: 'Human named it', sessionId: 'custom-1' },
    ])
    expect(await titleOf('custom-1')).toBe('Human named it')
  })

  it('treats an emptied custom-title as cleared and falls back to the ai-title', async () => {
    transcript('custom-2', [
      user('first prompt'), assistant,
      { type: 'custom-title', customTitle: 'Old name', sessionId: 'custom-2' },
      { type: 'ai-title', aiTitle: 'AI picked this', sessionId: 'custom-2' },
      { type: 'custom-title', customTitle: '', sessionId: 'custom-2' },
    ])
    expect(await titleOf('custom-2')).toBe('AI picked this')
  })

  it('finds an ai-title that scrolled out of the tail window', async () => {
    // 128KB tail: bury the title line under ~300KB of later turns.
    const filler = Array.from({ length: 300 }, (_, i) => ({
      type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] },
      timestamp: `2026-08-10T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
    }))
    transcript('head-title', [user('first prompt'), { type: 'ai-title', aiTitle: 'Early AI title', sessionId: 'head-title' }, ...filler])
    expect(await titleOf('head-title')).toBe('Early AI title')
  })

  it('leaves codex titling unchanged (first human message)', async () => {
    codexSession({ id: 'cdx-1', originator: 'codex-tui', firstUserText: 'refactor the parser' })
    expect((await scan()).candidates.find((c) => c.sessionId === 'cdx-1')?.title).toBe('refactor the parser')
  })
})

/**
 * describeExternalSessions: the retitle path for imports whose transcript aged
 * out of the scan window. Looks up exact ids, applies the same title rule, and
 * never classifies (the ids are ones Walnut already owns).
 */
describe('describeExternalSessions — by id, regardless of age', () => {
  // A whole second: utimes takes seconds as a double, and on Linux a millisecond
  // fraction can come back as 122.999999ms, which toISOString reads one ms early.
  const YEAR_AGO = Math.floor((Date.now() - 400 * 24 * 60 * 60 * 1000) / 1000) * 1000

  it('finds a claude transcript by id in any project dir even when the scan window misses it', async () => {
    claudeSession({ sid: 'old-1', entrypoint: 'cli', firstUserText: 'old but gold', mtimeMs: YEAR_AGO, encodedDir: '-Users-dev-somewhere' })
    expect((await scan()).candidates.map((c) => c.sessionId)).not.toContain('old-1')
    const { candidates } = await describeExternalSessions({ sessionIds: ['old-1', 'missing-9'], homeDir: home })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ sessionId: 'old-1', engine: 'claude', title: 'old but gold', cwd: '/Users/dev/proj' })
  })

  it('applies the CLI title rule (custom-title over the first prompt) and skips sidechains', async () => {
    const file = claudeSession({ sid: 'named-1', entrypoint: 'sdk-cli', firstUserText: 'first prompt', mtimeMs: YEAR_AGO })
    fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'Renamed by hand', sessionId: 'named-1' }) + '\n')
    claudeSession({ sid: 'side-1', entrypoint: 'cli', isSidechain: true, mtimeMs: YEAR_AGO })
    const { candidates } = await describeExternalSessions({ sessionIds: ['named-1', 'side-1'], homeDir: home })
    expect(candidates.map((c) => c.sessionId)).toEqual(['named-1'])
    expect(candidates[0].title).toBe('Renamed by hand')
  })

  it('finds a codex session by rollout suffix, newest rollout wins', async () => {
    codexSession({ id: 'cdx-old', originator: 'codex-tui', firstUserText: 'older rollout', stamp: '2025-01-01T10-00-00', day: '2025/01/01', mtimeMs: YEAR_AGO - 1000 })
    codexSession({ id: 'cdx-old', originator: 'codex-tui', firstUserText: 'newer rollout', stamp: '2025-01-02T10-00-00', day: '2025/01/02', mtimeMs: YEAR_AGO })
    const { candidates } = await describeExternalSessions({ sessionIds: ['cdx-old'], homeDir: home })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ sessionId: 'cdx-old', engine: 'codex', title: 'newer rollout' })
  })

  it('answers stat-only activity without parsing, and omits ids with no transcript', async () => {
    claudeSession({ sid: 'act-1', entrypoint: 'cli', mtimeMs: YEAR_AGO })
    codexSession({ id: 'act-cdx', originator: 'codex-tui', mtimeMs: YEAR_AGO })
    const { candidates, activity } = await describeExternalSessions({ sessionIds: ['act-1', 'act-cdx', 'gone'], activityOnly: true, homeDir: home })
    expect(candidates).toEqual([])
    expect(activity).toEqual(expect.arrayContaining([
      { sessionId: 'act-1', lastActiveAt: new Date(YEAR_AGO).toISOString() },
      { sessionId: 'act-cdx', lastActiveAt: new Date(YEAR_AGO).toISOString() },
    ]))
    expect(activity).toHaveLength(2)
  })

  it('returns nothing for an empty ask or an unreadable home', async () => {
    expect((await describeExternalSessions({ sessionIds: [], homeDir: home })).candidates).toEqual([])
    expect((await describeExternalSessions({ sessionIds: ['x'], homeDir: path.join(home, 'nope') })).candidates).toEqual([])
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

  it('skips a side-thread fork: queued warm-up, copied compaction summary, reminder-wrapped sends', async () => {
    writeJsonl(file('fork-1'), [
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'fork-1' },
      { type: 'queue-operation', operation: 'enqueue', sessionId: 'fork-1', content: '<walnut-cache-warmup>This is a cache warm-up. Reply with exactly one word: Ready.' },
      user('fork-1', 'This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true }),
      reply('HLD keeps both designs.'),
      user('fork-1', 'continue\n\n' + REMINDER),
      reply(),
    ])
    expect((await scan()).candidates).toEqual([])
  })

  it('skips a programmatic fork with no Walnut envelope at all (markdown-mode btw / lane / task fork)', async () => {
    // The queued first input is stamped at fork time; the copied chain keeps
    // the parent's older timestamps.
    writeJsonl(file('fork-plain'), [
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-21T18:30:36.716Z', content: 'what does this function return?' },
      { type: 'system', subtype: 'compact_boundary', timestamp: '2026-09-18T17:58:41.634Z', parentUuid: null },
      user('fork-plain', 'the parent asked this first', { timestamp: '2026-09-18T17:55:38.049Z' }),
      reply(),
      user('fork-plain', 'what does this function return?', { timestamp: '2026-09-21T18:30:37.000Z' }),
      reply(),
    ])
    const byId = Object.fromEntries((await describeExternalSessions({ sessionIds: ['fork-plain'], homeDir: home }))
      .candidates.map((c) => [c.sessionId, c.notExternal]))
    expect((await scan()).candidates).toEqual([])
    expect(byId).toEqual({ 'fork-plain': 'fork' })
  })

  it('does not call a plain SDK session whose later input was queued mid-turn a fork, and keeps a terminal fork', async () => {
    writeJsonl(file('plain-q'), [
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-21T10:00:00.000Z', content: 'start the work' },
      user('plain-q', 'start the work', { timestamp: '2026-09-21T10:00:00.500Z' }),
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-21T10:30:00.000Z', content: 'also this' },
      reply('long turn', { timestamp: '2026-09-21T10:05:00.000Z' }),
    ])
    writeJsonl(file('term-fork-2'), [
      { type: 'file-history-snapshot', timestamp: '2026-09-21T18:30:36.716Z' },
      user('term-fork-2', 'copied parent turn', { entrypoint: 'cli', timestamp: '2026-09-18T17:55:38.049Z' }),
      reply(),
    ])
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['term-fork-2'])
    const byId = Object.fromEntries((await describeExternalSessions({ sessionIds: ['plain-q'], homeDir: home }))
      .candidates.map((c) => [c.sessionId, c.notExternal]))
    expect(byId).toEqual({ 'plain-q': 'programmatic' })
  })

  it('skips a Walnut-driven session found by the reminder alone, and by the mode switch line', async () => {
    writeJsonl(file('rem-1'), [user('rem-1', [{ type: 'text', text: 'fix the flaky test\n\n' + REMINDER }]), reply()])
    writeJsonl(file('edge-1'), [user('edge-1', 'hello\n\n[Rich output mode: ON] Keep writing markdown.'), reply()])
    expect((await scan()).candidates).toEqual([])
  })

  it('does not call a session Walnut-driven when its text merely mentions the markers mid-sentence', async () => {
    const text = 'why does my reply end with [Rich output mode is still on]? and what is <walnut-cache-warmup> for'
    writeJsonl(file('talk-1'), [user('talk-1', text, { entrypoint: 'cli' }), reply()])
    writeJsonl(file('talk-2'), [user('talk-2', text), reply()])
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['talk-1'])
    const byId = Object.fromEntries((await describeExternalSessions({ sessionIds: ['talk-2'], homeDir: home }))
      .candidates.map((c) => [c.sessionId, c.notExternal]))
    expect(byId).toEqual({ 'talk-2': 'programmatic' })
  })

  it('keeps a terminal fork of a Walnut session: a person started that work', async () => {
    writeJsonl(file('term-fork'), [
      user('term-fork', 'continue\n\n' + REMINDER, { entrypoint: 'cli' }),
      reply(),
      user('term-fork', 'now split the doc in two', { entrypoint: 'cli' }),
      reply(),
    ])
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['term-fork'])
  })

  it('skips a probe whose only reply is an API error, and one answered by a synthetic stub', async () => {
    const cli = { entrypoint: 'cli' }
    writeJsonl(file('probe-1'), [
      { type: 'queue-operation', operation: 'enqueue', content: 'Say only Z.' },
      user('probe-1', 'Say only Z.', cli),
      reply('API Error: 400 capture-only probe', { isApiErrorMessage: true }),
    ])
    writeJsonl(file('stub-1'), [
      user('stub-1', 'ping', cli),
      { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
    ])
    writeJsonl(file('asked-1'), [user('asked-1', 'still thinking about this one', cli)])
    writeJsonl(file('ok-1'), [user('ok-1', 'Say only Z.', cli), reply('Z')])
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['ok-1'])
  })

  it('does not call a transcript reply-less when the head budget could not reach the reply', async () => {
    const big = 'x'.repeat(2.5 * 1024 * 1024)
    writeJsonl(file('big-1'), [user('big-1', 'review this log', { entrypoint: 'cli' }), user('big-1', big), reply('done')])
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['big-1'])
  })

  it('describe reports why a known import is not an outside session', async () => {
    writeJsonl(file('fork-2'), [
      { type: 'queue-operation', operation: 'enqueue', content: '<walnut-cache-warmup>Reply Ready.' },
      user('fork-2', 'What is a VPC CIDR versus a subnet?'),
      reply(),
    ])
    writeJsonl(file('probe-2'), [user('probe-2', 'Say only Z.'), reply('err', { isApiErrorMessage: true })])
    writeJsonl(file('real-2'), [user('real-2', 'fix the login bug', { entrypoint: 'cli' }), reply()])
    writeJsonl(file('prog-2'), [user('prog-2', 'summarize the deploy'), reply()])
    const byId = Object.fromEntries((await describeExternalSessions({ sessionIds: ['fork-2', 'probe-2', 'real-2', 'prog-2'], homeDir: home }))
      .candidates.map((c) => [c.sessionId, c.notExternal]))
    // 'programmatic' only for a real session: a fork or a probe keeps its own reason.
    expect(byId).toEqual({ 'fork-2': 'walnut-driven', 'probe-2': 'no-reply', 'real-2': null, 'prog-2': 'programmatic' })
  })

  it('skips any id in the spawn journal and says which Walnut started it', async () => {
    const journal = path.join(home, 'journal', 'spawn-journal.jsonl')
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(journal, [
      JSON.stringify({ v: 1, sid: 'jr-1', at: '2026-09-26T00:00:00.000Z', kind: 'fork', parent: 'p-1', cwd: '/w', home: '/tmp/eph', task: 't-1' }),
      // A later line for the same id never overwrites the original spawn.
      JSON.stringify({ v: 1, sid: 'jr-1', kind: 'backfill' }),
      'not json',
      JSON.stringify({ v: 1, sid: '../escape', kind: 'new' }),
      // A torn tail from a writer that died mid-line.
      '{"v":1,"sid":"jr-2","ki',
    ].join('\n'))
    writeJsonl(file('jr-1'), [user('jr-1', 'fix the login bug', { entrypoint: 'cli' }), reply()])
    writeJsonl(file('jr-2'), [user('jr-2', 'add retries', { entrypoint: 'cli' }), reply()])
    expect((await scan({ spawnJournal: journal })).candidates.map((c) => c.sessionId))
      .toEqual(['jr-2'])
    const byId = Object.fromEntries((await describeExternalSessions({ sessionIds: ['jr-1', 'jr-2'], homeDir: home, spawnJournal: journal }))
      .candidates.map((c) => [c.sessionId, [c.notExternal, c.spawnedBy]]))
    expect(byId).toEqual({
      'jr-1': ['walnut-spawned', { kind: 'fork', at: '2026-09-26T00:00:00.000Z', parent: 'p-1', home: '/tmp/eph', task: 't-1' }],
      'jr-2': [null, undefined],
    })
  })

  it('skips any id in the legacy marker dir or the streams dir, whatever the transcript says', async () => {
    // A daemon on this host started these CLIs for SOME Walnut instance —
    // maybe not the asking server (dev/test server, records gone).
    fs.mkdirSync(path.join(home, '.open-walnut', 'tmp', 'spawned-sessions'), { recursive: true })
    fs.mkdirSync(path.join(home, '.open-walnut', 'tmp', 'streams'), { recursive: true })
    fs.writeFileSync(path.join(home, '.open-walnut', 'tmp', 'spawned-sessions', 'led-1'), '')
    fs.writeFileSync(path.join(home, '.open-walnut', 'tmp', 'streams', 'str-1.jsonl'), '')
    // Sibling stream artifacts must not mint ids.
    fs.writeFileSync(path.join(home, '.open-walnut', 'tmp', 'streams', 'str-1.jsonl.err'), '')
    fs.writeFileSync(path.join(home, '.open-walnut', 'tmp', 'streams', 'str-1.pgid'), '')
    // Perfectly human-looking transcripts, but the ledger says they are ours.
    writeJsonl(file('led-1'), [user('led-1', 'fix the login bug', { entrypoint: 'cli' }), reply()])
    writeJsonl(file('str-1'), [user('str-1', 'add retries', { entrypoint: 'cli' }), reply()])
    writeJsonl(file('out-1'), [user('out-1', 'real outside work', { entrypoint: 'cli' }), reply()])
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['out-1'])
    const byId = Object.fromEntries((await describeExternalSessions({ sessionIds: ['led-1', 'str-1', 'out-1'], homeDir: home }))
      .candidates.map((c) => [c.sessionId, c.notExternal]))
    expect(byId).toEqual({ 'led-1': 'walnut-spawned', 'str-1': 'walnut-spawned', 'out-1': null })
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

/**
 * The scan runs on the daemon's one event loop. In one synchronous pass over a
 * real host's 16,000 transcripts it held that loop for 17 to 75 s every ten
 * minutes (2026-09-29), long enough for a user's send to time out and the live
 * CLI to be stopped for a resume. It now remembers each file's verdict until
 * the file changes, and hands the loop back as it walks.
 */
describe('scanExternalSessions — remembered verdicts and a responsive event loop', () => {
  const PROJ = '/Users/dev/proj'
  const file = (sid: string) => path.join(home, '.claude', 'projects', '-Users-dev-proj', sid + '.jsonl')
  const user = (sid: string, content: string, extra: Record<string, unknown> = {}) => ({
    type: 'user', message: { role: 'user', content }, cwd: PROJ, sessionId: sid, entrypoint: 'cli',
    timestamp: '2026-09-29T10:00:00.000Z', ...extra,
  })
  const reply = { type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'ok' }] } }

  it('reads no head for a transcript that has not changed since the last scan', async () => {
    writeJsonl(file('keep-1'), [user('keep-1', 'fix the login bug'), reply])
    writeJsonl(file('debris-1'), [user('debris-1', 'probe', { entrypoint: 'sdk-cli', cwd: '/tmp/x' }), reply])
    codexSession({ id: 'cx-keep', originator: 'codex-tui' })

    const first = await scan()
    expect(first).toMatchObject({ scanned: 3, parsed: 3 })
    const second = await scan()
    expect(second).toMatchObject({ scanned: 3, parsed: 0 })
    expect(second.candidates).toEqual(first.candidates)
    expect(second.candidates.map((c) => c.sessionId).sort()).toEqual(['cx-keep', 'keep-1'])
  })

  it('reads a transcript again once it changes, even when a rewrite keeps its size and mtime', async () => {
    const probe = file('grow-1')
    writeJsonl(probe, [user('grow-1', 'still thinking about this one')])
    expect((await scan()).candidates).toEqual([])
    // The reply lands: the reply-less verdict must not stick.
    fs.appendFileSync(probe, JSON.stringify(reply) + '\n')
    const grown = await scan()
    expect(grown).toMatchObject({ parsed: 1 })
    expect(grown.candidates.map((c) => c.title)).toEqual(['still thinking about this one'])

    // Same length, same mtime put back: only ctime tells the rewrite apart.
    // A whole second, because utimes rounds a Date to the millisecond.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000)
    fs.utimesSync(probe, pinned, pinned)
    expect((await scan()).candidates.map((c) => c.title)).toEqual(['still thinking about this one'])
    const before = fs.statSync(probe)
    fs.writeFileSync(probe, fs.readFileSync(probe, 'utf8').replace('still thinking', 'quiet thinking'))
    fs.utimesSync(probe, pinned, pinned)
    expect(fs.statSync(probe)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs })
    expect((await scan()).candidates.map((c) => c.title)).toEqual(['quiet thinking about this one'])
  })

  it('still applies excluded cwds and known ids to a remembered verdict', async () => {
    writeJsonl(file('real-1'), [user('real-1', 'real work'), reply])
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['real-1'])
    const excluded = await scan({ excludedCwds: [PROJ] })
    expect(excluded).toMatchObject({ candidates: [], parsed: 0 })
    expect((await scan({ knownSessionIds: ['real-1'] })).candidates).toEqual([])
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['real-1'])
  })

  it('forgets a deleted transcript and hands out copies of what it remembers', async () => {
    writeJsonl(file('gone-1'), [user('gone-1', 'short lived'), reply])
    writeJsonl(file('stay-1'), [user('stay-1', 'stays put'), reply])
    const first = await scan()
    for (const c of first.candidates) c.title = 'mutated by a caller'
    fs.rmSync(file('gone-1'))
    const second = await scan()
    expect(second).toMatchObject({ scanned: 1, parsed: 0 })
    expect(second.candidates.map((c) => [c.sessionId, c.title])).toEqual([['stay-1', 'stays put']])
  })

  it('tries an unreadable transcript again on the next scan instead of remembering the failure', async () => {
    writeJsonl(file('locked-1'), [user('locked-1', 'real work'), reply])
    writeJsonl(file('plain-1'), [{ type: 'summary', summary: 'no user line' }])
    fs.chmodSync(file('locked-1'), 0o000)
    try {
      expect(await scan()).toMatchObject({ candidates: [], scanned: 2, parsed: 2 })
      // plain-1's reject is remembered; locked-1's failed read is not.
      expect(await scan()).toMatchObject({ candidates: [], scanned: 2, parsed: 1 })
    } finally {
      fs.chmodSync(file('locked-1'), 0o644)
    }
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['locked-1'])
  })

  it('lets timers run while it walks a large tree', async () => {
    const chat = { type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'y'.repeat(4000) }] } }
    for (let i = 0; i < 400; i++) {
      writeJsonl(file('bulk-' + i), [user('bulk-' + i, 'task ' + i), ...Array(10).fill(chat)])
    }
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 1)
    let scanned = 0
    try {
      scanned = (await scan()).scanned
    } finally {
      clearInterval(timer)
    }
    // A synchronous walk lets no timer fire until it returns.
    expect(ticks).toBeGreaterThan(0)
    expect(scanned).toBe(400)
  })
})

/**
 * Who started a session decides whether it is an outside session, read from the
 * CLI's own record rather than guessed. A script that fanned out `claude -p`
 * (one run per dashboard widget, per ticket row) once filed about 1,000 tasks a
 * day on one host (2026-10-06): each run is that program's work, like a
 * subagent, not a session someone opened.
 */
describe('scanExternalSessions — who started it', () => {
  const file = (sid: string) => path.join(home, '.claude', 'projects', '-Users-dev-ops', sid + '.jsonl')
  const at = '2026-09-20T10:00:00.000Z'
  const line = (sid: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'user', message: { role: 'user', content }, timestamp: at, cwd: '/Users/dev/ops', sessionId: sid, entrypoint: 'cli', ...extra,
  })
  const reply = { type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'ok' }] }, timestamp: at }
  const describeIds = async (sessionIds: string[]) => Object.fromEntries(
    (await describeExternalSessions({ sessionIds, homeDir: home })).candidates.map((c) => [c.sessionId, c.notExternal]))

  it('leaves out a fan-out of `claude -p` runs, keeps a person\'s session in the same folder, and remembers the verdict', async () => {
    for (let i = 0; i < 12; i++) {
      writeJsonl(file('w-' + i), [line('w-' + i, 'Review ONE dashboard widget: ' + i, { entrypoint: 'sdk-cli', promptSource: 'sdk' }), reply])
    }
    writeJsonl(file('person'), [line('person', 'why did the widget review flag nothing today?', { promptSource: 'typed' }), reply])
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['person'])
    const again = await scan()
    expect(again).toMatchObject({ scanned: 13, parsed: 0 })
    expect(again.candidates.map((c) => c.sessionId)).toEqual(['person'])
    expect(await describeIds(['w-0', 'w-11', 'person'])).toEqual({ 'w-0': 'programmatic', 'w-11': 'programmatic', person: null })
  })

  it('reads the first SUBMITTED prompt: a command expansion before it carries no source', async () => {
    // A slash command writes its expansion lines first, without promptSource.
    const command = '<command-message>review</command-message>\n<command-name>/review</command-name>'
    writeJsonl(file('cmd-typed'), [line('cmd-typed', command), line('cmd-typed', 'look at the auth module', { promptSource: 'typed' }), reply])
    writeJsonl(file('cmd-sdk'), [line('cmd-sdk', command), line('cmd-sdk', 'look at the auth module', { promptSource: 'sdk' }), reply])
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['cmd-typed'])
    expect(await describeIds(['cmd-sdk'])).toEqual({ 'cmd-sdk': 'programmatic' })
  })

  it('a program-started session gets the whole describe answer: title, count, reason', async () => {
    writeJsonl(file('vt-1'), [
      { type: 'queue-operation', operation: 'enqueue', timestamp: at, content: 'Investigate ticket V2387331' },
      line('vt-1', 'Investigate ticket V2387331', { entrypoint: 'sdk-cli', promptSource: 'sdk' }),
      reply,
      line('vt-1', 'also check the alarm', { entrypoint: 'sdk-cli', promptSource: 'sdk' }),
      reply,
    ])
    const [c] = (await describeExternalSessions({ sessionIds: ['vt-1'], homeDir: home })).candidates
    expect(c).toMatchObject({ sessionId: 'vt-1', origin: 'sdk-cli', title: 'Investigate ticket V2387331', messageCount: 4, notExternal: 'programmatic' })
  })

  it('codex: describe says programmatic for a non-interactive originator, and reads its title', async () => {
    codexSession({ id: 'cx-exec', originator: 'codex_exec', firstUserText: 'bump the dependency' })
    codexSession({ id: 'cx-tui', originator: 'codex-tui', stamp: '2026-08-10T11-00-00' })
    expect((await scan()).candidates.map((c) => c.sessionId)).toEqual(['cx-tui'])
    const byId = Object.fromEntries((await describeExternalSessions({ sessionIds: ['cx-exec', 'cx-tui'], homeDir: home }))
      .candidates.map((c) => [c.sessionId, [c.notExternal, c.title]]))
    expect(byId).toEqual({ 'cx-exec': ['programmatic', 'bump the dependency'], 'cx-tui': [null, 'add retry to the uploader'] })
  })
})
