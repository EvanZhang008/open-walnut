/**
 * Versioned blocks in the default instructions are told as changes, never whole again
 * (2026-10-30: a one-line USER.md save re-sent the 4.9 KB profile to about 25 sessions).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('walnut-instruction-diff'))
import { USER_FILE, WALNUT_HOME } from '../../src/constants.js'
import { defaultInstructions, type InstructionTask } from '../../src/core/sessions/session-context.js'
import { refreshUserProfile } from '../../src/core/sessions/user-profile-context.js'
import { dueChanges, hash, parseInstructions, renderDue } from '../../src/core/sessions/instruction-diff.js'
import { WALNUT_PROMPT_MARK } from '../../src/core/sessions/session-context.js'
import { instructionNoticeFor, toldOnto } from '../../src/core/sessions/instruction-notice.js'

const TAG = /^\[v[0-9a-f]{8}\] /
const USER = (rules: string[]) => `---\nname: User Profile\n---\n\n# USER.md\n\n## Standing rules\n\n${rules.map((r) => `- ${r}`).join('\n')}\n`
const RULES = Array.from({ length: 30 }, (_, i) => `Rule number ${i + 1}: keep this standing preference in every task.`)
/** Enough lines that a one-line change is shorter told as a change than whole. */
const FILLER = Array.from({ length: 12 }, (_, i) => `Standing line ${i + 1}, kept as it is across every save.`)

async function writeUser(text: string) {
  await fs.mkdir(path.dirname(USER_FILE), { recursive: true })
  await fs.writeFile(USER_FILE, text)
  // A new mtime per save, as two real saves have.
  await new Promise((r) => setTimeout(r, 15))
  await refreshUserProfile()
}

const at = '2026-10-30T07:02:00.000Z'
const ROLES: Array<[string, InstructionTask]> = [
  ['worker', { id: 'w', project: 'marina' }],
  ['ask', { id: 'a', project: 'Ask Walnut', walnut_agent: true }],
  ['lead, default core instructions', { id: 'l', project: 'marina', org_role: 'lead' }],
  ['lead, own instructions', { id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text: 'Keep the Board current.\nShip daily.', at, by: 'human' } }],
  ['lead, instructions an agent added', { id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text: 'Check CI first.', at, by: 'task:main' } }],
  ['main', { id: 'm', project: 'Ask Walnut', walnut_agent: true, org_role: 'main' }],
]

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await writeUser(USER(RULES))
})

describe('every versioned line belongs to a block the diff reads', () => {
  // The guard for the class: a new versioned block whose head the parser does not know would
  // make each of its tagged lines a plain line again, and every save would re-send it whole.
  it.each(ROLES)('%s: no tagged line is read as a plain line', (_label, task) => {
    const parsed = parseInstructions(defaultInstructions(task))
    expect(parsed.plain.filter((c) => TAG.test(c.line))).toEqual([])
    expect(parsed.blocks.size).toBeGreaterThan(0)
  })

  // A block named only by where it sits changes name when a heading is added above it, and a
  // session would then be told it whole and told it is gone in one notice.
  it.each(ROLES)('%s: every block has a name of its own', (_label, task) => {
    const ids = [...parseInstructions(defaultInstructions(task)).blocks.keys()]
    expect(ids.filter((id) => !['user-profile', 'core-instructions'].includes(id))).toEqual([])
  })

  it('a block keeps its name under a heading added above it', () => {
    const task: InstructionTask = { id: 'l', project: 'marina', org_role: 'lead' }
    const text = defaultInstructions(task)
    const moved = text.replace('## Your user', '## Task Context\n\nSomething.\n\n## Your user')
    expect([...parseInstructions(moved).blocks.keys()].sort()).toEqual([...parseInstructions(text).blocks.keys()].sort())
    expect(dueChanges(parseInstructions(text), parseInstructions(moved), new Set(), {})?.blocks ?? []).toEqual([])
  })
})

