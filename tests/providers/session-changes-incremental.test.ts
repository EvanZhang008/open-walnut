/**
 * computeHostLocalChanges continues the main transcript parse from where the
 * previous compute stopped (MainParseState) instead of re-reading the file.
 *
 * Why: every append changes a live transcript's mtime, so each compute re-parsed
 * the whole file; on 2026-09-29 a 907 MB transcript was re-parsed every ~5
 * minutes (11-35 s each) and the daemon's heap spiked to 8 GB. A continued
 * compute must equal a full parse of the same file, and any way the file can
 * stop matching the saved state must read as "parse from byte 0".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  computeHostLocalChanges,
  encodeProjectPathCore,
  type MainParseState,
} from '../../src/providers/session-changes-core.js'

const SID = 'incremental-sid'
let root = ''
let repo = ''
let claudeHome = ''
let transcript = ''

const line = (o: unknown) => JSON.stringify(o) + '\n'
const user = () => line({ type: 'user', cwd: repo, message: { role: 'user', content: 'go' } })
const tool = (name: string, input: Record<string, unknown>) =>
  line({ type: 'assistant', cwd: repo, message: { content: [{ type: 'tool_use', name, input }] } })
const write = (rel: string, content: string) => tool('Write', { file_path: path.join(repo, rel), content })
const edit = (rel: string, oldString: string, newString: string) =>
  tool('Edit', { file_path: path.join(repo, rel), old_string: oldString, new_string: newString })
const bash = (command: string) => tool('Bash', { command })
/** ~1.2 MB of chat that crosses the parser's 1 MB window. */
const filler = () => line({ type: 'assistant', cwd: repo, message: { content: [{ type: 'text', text: 'x'.repeat(1200) }] } }).repeat(1000)

function disk(rel: string, content: string | null): void {
  const p = path.join(repo, rel)
  if (content === null) fs.rmSync(p, { force: true })
  else fs.writeFileSync(p, content)
}

const compute = (mainParse?: { state?: MainParseState }, deadlineMs?: number) =>
  computeHostLocalChanges({ sessionId: SID, cwd: repo, claudeHome, mainParse, deadlineMs })

