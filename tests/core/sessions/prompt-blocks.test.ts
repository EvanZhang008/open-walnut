/**
 * The cap of an always-loaded prompt block (prompt-blocks.ts), the memory folder a `list`
 * block's rest goes to (memory-folder.ts), and what a running session spawned before the caps
 * is told (instruction-notice.ts through promptDebtBytes).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-prompt-blocks'))
process.env.WALNUT_FLEET_PROMPT_REFRESH = '0'
import { WALNUT_HOME } from '../../../src/constants.js'
import {
  POINTER_OPENING, PROMPT_BLOCKS, PromptComposer, capBlock, charLength, promptBlock, pointerLine,
} from '../../../src/core/sessions/prompt-blocks.js'
import {
  MemoryFolderError, WALNUT_FILE_KEEP_MS, listMemoryFiles, memoryFolderOf, ownNotesIndexLine, readMemoryFile,
  removeMemoryFolder, writeOverflows, writeOwnNote, type MemoryFileInfo,
} from '../../../src/core/sessions/memory-folder.js'
import { composeInstructions, defaultInstructions } from '../../../src/core/sessions/session-context.js'
import { promptDebtBytes } from '../../../src/core/sessions/prompt-refresh.js'
import { FIXTURE_TASKS, seedFixtureHome } from '../../helpers/prompt-size-fixture.js'

const para = (n: number, words: string) => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} says ${words}.`).join(' ')

describe('capBlock', () => {
  it('leaves a block within its cap exactly as it is', () => {
    const text = 'A short line.\n\n'
    expect(capBlock('fleet', text)).toEqual({ text, overflow: null })
  })

  it('a list block over its cap keeps its head, cut at a sentence, and points to the rest, within the cap', () => {
    const text = `${para(200, 'one more machine')}\n\n`
    const { text: out, overflow } = capBlock('fleet', text)
    expect(charLength(out)).toBeLessThanOrEqual(promptBlock('fleet').cap)
    expect(out.endsWith('\n\n')).toBe(true)
    const [head, pointer] = out.trimEnd().split('\n')
    expect(head).toMatch(/^Sentence 1 says .*\.$/)
    expect(pointer!.startsWith(POINTER_OPENING)).toBe(true)
    expect(pointer).toContain(`agent_memory_read {"file":"${overflow!.file}"}`)
    expect(overflow!.file).toMatch(/^fleet\.[0-9a-f]{8}\.md$/)
    expect(pointer).toContain(`${overflow!.chars.toLocaleString('en-US')} characters`)
    // Nothing lost: the head and the rest are the whole text.
    expect(`${head} ${overflow!.text}`).toBe(text.trim())
    expect(overflow).toMatchObject({ id: 'fleet', part: 'context' })
  })

  it('cuts at a line or paragraph when one fits, and names the headings it moved', () => {
    const text = `## First\n\n${para(4, 'one')}\n\n## Second part\n\n${para(300, 'two')}\n\n## Third\n\n${para(5, 'three')}\n\n`
    const { text: out, overflow } = capBlock('standing-memory', text)
    expect(out.startsWith('## First\n\nSentence 1 says one.')).toBe(true)
    expect(overflow!.text).toContain('## Third')
    expect(out).toContain('Third')
  })

  it('measures characters, so text in a three-byte script has the same room as ASCII', () => {
    const wide = String.fromCodePoint(0x4e2d).repeat(promptBlock('fleet').cap - 2) + '\n\n'
    expect(Buffer.byteLength(wide, 'utf8')).toBeGreaterThan(promptBlock('fleet').cap)
    expect(capBlock('fleet', wide).overflow).toBeNull()
  })

  it('never cuts a rule block or the user\'s words, however long', () => {
    for (const def of PROMPT_BLOCKS.filter((d) => d.kind !== 'list')) {
      const text = `${para(Math.ceil(def.cap / 20), 'a rule that applies in every turn')}\n\n`
      expect(capBlock(def.id, text), def.id).toEqual({ text, overflow: null })
    }
  })

  it('refuses a block with no registry entry', () => {
    expect(() => capBlock('no-such-block', 'x')).toThrow(/no entry in PROMPT_BLOCKS/)
    expect(() => new PromptComposer().add('no-such-block', '')).toThrow(/no entry/)
  })

  it('the pointer is the same for the same text (the default instructions stay deterministic)', () => {
    const rest = para(10, 'more')
    expect(pointerLine(promptBlock('skills-index'), rest)).toBe(pointerLine(promptBlock('skills-index'), rest))
    const text = `${para(800, 'skills')}\n\n`
    expect(capBlock('skills-index', text)).toEqual(capBlock('skills-index', text))
  })
})

describe('memory folder', () => {
  beforeEach(async () => { await fs.rm(path.join(WALNUT_HOME, 'agent-memory'), { recursive: true, force: true }) })

  const overflow = (id: string, text: string) => ({ id, file: `${id}.md`, title: promptBlock(id).title, part: promptBlock(id).part, text, chars: charLength(text) })
  const age = async (taskId: string | null, name: string, ms: number) => {
    const when = new Date(Date.now() - ms)
    await fs.utimes(path.join(memoryFolderOf(taskId), name), when, when)
  }

  it('writes what a cap moved, reads it back, keeps it a week after no pointer names it, then removes it', async () => {
    await writeOverflows('t1', 'context', [overflow('fleet', 'The rest of the machines.')])
    const read = await readMemoryFile('t1', 'fleet.md')
    expect(read).toMatchObject({ name: 'fleet.md', walnut: true, shared: false })
    expect(read.text).toContain('# Your machines')
    expect(read.text).toContain('The rest of the machines.')
    // The persona half's write never removes the context half's file.
    await writeOverflows('t1', 'persona', [])
    expect((await listMemoryFiles('t1')).map((f) => f.name)).toEqual(['fleet.md'])
    // A running session still holds the pointer: the file stays after the block fits again...
    await writeOverflows('t1', 'context', [])
    expect((await listMemoryFiles('t1')).map((f) => f.name)).toEqual(['fleet.md'])
    // ...until a week has passed with no prompt naming it.
    await age('t1', 'fleet.md', WALNUT_FILE_KEEP_MS + 60_000)
    await writeOverflows('t1', 'context', [])
    expect(await listMemoryFiles('t1')).toEqual([])
  })

  it('a file a new prompt still names is touched at each write, so the sweep never takes it', async () => {
    await writeOverflows('t1b', 'context', [overflow('fleet', 'Machines.')])
    await age('t1b', 'fleet.md', WALNUT_FILE_KEEP_MS + 60_000)
    await writeOverflows('t1b', 'context', [overflow('fleet', 'Machines.')])
    await writeOverflows('t1b', 'context', [])
    expect((await listMemoryFiles('t1b')).map((f) => f.name)).toEqual(['fleet.md'])
  })

  it('a task reads the shared folder when its own has no such file', async () => {
    await writeOverflows(null, 'persona', [overflow('standing-memory', '## Later rule\n\nIt applies.')])
    expect(await readMemoryFile('t2', 'standing-memory.md')).toMatchObject({ shared: true, walnut: true })
    expect((await listMemoryFiles('t2')).map((f) => [f.name, f.shared])).toEqual([['standing-memory.md', true]])
    await expect(readMemoryFile('t2', 'nothing.md')).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })

  it('a pointer to a version of a block that is gone reads the block\'s current file, and says so', async () => {
    const now = capBlock('skills-index', `${para(800, 'skill now')}\n\n`).overflow!
    await writeOverflows(null, 'persona', [now])
    const gone = 'skills-index.0badc0de.md'
    const read = await readMemoryFile('t5', gone)
    expect(read).toMatchObject({ name: now.file, replaces: gone, walnut: true })
    expect(read.text).toContain('skill now')
    // From the regenerated current text when nothing of the block is on disk yet.
    const fleet = capBlock('fleet', `${para(200, 'machine now')}\n\n`).overflow!
    const viaRegen = await readMemoryFile('t5', 'fleet.12345678.md', { regenerate: async () => [fleet] })
    expect(viaRegen).toMatchObject({ name: fleet.file, replaces: 'fleet.12345678.md' })
    expect(viaRegen.text).toContain('machine now')
  })

  it('a node writes its own notes, never Walnut\'s files, within the limits', async () => {
    expect(await writeOwnNote('t3', 'release-steps.md', 'Step one.')).toMatchObject({ name: 'release-steps.md', removed: false, count: 1 })
    expect((await readMemoryFile('t3', 'release-steps.md')).text).toBe('Step one.\n')
    await expect(writeOwnNote('t3', 'fleet.md', 'mine')).rejects.toMatchObject({ code: 'walnut_file', status: 409 })
    await expect(writeOwnNote('t3', 'Bad Name.md', 'x')).rejects.toBeInstanceOf(MemoryFolderError)
    await expect(writeOwnNote('t3', 'big.md', 'x'.repeat(20_001))).rejects.toMatchObject({ code: 'note_too_long' })
    for (let i = 1; i < 20; i++) await writeOwnNote('t3', `n${i}.md`, 'x')
    await expect(writeOwnNote('t3', 'one-more.md', 'x')).rejects.toMatchObject({ code: 'too_many_notes' })
    expect(await writeOwnNote('t3', 'n1.md', '')).toMatchObject({ removed: true })
    expect(ownNotesIndexLine(await listMemoryFiles('t3'))).toMatch(/^Your memory folder holds your own notes: n10\.md/)
    expect(() => memoryFolderOf('../escape')).toThrow(MemoryFolderError)
  })

  it('the index of a node\'s own notes fits its cap at the most notes with the longest names', () => {
    const files: MemoryFileInfo[] = Array.from({ length: 20 }, (_, i) => ({
      name: `${String(i).padStart(2, '0')}${'n'.repeat(60)}.md`, bytes: 19_999, at: '', walnut: false, shared: false,
    }))
    expect(files[0]!.name.length).toBe(65)
    expect(charLength(ownNotesIndexLine(files))).toBeLessThanOrEqual(promptBlock('own-notes').cap)
  })

  it('deleting a task removes its folder, never the shared one', async () => {
    await writeOwnNote('t6', 'a.md', 'x')
    await writeOverflows(null, 'persona', [overflow('standing-memory', 'Shared.')])
    await removeMemoryFolder('t6')
    expect(await listMemoryFiles('t6')).toEqual([expect.objectContaining({ name: 'standing-memory.md', shared: true })])
    await removeMemoryFolder('_shared')
    expect((await listMemoryFiles(null)).length).toBe(1)
  })

  it('a stale pointer of one console agent never reads another agent\'s file of the same block', async () => {
    const mentor = capBlock('agent-context', `${para(400, 'mentor context')}\n\n`, 'mentor').overflow!
    const other = capBlock('agent-context', `${para(400, 'reviewer context')}\n\n`, 'reviewer').overflow!
    expect(mentor.file).toMatch(/^agent-context--mentor\.[0-9a-f]{8}\.md$/)
    await writeOverflows(null, 'persona', [mentor, other])
    const read = await readMemoryFile('t7', 'agent-context--mentor.0badc0de.md')
    expect(read).toMatchObject({ name: mentor.file, replaces: 'agent-context--mentor.0badc0de.md' })
    expect(read.text).toContain('mentor context')
    await expect(readMemoryFile('t7', 'agent-context--nobody.0badc0de.md')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a persona file is never composed for: regenerate runs only for a block of the session context', async () => {
    let calls = 0
    const regenerate = async () => { calls += 1; return [] }
    await expect(readMemoryFile('t8', 'skills-index--general.12345678.md', { regenerate })).rejects.toMatchObject({ code: 'not_found' })
    expect(calls).toBe(0)
    await expect(readMemoryFile('t8', 'fleet.12345678.md', { regenerate })).rejects.toMatchObject({ code: 'not_found' })
    expect(calls).toBe(1)
  })

  it('writes of notes at once never pass the 20-note limit', async () => {
    const results = await Promise.allSettled(Array.from({ length: 26 }, (_, i) => writeOwnNote('t9', `n${i}.md`, 'x')))
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(20)
    expect((await listMemoryFiles('t9')).filter((f) => !f.walnut && !f.shared).length).toBe(20)
  })

  it('every delete path takes the task\'s folder with it (deleteTask, deleteTasksByIds the test-run sweep uses, deleteTasksBulk)', async () => {
    const tm = await import('../../../src/core/task-manager.js')
    const made = await Promise.all(['one', 'two', 'three'].map((t) => tm.addTask({ title: `Folder ${t}`, project: 'Acme' } as never)))
    const ids = made.map((m) => m.task.id)
    for (const id of ids) await writeOwnNote(id, 'plan.md', 'x')
    const gone = async (id: string) => (await fs.stat(memoryFolderOf(id)).catch(() => null)) === null
    await tm.deleteTask(ids[0]!)
    await tm.deleteTasksByIds([ids[1]!], { force: true })
    await tm.deleteTasksBulk([ids[2]!])
    for (const id of ids) expect(await gone(id), id).toBe(true)
  })

  it('a file a pointer names before its session started again is written from the current text on its first read', async () => {
    const task = { id: 't-regen', project: 'Product' }
    const c = composeInstructions(task, { taskLine: '', taskDir: '', fleet: `${para(200, 'host')}\n\n` })
    const fleet = c.overflows.find((o) => o.id === 'fleet')!
    await expect(readMemoryFile('t-regen', fleet.file)).rejects.toMatchObject({ code: 'not_found' })
    const read = await readMemoryFile('t-regen', fleet.file, { regenerate: async () => c.overflows })
    expect(read.text).toContain(fleet.text)
  })

  it('the shared folder keeps another agent\'s or variant\'s files: each name carries its text\'s hash', async () => {
    const a = capBlock('standing-memory', `${para(400, 'memory A')}\n\n`).overflow!
    const b = capBlock('standing-memory', `${para(400, 'memory B')}\n\n`).overflow!
    expect(a.file).not.toBe(b.file)
    await writeOverflows(null, 'persona', [a])
    await writeOverflows(null, 'persona', [b])
    expect((await listMemoryFiles(null)).map((f) => f.name).sort()).toEqual([a.file, b.file].sort())
  })
})

describe('the standing memory', () => {
  it('a long MEMORY.md moves to the folder, never the user\'s profile beside it', async () => {
    const { personalAiPersona } = await import('../../../src/core/sessions/profiles.js')
    const { laneMemoryContextOf } = await import('../../../src/core/sessions/personal-ai-lane.js')
    const user = `## Identity\n\n${para(60, 'who the user is')}`
    const memory = `## Rules\n\n${para(400, 'a standing rule')}`
    const p = personalAiPersona('Avery', '', laneMemoryContextOf(memory, user))
    expect(p.systemPrompt).toContain(user)
    expect(p.overflows.map((o) => o.id)).toEqual(['standing-memory'])
  })

  it('a USER.md longer than its cap stays whole: the user\'s words are never cut', async () => {
    const { personalAiPersona } = await import('../../../src/core/sessions/profiles.js')
    const { laneMemoryContextOf } = await import('../../../src/core/sessions/personal-ai-lane.js')
    const user = `## Identity\n\n${para(400, 'who the user is')}`
    expect(user.length).toBeGreaterThan(promptBlock('standing-user').cap)
    const p = personalAiPersona('Avery', '', laneMemoryContextOf('', user))
    expect(p.systemPrompt).toContain(user)
    expect(p.overflows).toEqual([])
  })
})

describe('a running session spawned before the caps', () => {
  beforeAll(async () => { await seedFixtureHome(WALNUT_HOME) })

  const before = (role: keyof typeof FIXTURE_TASKS): string => {
    process.env.WALNUT_PROMPT_CAPS = '0'
    try { return composeInstructions(FIXTURE_TASKS[role] as never, { taskLine: '', taskDir: '', fleet: '' }).text() } finally {
      delete process.env.WALNUT_PROMPT_CAPS
    }
  }

  for (const role of ['main', 'lead', 'worker', 'ask'] as const) {
    it(`${role}: is told nothing, its session context is the one it holds`, () => {
      const task = FIXTURE_TASKS[role] as never
      expect(defaultInstructions(task)).toBe(before(role))
      expect(promptDebtBytes({ appliedAppendSystemPrompt: before(role) }, task)).toBe(0)
    })
  }
})

describe('an id that is no task id never costs a session its context', () => {
  // clock-placement.ts builds a routine's context for its placeholder before the run has a task.
  const TOKEN = '__WALNUT_ROUTINE_TASK_ID__'

  it('lists the shared files alone, and the session context builds', async () => {
    await writeOverflows(null, 'persona', [{ id: 'standing-memory', file: 'standing-memory.md', title: 'x', part: 'persona', text: 'Shared.', chars: 7 }])
    const files = await listMemoryFiles(TOKEN)
    expect(files.map((f) => f.name)).toContain('standing-memory.md')
    expect(files.every((f) => f.shared)).toBe(true)
    await writeOverflows(TOKEN, 'context', [])
    const { buildSessionContext } = await import('../../../src/core/sessions/session-context.js')
    const now = new Date().toISOString()
    const task = { id: TOKEN, title: 'Daily digest', project: 'Routines', phase: 'TODO', created_at: now, updated_at: now } as never
    const ctx = await buildSessionContext(TOKEN, undefined, undefined, { task })
    expect(ctx.systemPrompt).toContain('Daily digest')
  })
})