describe('a one-line change is told as one line', () => {
  it('USER.md: one rule edited out of thirty', async () => {
    const task: InstructionTask = { id: 'w', project: 'marina' }
    const before = defaultInstructions(task)
    const edited = [...RULES]
    edited[4] = 'Rule number 5: now worded differently.'
    await writeUser(USER(edited))
    const due = dueChanges(parseInstructions(defaultInstructions(task)), parseInstructions(before), new Set(), {})!
    expect(due.plain).toEqual([])
    expect(due.blocks).toHaveLength(1)
    expect(due.blocks[0].added.map((l) => l.word)).toEqual(['- Rule number 5: now worded differently.'])
    expect(due.blocks[0].removed.map((l) => l.word)).toEqual([`- ${RULES[4]}`])
    const text = renderDue(due)
    expect(text.length).toBeLessThan(800)
    expect(text).not.toContain('Rule number 6')
  })

  it('core instructions: one line of a lead\'s own instructions edited', () => {
    const lead = (text: string): InstructionTask => ({ id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text, at, by: 'human' } })
    const lines = ['Keep the Board current.', 'Ship daily, behind a flag.', 'Ask Main before any outward step.', ...FILLER]
    const before = defaultInstructions(lead(lines.join('\n')))
    const edited = [...lines]
    edited[1] = 'A line the user reworded.'
    const due = dueChanges(parseInstructions(defaultInstructions(lead(edited.join('\n')))), parseInstructions(before), new Set(), {})!
    const block = due.blocks.find((b) => b.added.length)!
    expect(block.added.map((l) => l.word)).toEqual(['A line the user reworded.'])
    expect(block.removed.map((l) => l.word)).toEqual([lines[1]])
    expect(renderDue(due)).not.toContain(lines[2])
  })

  it('a block the session never had comes whole; the same version is never told again', async () => {
    const task: InstructionTask = { id: 'w', project: 'marina' }
    await fs.rm(USER_FILE)
    await refreshUserProfile()
    const before = defaultInstructions(task)
    await writeUser(USER(RULES))
    const current = parseInstructions(defaultInstructions(task))
    const due = dueChanges(current, parseInstructions(before), new Set(), {})!
    expect(due.blocks[0].whole).toBe(true)
    expect(renderDue(due)).toContain(RULES[29])
    const held = { [due.blocks[0].block.id]: { version: due.blocks[0].block.version, words: due.blocks[0].block.words } }
    expect(dueChanges(current, parseInstructions(before), new Set(due.plain.map(() => '')), held)?.blocks ?? []).toEqual([])
  })
})

describe('a change keeps the context it needs', () => {
  const sectioned = (home: string) => `---\nname: User Profile\n---\n\n# USER.md\n\n## Home\n\n- ${home}\n- Water the plants.\n\n## Work\n\n- use pnpm\n\n## Standing\n\n${FILLER.map((f) => `- ${f}`).join('\n')}\n`

  it('the same line under two sub-headings: an edit of one is a removal there, and the new line names its part', async () => {
    const task: InstructionTask = { id: 'w', project: 'marina' }
    await writeUser(sectioned('use pnpm'))
    const before = defaultInstructions(task)
    await writeUser(sectioned('use npm'))
    const due = dueChanges(parseInstructions(defaultInstructions(task)), parseInstructions(before), new Set(), {})!
    expect(due.blocks[0].added).toEqual([{ word: '- use npm', section: '## Home' }])
    expect(due.blocks[0].removed).toEqual([{ word: '- use pnpm', section: '## Home' }])
    const text = renderDue(due)
    expect(text).toMatch(/New or reworded:\n\[v[0-9a-f]{8}\] ## Home\n\[v[0-9a-f]{8}\] - use npm/)
    expect(text).toContain('- use pnpm (under "## Home")')
    expect(text).not.toContain('Water the plants')
  })

  it('a line an agent added to a lead\'s instructions comes with its "Added by" line', () => {
    const lead = (text: string): InstructionTask => ({ id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text, at, by: 'task:main' } })
    const before = defaultInstructions(lead('Check CI first.'))
    const due = dueChanges(parseInstructions(defaultInstructions(lead('Check CI first.\nPost the Board daily.'))), parseInstructions(before), new Set(), {})!
    const block = due.blocks.find((b) => b.block.id === 'core-instructions')!
    expect(block.whole).toBe(false)
    expect(renderDue(due)).toMatch(/\[v[0-9a-f]{8}\] Added by [^\n]+:\n\[v[0-9a-f]{8}\] Post the Board daily\./)
  })

  it('a change of form (Walnut\'s default became the user\'s own words) comes whole, with its head', () => {
    const before = defaultInstructions({ id: 'l', project: 'marina', org_role: 'lead' })
    const now: InstructionTask = { id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text: 'Keep the Board current.', at, by: 'human' } }
    const due = dueChanges(parseInstructions(defaultInstructions(now)), parseInstructions(before), new Set(), {})!
    const block = due.blocks.find((b) => b.block.id === 'core-instructions')!
    expect(block.whole).toBe(true)
    expect(renderDue(due)).toContain('They replace every earlier version and Walnut\'s default')
  })

  it('the head of a change reads as whole sentences in every form', async () => {
    const forms: Array<[InstructionTask, InstructionTask]> = [
      [{ id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text: `Keep the Board current.\nShip daily.\n${FILLER.join('\n')}`, at, by: 'human' } },
        { id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text: `Keep the Board current.\nShip weekly.\n${FILLER.join('\n')}`, at: '2026-10-30T08:00:00.000Z', by: 'human' } }],
      [{ id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text: `Check CI first.\n${FILLER.join('\n')}`, at, by: 'task:main' } },
        { id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text: `Check CI twice.\n${FILLER.join('\n')}`, at: '2026-10-30T08:00:00.000Z', by: 'task:main' } }],
    ]
    for (const [a, b] of forms) {
      const text = renderDue(dueChanges(parseInstructions(defaultInstructions(b)), parseInstructions(defaultInstructions(a)), new Set(), {})!)
      expect(text).not.toMatch(/\)\. and|\. and Walnut|They replace every earlier version\./)
      expect(text).toContain('Only what changed since the version you were given last')
    }
  })

  it('a part told gone and then back comes whole', () => {
    const task: InstructionTask = { id: 'w', project: 'marina' }
    const current = parseInstructions(defaultInstructions(task))
    const prompt = parseInstructions(defaultInstructions(task))
    const due = dueChanges(current, prompt, new Set(), { 'user-profile': { version: 'v00000000', words: [] } })!
    expect(due.blocks[0].whole).toBe(true)
  })
})

