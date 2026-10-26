/**
 * `needs` → Claude Code's own permission controls for an ai.run agent session
 * (src/core/ai/ai-agent.ts agentPermissions): only the named tools exist, only the named uses are
 * pre-approved, and nothing a caller passes can widen a rule.
 */
import { describe, expect, it } from 'vitest'
import { agentPermissions, aiLaneKey, grantedLane } from '../../../src/core/ai/ai-agent.js'

const id = (name: string) => name

describe('agentPermissions', () => {
  it('maps ops to the walnut CLI, resolving plugin op names', () => {
    const perms = agentPermissions({ ops: ['tickets_get'] }, '/w', (name) => `acme_${name}`)
    expect(perms.tools).toEqual(['Bash'])
    expect(perms.allowedTools).toEqual(['Bash(walnut tools call acme_tickets_get:*)', 'Bash(walnut tools help acme_tickets_get)'])
  })

  it('maps command prefixes, file reads and edits under the cwd only', () => {
    const perms = agentPermissions({ commands: ['python3 -m pytest'], files: 'edit' }, '/Users/a/ws/', id)
    expect(perms.tools.sort()).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'])
    expect(perms.allowedTools).toEqual([
      'Bash(python3 -m pytest:*)',
      'Read(//Users/a/ws/**)',
      'Edit(//Users/a/ws/**)', 'Write(//Users/a/ws/**)',
    ])
  })

  it('a cwd alone means read access there', () => {
    const perms = agentPermissions({ cwd: '/ws' }, '/ws', id)
    expect(perms.tools.sort()).toEqual(['Glob', 'Grep', 'Read'])
    expect(perms.allowedTools).not.toContain('Edit(//ws/**)')
  })

  it('refuses op names and commands that could widen a rule', () => {
    for (const op of ['a b', 'x)', 'tickets;rm', '']) {
      expect(() => agentPermissions({ ops: [op] }, '/w', id)).toThrow(/Not an op name/)
    }
    for (const command of ['ls; rm -rf /', 'cat $(whoami)', 'echo `x`', 'a | b', 'a && b', 'a > f', 'x)']) {
      expect(() => agentPermissions({ commands: [command] }, '/w', id)).toThrow(/plain words/)
    }
  })

  it('no needs means no tools at all', () => {
    expect(agentPermissions({}, '/w', id)).toEqual({ tools: [], allowedTools: [] })
  })
})

describe('grantedLane', () => {
  it('is the same lane for the same grant, another for another grant', () => {
    const base = 'ai:plugin%3At:conv'
    const call = { system: 's', cwd: '/w', effort: 'normal' as const }
    const read = agentPermissions({ files: 'read' }, '/w', id)
    const edit = agentPermissions({ files: 'edit' }, '/w', id)
    expect(grantedLane(base, call, read)).toBe(grantedLane(base, { ...call }, agentPermissions({ files: 'read' }, '/w', id)))
    expect(grantedLane(base, call, read)).not.toBe(grantedLane(base, call, edit))
    expect(grantedLane(base, call, read)).not.toBe(grantedLane(base, { ...call, system: 'other' }, read))
    expect(grantedLane(base, call, read).startsWith(`${base}|`)).toBe(true)
  })
})

describe('aiLaneKey', () => {
  it('is per caller and per conversation, outside the Personal AI chat namespace', () => {
    const a = aiLaneKey({ kind: 'plugin', id: 'interview-practice' }, 'attempt:7')
    expect(a).toBe('ai:plugin%3Ainterview-practice:attempt:7')
    expect(a.startsWith('chat:')).toBe(false)
    expect(aiLaneKey({ kind: 'plugin', id: 'other' }, 'attempt:7')).not.toBe(a)
  })
})
