/**
 * The Context Inspector reads the skills index in both forms a prompt carries
 * (web/src/components/context/skills-index-parse.ts): the one-line index sessions get now
 * (src/core/skill-loader.ts formatSessionIndex) and the XML one of the rollback switch.
 */
import { describe, expect, it } from 'vitest'
import { parseSkillsIndex } from '../../web/src/components/context/skills-index-parse.js'
import { formatSessionIndex, type SkillMeta } from '../../src/core/skill-loader.js'

const skills: SkillMeta[] = [
  { name: 'walnut-board', location: '/opt/walnut/skills/walnut-board/SKILL.md', category: 'walnut', type: 'action', description: 'Keep a Board. Use when leading workers on a team.' },
  { name: 'notes', location: '/home/u/.open-walnut/skills/notes/SKILL.md', category: 'general', type: 'knowledge', description: 'How notes are kept.' },
]

describe('parseSkillsIndex', () => {
  it('reads the one-line index the session prompt carries, folder by folder', () => {
    const parsed = parseSkillsIndex(formatSessionIndex(skills))
    expect(parsed?.preamble.startsWith('## Walnut skills')).toBe(true)
    expect(parsed?.categories.map((c) => [c.name, c.skills.map((s) => [s.name, s.description, s.location])])).toEqual([
      ['/opt/walnut/skills', [['walnut-board', 'Use when leading workers on a team', '/opt/walnut/skills/walnut-board/SKILL.md']]],
      ['/home/u/.open-walnut/skills', [['notes', 'How notes are kept', '/home/u/.open-walnut/skills/notes/SKILL.md']]],
    ])
  })

  it('reads nothing from text that is no index', () => {
    expect(parseSkillsIndex('## Walnut skills\n\nNo skills here.')).toBeNull()
  })
})
