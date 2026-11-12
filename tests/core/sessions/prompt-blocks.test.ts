/**
 * The cap of an always-loaded prompt block (prompt-blocks.ts), the memory folder its rest goes
 * to (memory-folder.ts), and what a running session spawned before the caps is told
 * (instruction-diff.ts: a cut head of a line it holds whole is no change).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-prompt-blocks'))
process.env.WALNUT_FLEET_PROMPT_REFRESH = '0'
import { WALNUT_HOME } from '../../../src/constants.js'
import { POINTER_OPENING, PromptComposer, byteLength, capBlock, promptBlock, pointerLine } from '../../../src/core/sessions/prompt-blocks.js'
import {
  MemoryFolderError, listMemoryFiles, memoryFolderOf, ownNotesIndexLine, readMemoryFile, writeOverflows, writeOwnNote,
} from '../../../src/core/sessions/memory-folder.js'
import { composeInstructions, defaultInstructions } from '../../../src/core/sessions/session-context.js'
import { promptDebtBytes } from '../../../src/core/sessions/prompt-refresh.js'
import { FIXTURE_TASKS, seedFixtureHome } from '../../helpers/prompt-size-fixture.js'

const para = (n: number, words: string) => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} says ${words}.`).join(' ')

describe('capBlock', () => {
  it('leaves a block within its cap exactly as it is', () => {
    const text = 'A short rule.\n\n'
    expect(capBlock('org-about', text)).toEqual({ text, overflow: null })
  })

  it('keeps the head, cut at a sentence, and points to the rest, within the cap', () => {
    const text = `${para(40, 'what the brief is for')}\n\n`
    const { text: out, overflow } = capBlock('org-brief', text)
    expect(byteLength(out)).toBeLessThanOrEqual(promptBlock('org-brief').cap)
    expect(out.endsWith('\n\n')).toBe(true)
    const [head, pointer] = out.trimEnd().split('\n')
    expect(head).toMatch(/^Sentence 1 says .*\.$/)
    expect(pointer!.startsWith(POINTER_OPENING)).toBe(true)
    expect(pointer).toContain(`agent_memory_read {"file":"${overflow!.file}"}`)
    expect(overflow!.file).toMatch(/^org-brief\.[0-9a-f]{8}\.md$/)
    expect(pointer).toContain(`${overflow!.bytes.toLocaleString('en-US')} bytes`)
    // Nothing lost: the head and the rest are the whole text.
    expect(`${head} ${overflow!.text}`).toBe(text.trim())
    expect(overflow).toMatchObject({ id: 'org-brief', part: 'context' })
  })

  it('cuts at a line or paragraph when one fits, and names the headings it moved', () => {
    const text = `## First\n\n${para(4, 'one')}\n\n## Second part\n\n${para(30, 'two')}\n\n## Third\n\n${para(5, 'three')}\n\n`
    const { text: out, overflow } = capBlock('org-away', text)
    expect(out.startsWith('## First\n\nSentence 1 says one.')).toBe(true)
    expect(overflow!.text.startsWith('## Second part') || overflow!.text.startsWith('Sentence')).toBe(true)
    expect(out).toContain('Third')
  })

  it('never cuts a versioned block: its lines carry versions the notice diffs', () => {
    const text = `[v1] ${para(500, 'a user rule')}\n`
    expect(capBlock('user-profile', text).overflow).toBeNull()
  })

  it('refuses a block with no registry entry', () => {
    expect(() => capBlock('no-such-block', 'x')).toThrow(/no entry in PROMPT_BLOCKS/)
    expect(() => new PromptComposer().add('no-such-block', '')).toThrow(/no entry/)
  })

  it('the pointer is the same for the same text (the default instructions stay deterministic)', () => {
    const rest = para(10, 'more')
    expect(pointerLine(promptBlock('org-threads'), rest)).toBe(pointerLine(promptBlock('org-threads'), rest))
    const text = `${para(80, 'threads')}\n\n`
    expect(capBlock('org-threads', text)).toEqual(capBlock('org-threads', text))
  })
})

describe('memory folder', () => {
  beforeEach(async () => { await fs.rm(path.join(WALNUT_HOME, 'agent-memory'), { recursive: true, force: true }) })

  const overflow = (id: string, text: string) => ({ id, file: `${id}.md`, title: promptBlock(id).title, part: promptBlock(id).part, text, bytes: byteLength(text) })

  it('writes what a cap moved, reads it back, and removes it once the block fits again', async () => {
    await writeOverflows('t1', 'context', [overflow('org-threads', 'The rest of the threads rules.')])
    const read = await readMemoryFile('t1', 'org-threads.md')
    expect(read).toMatchObject({ name: 'org-threads.md', walnut: true, shared: false })
    expect(read.text).toContain('# Your Threads')
    expect(read.text).toContain('The rest of the threads rules.')
    // The persona half's write never removes the context half's file.
    await writeOverflows('t1', 'persona', [])
    expect((await listMemoryFiles('t1')).map((f) => f.name)).toEqual(['org-threads.md'])
    await writeOverflows('t1', 'context', [])
    expect(await listMemoryFiles('t1')).toEqual([])
  })

  it('a task reads the shared folder when its own has no such file', async () => {
    await writeOverflows(null, 'persona', [overflow('standing-memory', '## Later rule\n\nIt applies.')])
    expect(await readMemoryFile('t2', 'standing-memory.md')).toMatchObject({ shared: true, walnut: true })
    expect((await listMemoryFiles('t2')).map((f) => [f.name, f.shared])).toEqual([['standing-memory.md', true]])
    await expect(readMemoryFile('t2', 'nothing.md')).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })

  it('a node writes its own notes, never Walnut\'s files, within the limits', async () => {
    expect(await writeOwnNote('t3', 'release-steps.md', 'Step one.')).toMatchObject({ name: 'release-steps.md', removed: false, count: 1 })
    expect((await readMemoryFile('t3', 'release-steps.md')).text).toBe('Step one.\n')
    await expect(writeOwnNote('t3', 'org-threads.md', 'mine')).rejects.toMatchObject({ code: 'walnut_file', status: 409 })
    await expect(writeOwnNote('t3', 'Bad Name.md', 'x')).rejects.toBeInstanceOf(MemoryFolderError)
    await expect(writeOwnNote('t3', 'big.md', 'x'.repeat(20_001))).rejects.toMatchObject({ code: 'note_too_long' })
    for (let i = 1; i < 20; i++) await writeOwnNote('t3', `n${i}.md`, 'x')
    await expect(writeOwnNote('t3', 'one-more.md', 'x')).rejects.toMatchObject({ code: 'too_many_notes' })
    expect(await writeOwnNote('t3', 'n1.md', '')).toMatchObject({ removed: true })
    expect(ownNotesIndexLine(await listMemoryFiles('t3'))).toMatch(/^Your memory folder holds your own notes: n10\.md/)
    expect(() => memoryFolderOf('../escape')).toThrow(MemoryFolderError)
  })

  it('a lead\'s session context writes its moved manuals into its own folder, each under the name its pointer gives', async () => {
    const { addTask, updateTaskRaw } = await import('../../../src/core/task-manager.js')
    const { buildSessionContext } = await import('../../../src/core/sessions/session-context.js')
    const { task } = await addTask({ title: 'Product VP', project: 'Product' } as never)
    await updateTaskRaw(task.id, () => ({ org_role: 'lead' }))
    const { systemPrompt } = await buildSessionContext(task.id)
    const named = [...systemPrompt.matchAll(/agent_memory_read \{"file":"([^"]+)"\}/g)].map((m) => m[1]!)
    expect(named.map((n) => n.split('.')[0]).sort()).toEqual(['org-away', 'org-brief', 'org-threads'])
    const files = (await listMemoryFiles(task.id)).filter((f) => !f.shared).map((f) => f.name)
    expect(files.sort()).toEqual([...named].sort())
    expect((await readMemoryFile(task.id, named.find((n) => n.startsWith('org-threads'))!)).text).toContain('pending')
  })

  it('a file a pointer names before its session started again is written from the current text on its first read', async () => {
    const task = { id: 't-regen', org_role: 'lead', project: 'Product' }
    const c = composeInstructions(task, { taskLine: '', taskDir: '', fleet: '' })
    const brief = c.overflows.find((o) => o.id === 'org-brief')!
    await expect(readMemoryFile('t-regen', brief.file)).rejects.toMatchObject({ code: 'not_found' })
    const read = await readMemoryFile('t-regen', brief.file, { regenerate: async () => c.overflows })
    expect(read.text).toContain(brief.text)
  })

  it('the shared folder keeps another agent\'s or variant\'s files: each name carries its text\'s hash', async () => {
    const a = capBlock('standing-memory', `${para(200, 'memory A')}\n\n`).overflow!
    const b = capBlock('standing-memory', `${para(200, 'memory B')}\n\n`).overflow!
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
})

describe('a running session spawned before the caps', () => {
  beforeAll(async () => { await seedFixtureHome(WALNUT_HOME) })

  for (const role of ['main', 'lead'] as const) {
    it(`${role}: is told only the pointers and the tool line, never the moved rules again`, () => {
      const task = FIXTURE_TASKS[role] as never
      const before = composeInstructions(task, { taskLine: '', taskDir: '', fleet: '' }, { uncapped: true }).text()
      const now = defaultInstructions(task)
      expect(byteLength(now)).toBeLessThan(byteLength(before))
      const debt = promptDebtBytes({ appliedAppendSystemPrompt: before }, task)
      // Three pointer lines and the tool map, with the notice's own frame: about 1.5 KB, never the 7 KB moved.
      expect(debt).toBeGreaterThan(0)
      expect(debt).toBeLessThan(2_500)
    })
  }
})
