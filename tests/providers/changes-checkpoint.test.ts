import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeHostLocalChanges, encodeProjectPathCore } from '../../src/providers/session-changes-core.js'
import { CHANGES_CHECKPOINT_MAX_BYTES, loadChangesCheckpoint, saveChangesCheckpoint } from '../../src/providers/changes-checkpoint.js'

let root: string
let repo: string
let claudeHome: string
let transcript: string
let checkpointDir: string
const line = (value: unknown) => JSON.stringify(value) + '\n'
const write = (name: string, content: string) => line({ type: 'assistant', cwd: repo,
  message: { content: [{ type: 'tool_use', id: `write-${name}`, name: 'Write', input: { file_path: path.join(repo, name), content } }] } })
const compute = () => computeHostLocalChanges({ sessionId: 'checkpoint-sid', cwd: repo, claudeHome, checkpointDir, mainParse: {} })

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-checkpoint-'))
  repo = path.join(root, 'repo')
  claudeHome = path.join(root, 'claude')
  checkpointDir = path.join(root, 'checkpoints')
  const project = path.join(claudeHome, 'projects', encodeProjectPathCore(repo))
  await fs.mkdir(project, { recursive: true }); await fs.mkdir(repo)
  execFileSync('git', ['init', '-q', repo])
  transcript = path.join(project, 'checkpoint-sid.jsonl')
  await fs.writeFile(transcript, write('a.ts', 'first\n'))
  await fs.writeFile(path.join(repo, 'a.ts'), 'first\n')
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('disposable Changed parse checkpoints', () => {
  it('a new parser holder resumes appended bytes and still reads current file contents', async () => {
    const first = await compute()
    expect(first?.parseStats.resumed).toBe(false)
    const append = write('b.ts', 'second\n')
    await fs.appendFile(transcript, append); await fs.writeFile(path.join(repo, 'b.ts'), 'second\n')
    const second = await compute()
    expect(second?.parseStats).toEqual({ resumed: true, readBytes: Buffer.byteLength(append) })
    expect(second?.result.fileCount).toBe(2)
    await fs.writeFile(path.join(repo, 'b.ts'), 'edited outside session\n')
    const changed = await compute()
    // A new holder resumes the last durable megabyte boundary, not an unsaved small append.
    expect(changed?.parseStats).toEqual({ resumed: true, readBytes: Buffer.byteLength(append) })
    expect(changed?.result.groups.flatMap(g => g.files).find(f => f.relPath === 'b.ts')?.after).toBe('edited outside session\n')
  })

  it.each(['truncated', 'replaced', 'rewritten'] as const)('%s transcripts reject the old checkpoint and recompute', async kind => {
    await compute()
    const next = write('z.ts', 'replacement\n')
    if (kind === 'replaced') { await fs.unlink(transcript); await fs.writeFile(transcript, next) }
    else if (kind === 'rewritten') { await fs.writeFile(transcript, next + line({ type: 'assistant', message: { content: 'padding'.repeat(100) } })) }
    else await fs.writeFile(transcript, next.slice(0, next.length - 1))
    await fs.writeFile(path.join(repo, 'z.ts'), 'replacement\n')
    const result = await compute()
    expect(result?.parseStats.resumed).toBe(false)
    expect(result?.result.groups.flatMap(g => g.files).map(f => f.relPath)).toEqual(['z.ts'])
  })

  it('corrupt or oversized cache files degrade to a cold parse without touching the transcript', async () => {
    await compute()
    const file = path.join(checkpointDir, (await fs.readdir(checkpointDir))[0]!)
    const original = await fs.readFile(transcript, 'utf8')
    await fs.writeFile(file, 'broken checkpoint')
    expect(await loadChangesCheckpoint(checkpointDir, transcript, 'changes-parser-1')).toBeUndefined()
    expect((await compute())?.parseStats.resumed).toBe(false)
    const handle = await fs.open(file, 'w'); await handle.truncate(CHANGES_CHECKPOINT_MAX_BYTES + 1); await handle.close()
    expect(await loadChangesCheckpoint(checkpointDir, transcript, 'changes-parser-1')).toBeUndefined()
    expect((await compute())?.parseStats.resumed).toBe(false)
    expect(await fs.readFile(transcript, 'utf8')).toBe(original)
  })

  it('parser upgrades and explicit refresh bypass checkpoints', async () => {
    await compute()
    const upgraded = await computeHostLocalChanges({ sessionId: 'checkpoint-sid', cwd: repo, claudeHome, checkpointDir, checkpointVersion: 'parser-next', mainParse: {} })
    expect(upgraded?.parseStats.resumed).toBe(false)
    const refreshed = await computeHostLocalChanges({ sessionId: 'checkpoint-sid', cwd: repo, claudeHome, checkpointDir, checkpointVersion: 'parser-next', reparse: true, mainParse: {} })
    expect(refreshed?.parseStats.resumed).toBe(false)
  })

  it('finished subagents survive restart but a rewritten subagent invalidates its saved parse', async () => {
    const subDir = transcript.replace(/\.jsonl$/, '') + '/subagents'
    await fs.mkdir(subDir, { recursive: true })
    const sub = path.join(subDir, 'agent-child.jsonl')
    const content = write('b.ts', 'subagent\n')
    await fs.writeFile(sub, content); await fs.writeFile(path.join(repo, 'b.ts'), 'subagent\n')
    const first = await compute()
    expect(first?.parseStats.subReadBytes).toBe(Buffer.byteLength(content))
    const restored = await compute()
    expect(restored?.parseStats).toMatchObject({ resumed: true, readBytes: 0, subReadBytes: 0 })
    expect(restored?.result.fileCount).toBe(2)
    await fs.writeFile(sub, write('c.ts', 'subagent\n')); await fs.writeFile(path.join(repo, 'c.ts'), 'subagent\n')
    const rewritten = await compute()
    expect(rewritten?.parseStats.subReadBytes).toBeGreaterThan(0)
    expect(rewritten?.result.groups.flatMap(g => g.files).map(f => f.relPath).sort()).toEqual(['a.ts', 'c.ts'])
  })

  it('disk-only callers keep trailing and subagent operations out of main checkpoints', async () => {
    const subDir = transcript.replace(/\.jsonl$/, '') + '/subagents'
    await fs.mkdir(subDir, { recursive: true })
    await fs.writeFile(path.join(subDir, 'agent-child.jsonl'), write('b.ts', 'child\n'))
    await fs.writeFile(path.join(repo, 'b.ts'), 'child\n')
    const trailing = write('c.ts', 'partial\n').trimEnd()
    await fs.appendFile(transcript, trailing)
    await fs.writeFile(path.join(repo, 'c.ts'), 'partial\n')
    const diskOnly = () => computeHostLocalChanges({ sessionId: 'checkpoint-sid', cwd: repo, claudeHome, checkpointDir })
    const first = await diskOnly()
    const saved = await loadChangesCheckpoint(checkpointDir, transcript, 'changes-parser-1')
    expect([...saved!.fileMap.keys()]).toEqual([path.join(repo, 'a.ts')])
    expect(first?.fileMap.get(path.join(repo, 'b.ts'))?.ops).toHaveLength(1)
    await fs.appendFile(transcript, '\n')
    for (let i = 0; i < 3; i++) {
      const restored = await diskOnly()
      expect(restored?.parseStats.resumed).toBe(true)
      expect(restored?.fileMap.get(path.join(repo, 'b.ts'))?.ops).toHaveLength(1)
      expect(restored?.fileMap.get(path.join(repo, 'c.ts'))?.ops).toHaveLength(1)
      expect(restored?.result).toEqual(first?.result)
    }
  })

  it('an unwritable cache never fails a Changed read', async () => {
    await fs.writeFile(checkpointDir, 'not a directory')
    expect((await compute())?.result.fileCount).toBe(1)
  })

  it('keeps at most 64 checkpoints and removes only its own abandoned temp files', async () => {
    const state = { epoch: 'epoch', offset: 100, tail: 'tail', headBlock: '', fileMap: new Map() }
    await fs.mkdir(checkpointDir)
    const owned = path.join(checkpointDir, 'a'.repeat(64) + '.bin.00000000-0000-0000-0000-000000000000.tmp')
    const other = path.join(checkpointDir, 'keep-user-file.tmp')
    await fs.writeFile(owned, 'stale'); await fs.writeFile(other, 'not ours')
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    await fs.utimes(owned, old, old)
    for (let i = 0; i < 70; i++) await saveChangesCheckpoint(checkpointDir, `/fixture/session-${i}.jsonl`, state, 'parser')
    const names = await fs.readdir(checkpointDir)
    expect(names.filter(name => name.endsWith('.bin'))).toHaveLength(64)
    expect(names).not.toContain(path.basename(owned))
    expect(await fs.readFile(other, 'utf8')).toBe('not ours')
  })

  it('a partial line is completed after restart rather than checkpointed as complete', async () => {
    const next = write('b.ts', 'second\n')
    await fs.appendFile(transcript, next.slice(0, 40))
    await compute()
    await fs.appendFile(transcript, next.slice(40)); await fs.writeFile(path.join(repo, 'b.ts'), 'second\n')
    const result = await compute()
    expect(result?.parseStats).toEqual({ resumed: true, readBytes: Buffer.byteLength(next) })
    expect(result?.result.fileCount).toBe(2)
  })
})