/** A full parse of the file as it is now: the answer a continued compute must match. */
async function fresh() {
  return (await compute())!.result
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-inc-')))
  repo = path.join(root, 'repo')
  claudeHome = path.join(root, 'claude')
  fs.mkdirSync(repo, { recursive: true })
  const projectDir = path.join(claudeHome, 'projects', encodeProjectPathCore(repo))
  fs.mkdirSync(projectDir, { recursive: true })
  transcript = path.join(projectDir, `${SID}.jsonl`)
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('changes compute continues from where the last one stopped', () => {
  it('equals a full parse after appends, renames and subagent work', async () => {
    fs.writeFileSync(transcript, user() + write('a.ts', 'a1\n') + filler() + edit('a.ts', 'a1', 'a2') + write('b.ts', 'b1\n'))
    disk('a.ts', 'a2\n'); disk('b.ts', 'b1\n')
    const holder: { state?: MainParseState } = {}
    const first = await compute(holder)
    expect(first!.result).toEqual(await fresh())
    expect(holder.state!.offset).toBe(fs.statSync(transcript).size)

    // A subagent edits a.ts; its ops are merged into THIS compute only.
    const subDir = transcript.replace(/\.jsonl$/, '') + '/subagents'
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), edit('a.ts', 'a2', 'a3'))
    disk('a.ts', 'a3\n')

    // The main transcript grows: a rename of b.ts, an edit after the window, a new file.
    fs.appendFileSync(transcript, bash(`mv ${path.join(repo, 'b.ts')} ${path.join(repo, 'c.ts')}`)
      + filler() + edit('a.ts', 'a3', 'a4') + write('d.ts', 'd1\n'))
    disk('b.ts', null); disk('c.ts', 'b1\n'); disk('a.ts', 'a4\n'); disk('d.ts', 'd1\n')
    const before = holder.state!.offset
    const second = await compute(holder)
    expect(holder.state!.offset).toBeGreaterThan(before)
    expect(second!.result).toEqual(await fresh())

    // And again with no change at all: still equal, nothing duplicated.
    expect((await compute(holder))!.result).toEqual(await fresh())
    expect(holder.state!.fileMap.get(path.join(repo, 'a.ts'))!.ops).toHaveLength(3) // write, edit, edit (subagent excluded)
  })

  it('reads only the appended bytes (an early line erased in place is not re-read)', async () => {
    const early = write('early.ts', 'e1\n')
    fs.writeFileSync(transcript, user() + early + filler())
    disk('early.ts', 'e1\n')
    const holder: { state?: MainParseState } = {}
    await compute(holder)

    // Erase the early Write in place far from the tail: the saved state still
    // matches, so a continued compute keeps it; a full parse no longer sees it.
    const text = fs.readFileSync(transcript, 'utf8')
    const at = Buffer.byteLength(text.slice(0, text.indexOf(early)))
    const pad = JSON.stringify({ type: 'x', pad: '' })
    const blank = JSON.stringify({ type: 'x', pad: ' '.repeat(Buffer.byteLength(early) - pad.length - 1) }) + '\n'
    expect(Buffer.byteLength(blank)).toBe(Buffer.byteLength(early))
    const fd = fs.openSync(transcript, 'r+'); fs.writeSync(fd, blank, at); fs.closeSync(fd)
    fs.appendFileSync(transcript, write('late.ts', 'l1\n'))
    disk('late.ts', 'l1\n')

    const paths = (r: Awaited<ReturnType<typeof fresh>>) => r.groups.flatMap((g) => g.files.map((f) => f.relPath)).sort()
    expect(paths((await compute(holder))!.result)).toEqual(['early.ts', 'late.ts'])
    expect(paths(await fresh())).toEqual(['late.ts'])
  })

  it('starts over when the bytes before the saved offset changed, or the file was recreated', async () => {
    fs.writeFileSync(transcript, user() + write('a.ts', 'a1\n') + filler() + write('b.ts', 'b1\n'))
    disk('a.ts', 'a1\n'); disk('b.ts', 'b1\n')
    const holder: { state?: MainParseState } = {}
    await compute(holder)

    // Rewrite the tail region the state hashed: must fall back to a full parse.
    const size = fs.statSync(transcript).size
    const fd = fs.openSync(transcript, 'r+'); fs.writeSync(fd, 'Z', size - 10); fs.closeSync(fd)
    expect((await compute(holder))!.result).toEqual(await fresh())

    // Recreated with different content (new inode): full parse, no stale ops.
    fs.rmSync(transcript); fs.writeFileSync(transcript, user() + write('only.ts', 'o1\n'))
    disk('only.ts', 'o1\n')
    expect((await compute(holder))!.result).toEqual(await fresh())
    expect(holder.state!.fileMap.has(path.join(repo, 'a.ts'))).toBe(false)
  })

  it('a line still being written is parsed for this answer but not saved, so it is never counted twice', async () => {
    const complete = user() + write('a.ts', 'a1\n')
    // Last line complete but its newline not yet written.
    fs.writeFileSync(transcript, complete + edit('a.ts', 'a1', 'a2').slice(0, -1))
    disk('a.ts', 'a2\n')
    const holder: { state?: MainParseState } = {}
    expect((await compute(holder))!.result).toEqual(await fresh())
    expect(holder.state!.offset).toBe(Buffer.byteLength(complete))

    // Its newline lands, then a torn line, then the rest of that line.
    const next = edit('a.ts', 'a2', 'a3')
    fs.appendFileSync(transcript, '\n' + next.slice(0, 40))
    disk('a.ts', 'a3\n')
    expect((await compute(holder))!.result).toEqual(await fresh())
    fs.appendFileSync(transcript, next.slice(40))
    expect((await compute(holder))!.result).toEqual(await fresh())
    expect(holder.state!.fileMap.get(path.join(repo, 'a.ts'))!.ops).toHaveLength(3)
  })

  it('a compute that fails before it finishes leaves the saved state as it was', async () => {
    fs.writeFileSync(transcript, user() + write('a.ts', 'a1\n'))
    disk('a.ts', 'a1\n')
    const holder: { state?: MainParseState } = {}
    await compute(holder)
    const saved = holder.state
    fs.appendFileSync(transcript, filler() + edit('a.ts', 'a1', 'a2'))
    disk('a.ts', 'a2\n')
    await expect(compute(holder, -1000)).rejects.toThrow(/deadline/)
    expect(holder.state).toBe(saved)
    expect((await compute(holder))!.result).toEqual(await fresh())
  })
})
