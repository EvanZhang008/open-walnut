/**
 * Versioned blocks in the default instructions are told as changes, never whole again
 * (2026-10-30: a one-line USER.md save re-sent the 4.9 KB profile to about 25 sessions).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('walnut-instruction-diff'))
const role = vi.hoisted(() => ({ companion: false, follower: false }))
vi.mock('../../src/core/server-role.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/server-role.js')>()),
  isCompanion: () => role.companion,
  isFollower: () => role.follower,
}))
import { USER_FILE, WALNUT_HOME } from '../../src/constants.js'
import { defaultInstructions, type InstructionTask } from '../../src/core/sessions/session-context.js'
import { refreshUserProfile } from '../../src/core/sessions/user-profile-context.js'
import { dueChanges, hash, parseInstructions, renderDue, viewsAfter } from '../../src/core/sessions/instruction-diff.js'
import { _resetReplyLanguageForTesting } from '../../src/core/sessions/reply-language-context.js'
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
    expect(ids.filter((id) => !['user-profile', 'core-instructions', 'reply-language'].includes(id))).toEqual([])
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
    expect(text).toMatch(/New:\n\[v[0-9a-f]{8}\] ## Home\n\[v[0-9a-f]{8}\] - use npm/)
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
      expect(text).toContain('Only what changed since the version you hold')
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
    expect(text).toMatch(/New:\n\[v[0-9a-f]{8}\] Added by an agent:\n\[v[0-9a-f]{8}\] # Rules\n\[v[0-9a-f]{8}\] Two\./)
  })

  it('a long rule reworded at its end is told once, as its new wording, never also as removed (2026-11-11)', async () => {
    const task: InstructionTask = { id: 'w', project: 'marina' }
    const long = `Always ${'keep the release notes short and plain, '.repeat(5)}and send them on Friday.`
    await writeUser(USER([long, 'Another rule.', ...FILLER]))
    const before = defaultInstructions(task)
    await writeUser(USER([long.replace('Friday', 'Monday'), 'Another rule.', ...FILLER]))
    const text = renderDue(dueChanges(parseInstructions(defaultInstructions(task)), parseInstructions(before), new Set(), {})!)
    expect(text).toMatch(/Reworded:\n\[v[0-9a-f]{8}\] ## Standing rules\n\[v[0-9a-f]{8}\] - Always keep[^\n]+Monday\./)
    expect(text).toContain('A reworded line takes the place of your line in the same part')
    expect(text).not.toContain('Removed, no longer in force')
    expect(text).not.toContain('Friday')
  })

  it('a reworded rule whose start a kept rule shares is named in full, so the kept one is never read as gone', async () => {
    const task: InstructionTask = { id: 'w', project: 'marina' }
    const stem = 'When you report to the user about a long running piece of work that spans several days, always'
    const kept = `${stem} name the task and say what changed since the last report.`
    const old = `${stem} give the link to the board and the time you checked it.`
    await writeUser(USER([kept, old, ...FILLER]))
    const before = defaultInstructions(task)
    await writeUser(USER([kept, `${stem} give the board link.`, ...FILLER]))
    const text = renderDue(dueChanges(parseInstructions(defaultInstructions(task)), parseInstructions(before), new Set(), {})!)
    expect(text).toContain(`- ${old} (its new wording is above)`)
    expect(text).not.toContain(`- ${kept}`)
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

  it('a save that rewrote most lines is still told as changes, never the block whole (2026-11-03)', async () => {
    // A condensing edit reworded 10 of 27 lines and went whole, 5 to 6 KB, to every live session.
    const task: InstructionTask = { id: 'w', project: 'marina' }
    const before = defaultInstructions(task)
    await writeUser(USER(RULES.map((r, i) => (i < 27 ? `Rule ${i + 1}, said shorter.` : r))))
    const current = parseInstructions(defaultInstructions(task))
    const due = dueChanges(current, parseInstructions(before), new Set(), {})!
    expect(due.blocks[0].whole).toBe(false)
    const text = renderDue(due)
    expect(text).not.toContain('They replace every earlier version')
    // Each new line in full, each old one by a short name: about the block's size, never more.
    const added = due.blocks[0].added.reduce((n, l) => n + l.word.length + 13, 0)
    expect(text.length).toBeLessThanOrEqual(added + due.blocks[0].removed.length * 110 + 900)
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

describe('a one-line change is told in about one line (2026-11-03)', () => {
  // The org reflection: 64 notices, about 287K characters, in 12 hours across 100 sessions; one
  // save sent the whole profile (5 to 6 KB) to every live session for a few changed lines.
  /** What a notice adds besides the changed line itself: the opening, the headings, the block's head. */
  const FIXED = 1_000
  const notice = (before: string, task: InstructionTask) =>
    instructionNoticeFor({ appliedAppendSystemPrompt: before }, task)!

  it.each([5, 40])('USER.md with %i rules: one rule reworded', async (n) => {
    const task: InstructionTask = { id: 'w', project: 'marina' }
    const rules = Array.from({ length: n }, (_, i) => `Rule ${i + 1}: a standing preference of the user, worded the way real ones are.`)
    await writeUser(USER(rules))
    const before = defaultInstructions(task)
    const reworded = 'Rule 3: a standing preference of the user, now worded a little differently.'
    await writeUser(USER(rules.map((r, i) => (i === 2 ? reworded : r))))
    const text = notice(before, task)
    expect(text).toContain(reworded)
    expect(text).not.toContain('Rule 4:')
    expect(text.length).toBeLessThanOrEqual(`- ${reworded}`.length + `- ${rules[2]}`.length + FIXED)
  })

  it('USER.md: one rule added, one removed, the same bound', async () => {
    const task: InstructionTask = { id: 'w', project: 'marina' }
    await writeUser(USER(RULES))
    const before = defaultInstructions(task)
    await writeUser(USER([...RULES, 'A rule the user just added.']))
    expect(notice(before, task).length).toBeLessThanOrEqual('- A rule the user just added.'.length + FIXED)
    const added = defaultInstructions(task)
    await writeUser(USER(RULES.slice(1)))
    const removed = instructionNoticeFor({ appliedAppendSystemPrompt: added }, task)!
    expect(removed.length).toBeLessThanOrEqual('- A rule the user just added.'.length + `- ${RULES[0]}`.length + FIXED)
  })

  it('a lead\'s own instructions: one line changed among many', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Instruction ${i + 1} for the lead, kept across edits.`)
    const own = (text: string, when: string): InstructionTask => ({ id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text, at: when, by: 'human' } })
    const before = defaultInstructions(own(lines.join('\n'), at))
    const text = notice(before, own(lines.map((l, i) => (i === 7 ? 'Instruction 8 for the lead, changed today.' : l)).join('\n'), '2026-11-03T01:00:00.000Z'))
    expect(text).toContain('Instruction 8 for the lead, changed today.')
    expect(text.length).toBeLessThanOrEqual('Instruction 8 for the lead, changed today.'.length + lines[7].length + FIXED)
  })
})

describe('a reworded line is told once, as its new wording (2026-11-11)', () => {
  // Three USER.md saves that each added at most one rule reworded 8 to 10 others to stay under the
  // budget; each reworded line went out twice (new wording, and again under "Removed"), and a renamed
  // sub-heading sent every unchanged line under it again: 84 notices, 2.6 to 9 KB, to 70 sessions.
  const task: InstructionTask = { id: 'w', project: 'marina' }
  const profile = (p: { standing: string; lines: string[]; extra?: string[] }) => `---\nname: User Profile\n---\n\n# USER.md\n\n`
    + `## Identity\nAlex, a designer who builds a personal planning app in the evenings and on weekends.\n\n`
    + `## ${p.standing}\n${[...p.lines, ...(p.extra ?? [])].map((l) => `- ${l}`).join('\n')}\n\n`
    + `## Replies\n- Answer the exact question first, then the details, in plain words with one real example.\n`
  const LINES = [
    'Never play a sound on any of the machines at home: no speech, no music, no volume change at all.',
    'Run every command on his own machines yourself, and ask only for what needs his hand, like a phone code.',
    'Bring him only his own decisions, one sentence on what and why, plus your pick and the reason for it.',
    'Free disk space only from caches and build output that can be rebuilt, never from his own files.',
    'A bug he reports again goes to the one task that owns the shared cause, and gets fixed at the root.',
    'Tell him a cause or a number only once it was checked at the source, never a guess fixed a minute later.',
  ]
  /** The same rules said shorter, as a save that makes room under the budget writes them. */
  const SHORTER = [
    'Never play a sound on the machines at home: no speech, no music, no volume change.',
    'Run every command on his machines yourself; ask only for what needs his hand, like a phone code.',
    LINES[2],
    'Free disk only from rebuildable caches and build output, never his own files.',
    'A bug reported again goes to the one task owning the shared cause, fixed at the root.',
    LINES[5],
  ]
  const ADDED = 'Tasks run on the default engine; another one only when he names it.'

  it('rewordings and a renamed sub-heading: no line listed as removed, unchanged lines not told, about the new words in size', async () => {
    await writeUser(profile({ standing: 'Standing rules (agents keep asking these)', lines: LINES }))
    const before = defaultInstructions(task)
    await writeUser(profile({ standing: 'Standing rules', lines: SHORTER, extra: [ADDED] }))
    const due = dueChanges(parseInstructions(defaultInstructions(task)), parseInstructions(before), new Set(), {})!
    const block = due.blocks[0]
    expect(block.whole).toBe(false)
    expect(block.removed).toEqual([])
    const reworded = block.added.filter((l) => l.reworded).map((l) => l.word)
    expect(reworded).toEqual(['## Standing rules', ...[0, 1, 3, 4].map((i) => `- ${SHORTER[i]}`)])
    expect(block.added.filter((l) => !l.reworded).map((l) => l.word)).toEqual([`- ${ADDED}`])
    const text = renderDue(due)
    expect(text).not.toContain('Removed, no longer in force')
    expect(text).not.toContain('its new wording is above')
    // Lines that kept their words under the renamed heading are not told again.
    expect(text).not.toContain(LINES[2])
    expect(text).not.toContain(LINES[5])
    // Each new or reworded line once, and the fixed words of the head: nothing more.
    for (const l of block.added) expect(text.split(l.word).length - 1).toBeGreaterThanOrEqual(1)
    const words = block.added.reduce((n, l) => n + Buffer.byteLength(l.word) + 13, 0)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(words + 700)
  })

  // The class: every kind of rewording a budget trim makes. A reworded line is never also removed.
  const REWORDINGS: Array<[string, (l: string) => string]> = [
    ['a word dropped', (l) => l.replace(/ own\b| all\b| any of\b/, '')],
    // Each keeps the rule's never, always and negations: a rewording that drops one is another rule (tested below).
    ['a clause cut', (l) => l.replace(/, (?![^,]*\b(?:never|no|not)\b)[^,]+\.$/, '.')],
    ['a date added', (l) => l.replace(/\.$/, ' (11-11).')],
    ['comma to semicolon', (l) => l.replace(', ', '; ')],
    ['a word swapped', (l) => l.replace(/\bonly\b/, 'just').replace(/\bmachines\b/, 'computers').replace(/\bnumber\b/, 'figure')],
    ['said shorter', (l) => l.split(' ').filter((w, i) => i % 7 !== 6 || /^(never|no|not)$/i.test(w)).join(' ')],
  ]
  it.each(REWORDINGS)('%s in every rule: each is told as reworded, none as removed', async (_kind, reword) => {
    await writeUser(profile({ standing: 'Standing rules', lines: LINES }))
    const before = defaultInstructions(task)
    const now = LINES.map(reword)
    await writeUser(profile({ standing: 'Standing rules', lines: now }))
    const due = dueChanges(parseInstructions(defaultInstructions(task)), parseInstructions(before), new Set(), {})
    const changed = now.filter((l, i) => l !== LINES[i])
    expect(changed.length).toBeGreaterThan(0)
    const block = due!.blocks[0]
    expect(block.removed).toEqual([])
    expect(block.added.map((l) => [l.word, l.reworded])).toEqual(changed.map((l) => [`- ${l}`, true]))
  })

  it('another rule is never taken for a rewording: a removed rule and a new one stay removed and new', async () => {
    await writeUser(profile({ standing: 'Standing rules', lines: LINES }))
    const before = defaultInstructions(task)
    await writeUser(profile({ standing: 'Standing rules', lines: [...LINES.slice(0, 3), ...LINES.slice(4)], extra: [ADDED] }))
    const block = dueChanges(parseInstructions(defaultInstructions(task)), parseInstructions(before), new Set(), {})!.blocks[0]
    expect(block.added).toEqual([{ word: `- ${ADDED}`, section: '## Standing rules' }])
    expect(block.removed.map((l) => l.word)).toEqual([`- ${LINES[3]}`])
  })

  it.each([
    ['other words for the same subject', 'Reply in Chinese to the owner, in every line you write.', 'Reply in English to the reviewers, in every line you write.'],
    ['never made always', 'Never push to the public repository before the scan has passed.', 'Always push to the public repository before the scan has passed.'],
    ['a negation dropped', 'Do not restart the production server while a deploy is running.', 'Do restart the production server while a deploy is running.'],
  ])('%s is never taken for a rewording: the old rule is listed as removed', async (_kind, old, now) => {
    await writeUser(profile({ standing: 'Standing rules', lines: [...LINES, old] }))
    const before = defaultInstructions(task)
    await writeUser(profile({ standing: 'Standing rules', lines: [...LINES, now] }))
    const block = dueChanges(parseInstructions(defaultInstructions(task)), parseInstructions(before), new Set(), {})!.blocks[0]
    expect(block.added).toEqual([{ word: `- ${now}`, section: '## Standing rules' }])
    expect(block.removed.map((l) => l.word)).toEqual([`- ${old}`])
  })

  it('Chinese rules, written without spaces, are compared character by character', async () => {
    const old = '\u6bcf\u6b21\u56de\u590d\u90fd\u7528\u4e2d\u6587\u5199\u6e05\u695a\u7ed3\u8bba\u548c\u4e0b\u4e00\u6b65'
    const now = '\u6bcf\u6b21\u56de\u590d\u90fd\u7528\u4e2d\u6587\u5199\u6e05\u7ed3\u8bba\u4e0e\u4e0b\u4e00\u6b65'
    await writeUser(profile({ standing: 'Standing rules', lines: [...LINES, old] }))
    const before = defaultInstructions(task)
    await writeUser(profile({ standing: 'Standing rules', lines: [...LINES, now] }))
    const block = dueChanges(parseInstructions(defaultInstructions(task)), parseInstructions(before), new Set(), {})!.blocks[0]
    expect(block.removed).toEqual([])
    expect(block.added).toEqual([{ word: `- ${now}`, section: '## Standing rules', reworded: true }])
  })

  it('a session that missed several saves gets one net change against the version it holds', async () => {
    await writeUser(profile({ standing: 'Standing rules (agents keep asking these)', lines: LINES }))
    const before = defaultInstructions(task)
    // Three saves while the session took no message: an in-between wording it never held, then the last.
    await writeUser(profile({ standing: 'Standing rules (agents keep asking these)', lines: LINES.map((l, i) => (i === 0 ? `${l.slice(0, -1)}, ever.` : l)) }))
    await writeUser(profile({ standing: 'Standing rules', lines: SHORTER }))
    await writeUser(profile({ standing: 'Standing rules', lines: SHORTER, extra: [ADDED] }))
    const notice = instructionNoticeFor({ appliedAppendSystemPrompt: before }, task)!
    expect(notice.match(/<walnut-message /g)).toHaveLength(1)
    expect(notice).not.toContain(', ever.')
    expect(notice).not.toContain('Removed, no longer in force')
    expect(notice).toContain(ADDED)
    expect(notice).toContain(SHORTER[0])
    // Told once: what it holds now is the last version, and nothing more is due.
    const current = parseInstructions(defaultInstructions(task))
    const due = dueChanges(current, parseInstructions(before), new Set(), {})!
    expect(dueChanges(current, parseInstructions(before), new Set(), viewsAfter({}, due))).toBeNull()
  })
})

