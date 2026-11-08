/**
 * The mock CLI reads Walnut's spawn argv the way the real one does: every flag
 * Walnut passes is known with the value it takes, and only a bare argument is
 * the first turn's message (tests/providers/mock-claude-flags.mjs says why).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BARE_FLAGS, knownFlag, VALUE_FLAGS } from './mock-claude-flags.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const MOCK = path.join(import.meta.dirname, 'mock-claude.mjs')

/** The files in src/ that build a claude CLI argv. */
const ARGV_BUILDERS = [
  'src/providers/claude-code-session.ts',
  'src/providers/spawn-template.ts',
  'src/providers/inline-subagent.ts',
  'src/providers/daemon-cron-supervision.ts',
  'src/core/sessions/spawn-prefix.ts',
]

/** The `--flag` string literals of a source file, outside comments. */
function flagLiterals(file: string): string[] {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8')
    .split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n')
  return [...new Set([...code.matchAll(/['"`](--[a-zA-Z][a-zA-Z-]*)/g)].map((m) => m[1]!))]
}

describe('the mock CLI knows every flag Walnut passes', () => {
  it('each claude argv builder in src/ names only flags the mock knows', () => {
    const unknown = ARGV_BUILDERS.flatMap((file) => flagLiterals(file).filter((f) => !knownFlag(f)).map((f) => `${file}: ${f}`))
    expect(unknown, 'add the flag to tests/providers/mock-claude-flags.mjs, in VALUE_FLAGS when it takes a value').toEqual([])
    expect(ARGV_BUILDERS.flatMap(flagLiterals)).toContain('--permission-prompt-tool')
  })

  it('no flag is listed both with a value and without one', () => {
    expect([...VALUE_FLAGS].filter((f) => BARE_FLAGS.has(f))).toEqual([])
  })

  it('only a bare argument is the message: no flag or flag value is', async () => {
    // The old loop read every argument it did not know as the message, so the
    // last one won: here "stdio", the value of --permission-prompt-tool.
    const args = ['-p', '--output-format', 'json', 'the prompt', '--settings', '{"env":{}}',
      '--mcp-config', '{"mcpServers":{}}', '--permission-prompt-tool', 'stdio', '--some-future-flag']
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [MOCK, ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
      let text = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { text += chunk })
      child.on('error', reject)
      child.on('exit', () => resolve(text))
    })
    const result = String((JSON.parse(out) as { result: unknown }).result)
    expect(result).toContain('I processed your message: the prompt')
    expect(result).not.toContain('stdio')
  }, 15_000)

  it('a spawn with Walnut\'s argv answers its first FIFO line, even one written late', async () => {
    // The tail of every Walnut spawn (claude-code-session.ts): `stdio` used to become
    // the message, and a first line written after the mock's 500 ms read was lost.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--debug',
      '--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
      '--session-id', '6f1c1a4e-0000-4000-8000-000000000001', '--settings', '{"env":{}}',
      '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']
    const child = spawn(process.execPath, [MOCK, ...args], { stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      child.stdout.on('data', (chunk: string) => {
        out += chunk
        for (const line of out.split('\n')) {
          try {
            const event = JSON.parse(line) as Record<string, unknown>
            if (event.type === 'result') resolve(event)
          } catch { /* a partial line */ }
        }
      })
      child.on('exit', (code) => reject(new Error(`the mock exited (${code}) before a result: ${out}`)))
    })
    try {
      // Past the mock's 500 ms first read even when its start is slow.
      await new Promise((r) => setTimeout(r, 1200))
      expect(child.exitCode, 'the mock must wait for its first line, not answer an argument').toBeNull()
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'the late first line' } }) + '\n')
      const event = await result
      expect(String(event.result)).toContain('the late first line')
      expect(String(event.result)).not.toContain('stdio')
    } finally {
      child.kill()
    }
  }, 15_000)
})

/** The mock's source, and the body of the block whose header (ending in `{`) is `header`. */
const MOCK_SRC = fs.readFileSync(MOCK, 'utf8')
function blockAfter(header: string, from = 0): string {
  const open = indexOfOrThrow(header, from) + header.length - 1
  let depth = 0
  for (let i = open; i < MOCK_SRC.length; i++) {
    if (MOCK_SRC[i] === '{') depth++
    else if (MOCK_SRC[i] === '}' && --depth === 0) return MOCK_SRC.slice(open + 1, i)
  }
  throw new Error(`no closed block after: ${header}`)
}
function indexOfOrThrow(needle: string, from = 0): number {
  const at = MOCK_SRC.indexOf(needle, from)
  if (at < 0) throw new Error(`mock-claude.mjs no longer has: ${needle}`)
  return at
}
/** The text from the `{` that encloses `at` up to `at`. */
function enclosingBlockBefore(at: number): string {
  let depth = 0
  for (let i = at - 1; i >= 0; i--) {
    if (MOCK_SRC[i] === '}') depth++
    else if (MOCK_SRC[i] === '{' && depth-- === 0) return MOCK_SRC.slice(i, at)
  }
  return MOCK_SRC.slice(0, at)
}