describe('review cases (2026-10-30)', () => {
  const agentLead = (text: string, by_name?: string): InstructionTask => ({ id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text, at, by: 'task:main', ...(by_name ? { by_name } : {}) } })

  it('a new line under a heading inside an agent\'s part keeps both its heading and whose words it is', () => {
    const base = `Check CI first.\n${FILLER.join('\n')}\n# Rules\nOne.`
    const before = defaultInstructions(agentLead(base))
    const text = renderDue(dueChanges(parseInstructions(defaultInstructions(agentLead(`${base}\nTwo.`))), parseInstructions(before), new Set(), {})!)
    expect(text).toMatch(/New or reworded:\n\[v[0-9a-f]{8}\] Added by an agent:\n\[v[0-9a-f]{8}\] # Rules\n\[v[0-9a-f]{8}\] Two\./)
  })

  it('a long rule reworded at its end is listed removed in full, never as a cut that reads like the new one', async () => {
    const task: InstructionTask = { id: 'w', project: 'marina' }
    const long = `Always ${'keep the release notes short and plain, '.repeat(5)}and send them on Friday.`
    await writeUser(USER([long, 'Another rule.', ...FILLER]))
    const before = defaultInstructions(task)
    await writeUser(USER([long.replace('Friday', 'Monday'), 'Another rule.', ...FILLER]))
    const text = renderDue(dueChanges(parseInstructions(defaultInstructions(task)), parseInstructions(before), new Set(), {})!)
    expect(text).toContain(`- ${long}`)
  })

  it('the user\'s own words told as changes: "They replace Walnut\'s default", never "every earlier" next to "stays in force"', () => {
    const own = (t: string, when: string): InstructionTask => ({ id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text: `${t}\n${FILLER.join('\n')}`, at: when, by: 'human' } })
    const text = renderDue(dueChanges(parseInstructions(defaultInstructions(own('A.\nC.', '2026-10-30T08:00:00.000Z'))), parseInstructions(defaultInstructions(own('A.\nB.', at))), new Set(), {})!)
    expect(text).toContain('They replace Walnut\'s default, and where any other part of these instructions says otherwise, they win.')
    expect(text).not.toContain('every earlier')
  })

  it('an agent named after the profile file does not turn its instructions into the profile', () => {
    const ids = [...parseInstructions(defaultInstructions(agentLead('Check CI first.', 'memory/USER.md keeper'))).blocks.keys()]
    expect(ids.sort()).toEqual(['core-instructions', 'user-profile'])
  })

  it('a record from before blocks were kept, told a version in between, gets the block whole once', async () => {
    const task: InstructionTask = { id: 'w', project: 'marina' }
    const v0 = defaultInstructions(task)
    await writeUser(USER([...RULES, 'Rule told in between, now removed.']))
    const v1 = parseInstructions(defaultInstructions(task))
    await writeUser(USER([...RULES.slice(0, 29), 'Rule thirty, reworded.']))
    expect(v0).toContain(WALNUT_PROMPT_MARK)
    const told = [...v1.blocks.get('user-profile')!.tagged].map(hash)
    const record = { appliedAppendSystemPrompt: v0, taskRoutingNoted: { version: 'x', promptHash: hash(v0), lines: told } }
    const notice = instructionNoticeFor(record, task)!
    expect(notice).toMatch(/Each line of this version starts with \[v[0-9a-f]{8}\]:/)
    expect(notice).toContain('Rule thirty, reworded.')
    expect(notice).toContain(RULES[0])
  })

  it('a delivery merged onto a newer record writes only the blocks it told', () => {
    const prompt = 'p'
    const base = { promptHash: hash(prompt) }
    const record = { appliedAppendSystemPrompt: prompt, taskRoutingNoted: { version: 'r', ...base, lines: ['l1'], blocks: { a: { version: 'v3', words: ['x'] } } } }
    const merged = toldOnto(record, { noted: { version: 'n', ...base, lines: ['l2'], blocks: { a: { version: 'v2', words: ['old'] }, b: { version: 'v9', words: ['y'] } } }, changed: ['b'] })!
    expect(merged.blocks).toEqual({ a: { version: 'v3', words: ['x'] }, b: { version: 'v9', words: ['y'] } })
    expect(merged.lines).toEqual(['l1', 'l2'])
  })

  it('a save that rewrote most lines comes whole: a change is never longer than the block (2026-10-31)', async () => {
    // A condensing edit reworded nearly every rule; listing each new line and each old one made
    // a 6.1 KB notice for a 4.5 KB block.
    const task: InstructionTask = { id: 'w', project: 'marina' }
    const before = defaultInstructions(task)
    await writeUser(USER(RULES.map((r, i) => (i < 27 ? `Rule ${i + 1}, said shorter.` : r))))
    const current = parseInstructions(defaultInstructions(task))
    const due = dueChanges(current, parseInstructions(before), new Set(), {})!
    expect(due.blocks[0].whole).toBe(true)
    expect(renderDue(due).length).toBeLessThanOrEqual(current.blocks.get('user-profile')!.head.length + current.blocks.get('user-profile')!.tagged.join('\n').length + 100)
  })

  it('a line the budget cuts is never told as removed, and the change says not every line fits (2026-10-30)', async () => {
    // The 18:50Z save ran past 4000 characters: two rules still in the file were told "no longer in force".
    const task: InstructionTask = { id: 'w', project: 'marina' }
    const long = Array.from({ length: 60 }, (_, i) => `Rule ${i + 1}: a standing preference worded at some length, like a real rule of the user.`)
    // As many rules as fit under the budget, then one more at the head pushes the last ones out.
    const { userProfileFit } = await import('../../src/core/sessions/user-profile-context.js')
    const head = 'A new first rule, which pushes the last ones past the budget of the profile.'
    let n = 1
    while (!userProfileFit(USER(long.slice(0, n + 1))).cut.length) n++
    await writeUser(USER(long.slice(0, n)))
    const before = defaultInstructions(task)
    expect(before).not.toContain('runs past')
    await writeUser(USER([head, ...long.slice(0, n)]))
    const now = defaultInstructions(task)
    expect(now).toContain('runs past 4000 characters')
    const { currentUserProfile } = await import('../../src/core/sessions/user-profile-context.js')
    const cut = currentUserProfile().cut!
    expect(cut).toContain(`- ${long[n - 1]}`)
    expect(cut.length).toBeGreaterThan(0)
    const due = dueChanges(parseInstructions(now), parseInstructions(before), new Set(), {}, { 'user-profile': new Set(cut) })!
    expect(due.blocks[0].whole).toBe(false)
    expect(due.blocks[0].removed).toEqual([])
    const text = renderDue(due)
    expect(text).not.toContain('Removed, no longer in force')
    expect(text).toContain('Not every line of it fits here: USER.md runs past 4000 characters here; memory_read doc "user" has the rest.')
    // Through the notice itself, which reads the cut lines from the profile.
    const notice = instructionNoticeFor({ appliedAppendSystemPrompt: before }, task)!
    expect(notice).not.toContain('no longer in force')
    expect(notice).toContain('A new first rule')
  })

  it('a save past the budget answers with a warning that names what is left out', async () => {
    const { writeMemoryDoc } = await import('../../src/web/routes/memory.js')
    const long = Array.from({ length: 60 }, (_, i) => `Rule ${i + 1}: a standing preference worded at some length, like a real rule.`)
    const over = await writeMemoryDoc('user', USER(long))
    expect(over.warning).toMatch(/sessions read only the first 4000: \d+ line\(s\) from "- Rule \d+/)
    expect((await writeMemoryDoc('user', USER(long.slice(0, 5)))).warning).toBeUndefined()
  })
})
