/**
 * No rule text a session reads carries a tag a model copies into its own writing.
 *
 * 2026-11-19: every line of a versioned block (Reply language, USER.md, a node's core instructions,
 * a task's Threads) started with "[v16908844] ", under a head saying "Each line of this version starts
 * with [v16908844]:". A worker's compaction summary turned that into "Reply in Chinese (...; lines start
 * with `[v16908844]`)", and from then on its replies began with the tag, which the user read in the chat.
 * In a replay with the same model, 3 of 5 summaries written on the old form carried the tag, 0 of 5 on
 * the new one. A block now names its version once, in its head (instruction-diff.ts versionedBlock).
 *
 * The class: any versioned block, or any notice of one, that puts the same bracketed tag in front of
 * its lines. Each prompt of every role, with every kind of block present, and each notice form
 * (whole, as changes, gone, cut into compaction parts) is checked, and every block kind Walnut has
 * (BLOCK_KIND_IDS) must show up in one of them, so a new kind is checked too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-version-tag-guard'))
import { USER_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { defaultInstructions, type InstructionTask } from '../../../src/core/sessions/session-context.js'
import { refreshUserProfile } from '../../../src/core/sessions/user-profile-context.js'
import { _resetReplyLanguageForTesting } from '../../../src/core/sessions/reply-language-context.js'
import { BLOCK_KIND_IDS, dueChanges, parseInstructions, renderDue } from '../../../src/core/sessions/instruction-diff.js'
import { splitAtLines } from '../../../src/core/sessions/instruction-hook-parts.js'
import { legacyForm } from '../../helpers/versioned-block.js'

const USER = (rules: string[]) => `---\nname: User Profile\n---\n\n# USER.md\n\n## Identity\nA builder of small tools.\n## Standing rules\n\n${rules.map((r) => `- ${r}`).join('\n')}\n`
const RULES = Array.from({ length: 12 }, (_, i) => `Rule ${i + 1}: keep this standing preference in every task.`)

const at = '2026-11-19T03:00:00.000Z'
const ROLES: Array<[string, InstructionTask]> = [
  ['worker', { id: 'w', project: 'marina' }],
  ['worker with Threads on', { id: 'w', project: 'marina', threads_on: true } as InstructionTask],
  ['ask', { id: 'a', project: 'Ask Walnut', walnut_agent: true }],
  ['lead, default core instructions', { id: 'l', project: 'marina', org_role: 'lead' }],
  ['lead, own instructions', { id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text: 'Keep the Board current.\n## Daily\nShip daily.', at, by: 'human' } }],
  ['lead, instructions an agent added', { id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text: 'Check CI first.', at, by: 'task:main' } }],
  ['lead, instructions cleared', { id: 'l', project: 'marina', org_role: 'lead', org_instructions: { text: '', at, by: 'human' } }],
  ['main', { id: 'm', project: 'Ask Walnut', walnut_agent: true, org_role: 'main' }],
]

/** The lines that start with one bracketed tag shared by another line: a prefix a model learns to copy. */
function sharedLinePrefixes(text: string): string[] {
  const seen = new Map<string, number>()
  for (const line of text.split('\n')) {
    // Any bracketed, parenthesised or angle-bracketed token that opens a line.
    const m = /^\s*(\[[^\]\n]{1,40}\]|\([^)\n]{1,40}\)|<[^>\n]{1,40}>)/.exec(line)
    if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1)
  }
  return [...seen].filter(([, n]) => n > 1).map(([tag]) => tag)
}

function expectNoCopyableTag(text: string) {
  // A version at the start of a line, in any wrapping ("[v1a2b3c4d]", "(v1a2b3c4d)", "v1a2b3c4d:").
  expect(text).not.toMatch(/^\s*\W?v[0-9a-f]{8}\b/m)
  expect(sharedLinePrefixes(text)).toEqual([])
  // The words that told the model its lines start with a tag.
  expect(text).not.toMatch(/starts? with \[/i)
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.dirname(USER_FILE), { recursive: true })
  await fs.writeFile(USER_FILE, USER(RULES))
  await refreshUserProfile()
  _resetReplyLanguageForTesting('Talk to the user in Chinese.\nKeep code and commits in English.')
})

describe('the prompt names a block version once, never on each line', () => {
  it.each(ROLES)('%s', (_label, task) => {
    const text = defaultInstructions(task)
    expect(parseInstructions(text).blocks.size).toBeGreaterThan(0)
    expectNoCopyableTag(text)
  })

  it('every kind of versioned block is among the prompts checked', () => {
    const kinds = new Set(ROLES.flatMap(([, task]) => [...parseInstructions(defaultInstructions(task)).blocks.keys()].map((id) => id.replace(/#\d+$/, ''))))
    expect(BLOCK_KIND_IDS.filter((id) => !kinds.has(id))).toEqual([])
  })
})

describe('a notice of a block names its version once, never on each line', () => {
  /** A session spawned before an edit of each block, and one that never had them. */
  async function notices(task: InstructionTask): Promise<string[]> {
    const before = parseInstructions(defaultInstructions(task))
    await fs.writeFile(USER_FILE, USER([...RULES.slice(1), 'A new rule about reviews, added today.', 'Rule 5: keep this standing preference in every task, reworded.']))
    await refreshUserProfile()
    _resetReplyLanguageForTesting('Talk to the user in Simplified Chinese.')
    const now = parseInstructions(defaultInstructions(task))
    const changed = dueChanges(now, before, new Set(), {})
    const whole = dueChanges(now, parseInstructions('## Task Context\n\nNothing yet.'), new Set(), {})
    _resetReplyLanguageForTesting(null)
    const gone = dueChanges(parseInstructions(defaultInstructions(task)), before, new Set(), {})
    const out = [changed, whole, gone].map((d) => (d ? renderDue(d) : ''))
    expect(out.every(Boolean)).toBe(true)
    return out
  }

  it.each(ROLES)('%s: as changes, whole and gone, and cut into compaction parts', async (_label, task) => {
    for (const body of await notices(task)) {
      expectNoCopyableTag(body)
      for (const part of splitAtLines(body, 600)) expectNoCopyableTag(part)
    }
  })
})

describe('a session spawned on the old form holds the same block', () => {
  it.each(ROLES)('%s: same versions and words, an indented line included, so no block is told again', async (_label, task) => {
    await fs.writeFile(USER_FILE, USER(RULES).replace('- Rule 3:', '  - Rule 3:'))
    await refreshUserProfile()
    const now = parseInstructions(defaultInstructions(task))
    const old = parseInstructions(legacyForm(defaultInstructions(task)))
    expect(old.legacyTags).toBe(true)
    expect([...old.blocks.values()].map((b) => [b.id, b.version, b.form, b.words])).toEqual([...now.blocks.values()].map((b) => [b.id, b.version, b.form, b.words]))
    expect(now.blocks.get('user-profile')!.words).toContain('  - Rule 3: keep this standing preference in every task.')
    const due = dueChanges(now, old, new Set(), {})
    expect(due?.blocks).toEqual([])
    expect(due?.gone).toEqual([])
  })
})