describe('the mock CLI keeps the input line uuid of the turn it runs', () => {
  type Seen = Array<[string, string | null]>

  it('a live stdin line handed to onUserLine sets lastInputUserUuid, and a line without one clears it', () => {
    const body = blockAfter("} else if (parsed.type === 'user' && parsed.message?.content !== undefined && onUserLine) {")
    const run = new Function('parsed', 'prev', `let lastInputUserUuid = prev; const seen = [];
      const onUserLine = (c) => seen.push([c, lastInputUserUuid]); const announceStarted = () => {};
      ${body}
      return seen;`) as (parsed: unknown, prev: string | null) => Seen
    expect(run({ type: 'user', uuid: 'in-1', message: { content: 'next' } }, 'old')).toEqual([['next', 'in-1']])
    expect(run({ type: 'user', message: { content: 'bare' } }, 'old')).toEqual([['bare', null]])
  })

  it('a queued line armSnapshotNextTurn runs sets lastInputUserUuid, and a line without one clears it', () => {
    const fn = `function armSnapshotNextTurn(opts = {}) {${blockAfter('function armSnapshotNextTurn(opts = {}) {')}}`
    const run = new Function('queuedUserLines', 'prev', `let lastInputUserUuid = prev, onUserLine = null, plainStaysAlive, message;
      const seen = []; const emitRemainingEvents = () => seen.push([message, lastInputUserUuid]);
      const computeMessageParts = () => {}; const setTimeout = (f) => f();
      const process = { stdout: { write: () => true }, cwd: () => '/' }; const outputSessionId = 's', modelFlag = '', permissionMode = '';
      ${fn}
      armSnapshotNextTurn();
      return seen;`) as (queued: unknown[], prev: string | null) => Seen
    expect(run([{ type: 'user', uuid: 'q-1', message: { content: 'queued' } }], 'old')).toEqual([['queued', 'q-1']])
    expect(run([{ type: 'user', message: { content: 'bare' } }], 'old')).toEqual([['bare', null]])
  })

  it('emitRemainingEvents reads the turn\'s input uuid first, before any delayed body', () => {
    const header = 'function emitRemainingEvents() {'
    const capture = MOCK_SRC.slice(indexOfOrThrow(header) + header.length).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'))
    expect(capture).toBe('const turnInputUuid = lastInputUserUuid;')
  })

  it('every place that hands a user line to onUserLine sets lastInputUserUuid in the same block first', () => {
    const calls = [...MOCK_SRC.matchAll(/\bonUserLine(?:\?\.)?\(/g)].map((m) => m.index!)
    expect(calls.length, 'the stdin listener and armSnapshotNextTurn both dispatch').toBeGreaterThanOrEqual(2)
    const missing = calls.filter((at) => !/lastInputUserUuid = \w+\.uuid \?\? null;/.test(enclosingBlockBefore(at)))
      .map((at) => `mock-claude.mjs:${MOCK_SRC.slice(0, at).split('\n').length}`)
    expect(missing, 'set lastInputUserUuid = <line>.uuid ?? null before the dispatch').toEqual([])
  })

  type Row = { type: string; uuid: string; parentUuid: string | null }
  /** The real transcript writers (persistMockTurn, file-edit-turn's, the plain turn's) over an in-memory fs: no file is touched. */
  function loadWriters(files: Record<string, string>, env: Record<string, string> = {}, lastInput: string | null = 'stale') {
    const fns = ['function chainOntoTranscript(file) {',
      'function persistMockTurn(sessionId, prompt, answer, root = process.env.MOCK_CLAUDE_TRANSCRIPT_DIR, inputUuid = lastInputUserUuid) {',
      'function persistFileOf(sid) {', 'function persistPlainUser(sid, prompt) {', 'function persistPlainTurn(sid, prompt, assistantEvent) {']
      .map((h) => `${h}${blockAfter(h)}}`).join('\n')
    const fileEdit = blockAfter('if (root) {', indexOfOrThrow("if (effectiveMessage.startsWith('file-edit-turn:')) {"))
    const plainTail = MOCK_SRC.split('\n').map((l) => l.trim()).find((l) => l.startsWith('if (!persistPlainTurn(outputSessionId'))!
    const fs = { mkdirSync: () => {}, existsSync: (f: string) => f in files, readFileSync: (f: string) => files[f],
      readdirSync: (root: string) => [...new Set(Object.keys(files).filter((f) => f.startsWith(`${root}/`)).map((f) => f.slice(root.length + 1).split('/')[0]))],
      appendFileSync: (f: string, text: string) => { files[f] = (files[f] ?? '') + text } }
    let n = 0
    const make = new Function('fs', 'path', 'randomUUID', 'env', 'lastInput', `let transcriptParent = null, lastInputUserUuid = lastInput, persistedUser = null;
      const process = { cwd: () => '/w', env, pid: 1 };
      ${fns}
      function fileEditTurn(sid, rows, effectiveMessage, turnInputUuid) { const root = '/t'; if (root) {${fileEdit}} }
      function plainTurn(outputSessionId, message, assistantEvent, turnInputUuid) { ${plainTail} }
      return { persistMockTurn, fileEditTurn, plainTurn };`)
    const writers = make(fs, { join: (...p: string[]) => p.join('/') }, () => `fresh-${++n}`, env, lastInput) as {
      persistMockTurn: (sid: string, prompt: string, answer: unknown, root: string, inputUuid?: string | null) => void
      fileEditTurn: (sid: string, rows: unknown[], effectiveMessage: string, turnInputUuid: string | null) => void
      plainTurn: (sid: string, message: string, assistantEvent: unknown, turnInputUuid: string | null) => void
    }
    const rows = (f: string) => files[f]!.trim().split('\n').map((l) => JSON.parse(l) as Row)
    return { ...writers, rows }
  }
  const FILE = '/t/-w/s1.jsonl'
  const TAIL = `${JSON.stringify({ type: 'assistant', uuid: 'tail-9', parentUuid: null })}\n`
  const ANSWER = { message: { id: 'msg_1', role: 'assistant', content: [] } }

  it('persistMockTurn files the prompt row under the input uuid, mints one without it, and chains onto an existing transcript', () => {
    const a = loadWriters({})
    a.persistMockTurn('s1', 'hi', ANSWER, '/t', 'in-1')
    a.persistMockTurn('s1', 'again', ANSWER, '/t', null)
    const [u1, a1, u2] = a.rows(FILE)
    expect([u1!.uuid, u1!.parentUuid, a1!.parentUuid]).toEqual(['in-1', null, 'in-1'])
    expect(u2!.uuid, 'no uuid: a new one, never the stale last input').toBe('fresh-2')
    expect(u2!.parentUuid).toBe(a1!.uuid)
    const b = loadWriters({ [FILE]: TAIL })
    b.persistMockTurn('s1', 'resumed', ANSWER, '/t', 'in-2')
    expect(b.rows(FILE)[1]).toMatchObject({ type: 'user', uuid: 'in-2', parentUuid: 'tail-9' })
    expect(() => loadWriters({ [FILE]: '{"type":"assist' }).persistMockTurn('s1', 'x', ANSWER, '/t', 'in-3')).toThrow()
  })

  it('file-edit-turn files its prompt row under the turn\'s input uuid and chains onto an existing transcript', () => {
    const tool = { type: 'assistant', message: { role: 'assistant', content: [] } }
    const a = loadWriters({ [FILE]: TAIL })
    a.fileEditTurn('s1', [tool], 'file-edit-turn:{}', 'in-1')
    const [, u1, r1] = a.rows(FILE)
    expect([u1!.uuid, u1!.parentUuid, r1!.parentUuid]).toEqual(['in-1', 'tail-9', 'in-1'])
    a.fileEditTurn('s1', [tool], 'file-edit-turn:{}', null)
    expect(a.rows(FILE)[3]).toMatchObject({ type: 'user', uuid: 'fresh-2', parentUuid: r1!.uuid })
  })

  it('a plain turn files its rows once: in the persisted transcript when it has one, else in the transcript dir', () => {
    const both = { MOCK_CLAUDE_PERSIST_DIR: '/t', MOCK_CLAUDE_TRANSCRIPT_DIR: '/t', MOCK_CLAUDE_PERSIST_SESSIONS: 's1' }
    const a = loadWriters({ [FILE]: TAIL }, both, 'in-1')
    a.plainTurn('s1', 'hi', ANSWER, 'in-1')
    expect(a.rows(FILE).map((r) => [r.type, r.uuid === 'in-1' ? 'in-1' : r.parentUuid === 'in-1' ? 'after' : r.uuid]))
      .toEqual([['assistant', 'tail-9'], ['user', 'in-1'], ['assistant', 'after']])
    const b = loadWriters({}, { MOCK_CLAUDE_PERSIST_DIR: '/t', MOCK_CLAUDE_TRANSCRIPT_DIR: '/t' }, 'in-1')
    b.plainTurn('s1', 'hi', ANSWER, 'in-1')
    expect(b.rows(FILE).map((r) => [r.type, r.uuid === 'in-1' ? 'in-1' : r.parentUuid])).toEqual([['user', 'in-1'], ['assistant', 'in-1']])
  })

  it('every persistMockTurn call passes the turn\'s turnInputUuid explicitly', () => {
    const calls = [...MOCK_SRC.matchAll(/(?<!function )\bpersistMockTurn\(/g)].map((m) => {
      let depth = 0
      for (let i = m.index! + 'persistMockTurn'.length; i < MOCK_SRC.length; i++) {
        if (MOCK_SRC[i] === '(') depth++
        else if (MOCK_SRC[i] === ')' && --depth === 0) return { line: MOCK_SRC.slice(0, m.index).split('\n').length, args: MOCK_SRC.slice(m.index, i) }
      }
      throw new Error('unclosed persistMockTurn call')
    })
    expect(calls.length).toBeGreaterThanOrEqual(5)
    expect(calls.filter((c) => !/,\s*turnInputUuid\s*$/.test(c.args)).map((c) => `mock-claude.mjs:${c.line}`),
      'pass turnInputUuid as the last argument').toEqual([])
  })
})