describe('the reply language is a block: a change, a restore and a clear all reach a running session', () => {
  // 2026-11-06 review: as a plain line, a cleared setting and one set back to an earlier language
  // were never told (the old line was "told" already), and a new one waited out the 3-hour gap.
  const task: InstructionTask = { id: 'w', project: 'marina' }
  const promptWith = (lang: string | null) => { _resetReplyLanguageForTesting(lang); const p = parseInstructions(defaultInstructions(task)); _resetReplyLanguageForTesting(); return p }

  it('French to German is told as the new line, German back to French too, and a clear as gone', () => {
    const fr = promptWith('Answer in French.')
    const de = promptWith('Answer in German.')
    expect(fr.blocks.has('reply-language')).toBe(true)
    const toGerman = dueChanges(de, fr, new Set(), {})!
    expect(renderDue(toGerman)).toContain('Answer in German.')
    const held = viewsAfter({}, toGerman)
    const back = dueChanges(fr, fr, new Set(), held)!
    expect(back.blocks.map((b) => b.block.id)).toEqual(['reply-language'])
    expect(renderDue(back)).toContain('Answer in French.')
    const cleared = dueChanges(promptWith(null), fr, new Set(), {})!
    expect(cleared.gone.map((g) => g.id)).toEqual(['reply-language'])
    expect(renderDue(cleared)).toContain('none of its lines apply any more')
    expect(dueChanges(fr, fr, new Set(), {})).toBeNull()
  })

  it('on a replica (the companion or a host replica), whose config copy has no Reply language, a session is never told the line is gone', () => {
    _resetReplyLanguageForTesting('Answer in French.')
    const before = defaultInstructions(task)
    _resetReplyLanguageForTesting()
    try {
      Object.assign(role, { companion: true, follower: true })
      expect(instructionNoticeFor({ appliedAppendSystemPrompt: before }, task)).toBeNull()
      Object.assign(role, { companion: false, follower: true })
      expect(instructionNoticeFor({ appliedAppendSystemPrompt: before }, task)).toBeNull()
      Object.assign(role, { companion: false, follower: false })
      expect(instructionNoticeFor({ appliedAppendSystemPrompt: before }, task)).toContain('none of its lines apply any more')
    } finally { Object.assign(role, { companion: false, follower: false }) }
  })
})
