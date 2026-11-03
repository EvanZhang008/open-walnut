/**
 * Main and every VP never do the work themselves (2026-11-03, the user: "U never never nver do it
 * urslef unless it is under 3 command run ... this si the most improt rule, for a VP or CEO"). After a
 * compaction the Walnut VP's start was refused for a full slot, the refusal said "or do this part with
 * your own tools", and it investigated with host_exec itself.
 *
 * Pinned here: the rule is the FIRST line of both default core instructions, it still holds under the
 * user's own words, the prompt an org node reads carries no line that tells it to do the work itself
 * (a class guard: any new such phrase in Main's or a VP's default instructions fails), and the spawn
 * reads the role from every prompt variant Walnut writes, the oldest included, so the guard hook
 * (org-work-guard-hook.ts) reaches every org node.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-org-self-work-rule'))

import { DEFAULT_ORG_INSTRUCTIONS, ORG_SELF_COMMAND_LIMIT, orgSelfWorkRule } from '../../../src/core/org/core-instructions.js'
import { coreInstructionsBlock, defaultInstructions } from '../../../src/core/sessions/session-context.js'
import { orgRoleOfPrompt } from '../../../src/core/org/org-prompt-role.js'
import { orgWorkRefusal } from '../../../src/providers/org-work-guard-hook.js'

/** Words that tell the reader to do the work itself. An org node must read none of them. */
const DO_IT_YOURSELF = [
  /do (the|this|that) (work|part) (here )?with your own tools/i,
  /do this part (here )?with your own tools/i,
  /with your own tools/i,
  /beyond a quick look/i,
  /Do only quick things yourself/i,
  /Walnut is not your toolbox/i,
  /follow-ups you find are yours to do here/i,
]

const ORG_TASKS = [
  { org_role: 'main' as const, project: 'Main' },
  { org_role: 'lead' as const, project: 'Walnut' },
  { org_role: 'lead' as const, project: 'Walnut', org_leads: ['Walnut-Idea'] },
  { org_role: 'lead' as const, project: 'Home', org_vp_only: true, org_leads: ['A', 'B'] },
  { org_role: 'lead' as const, project: 'Home', org_vp_only: true },
  { org_role: 'lead' as const, project: 'Walnut', org_name: 'Walnut' },
]

describe('Main and a VP never do the work themselves', () => {
  it('the rule is the first line of both defaults, with the limit Walnut enforces', () => {
    expect(ORG_SELF_COMMAND_LIMIT).toBe(3)
    for (const role of ['main', 'lead'] as const) {
      expect(DEFAULT_ORG_INSTRUCTIONS[role].split('\n')[0]).toBe(orgSelfWorkRule(role))
      expect(orgSelfWorkRule(role)).toMatch(/Never do the work yourself: run at most 3 commands of your own in a turn/)
      expect(orgSelfWorkRule(role)).toMatch(/A full slot is no reason to do it yourself: the start is queued/)
      expect(orgSelfWorkRule(role)).toMatch(/task_create/)
    }
    expect(orgSelfWorkRule('main')).toMatch(/org_send/)
  })

  it('an org node reads no line telling it to do the work itself, in every role variant', () => {
    for (const task of ORG_TASKS) {
      const prompt = defaultInstructions(task)
      expect(prompt).toContain(orgSelfWorkRule(task.org_role))
      for (const bad of DO_IT_YOURSELF) expect(prompt, `${JSON.stringify(task)} reads ${bad}`).not.toMatch(bad)
    }
  })

  it('a worker is still told to do its own work (the rule is the org node\'s alone)', () => {
    const prompt = defaultInstructions({ project: 'Walnut' })
    expect(prompt).toMatch(/Walnut is not your toolbox: do the work with your own tools/)
    expect(prompt).not.toContain(orgSelfWorkRule('lead'))
  })

  it('the user\'s own words replace the default, and Walnut\'s rule for the role still holds under them', () => {
    const task = { org_role: 'lead' as const, project: 'Walnut', org_instructions: { text: 'Ship fast.', at: '2026-11-03T08:00:00Z', by: 'human' } }
    const block = coreInstructionsBlock(task)
    expect(block).toMatch(/your user's own instructions for your role/)
    expect(block).toContain('Ship fast.')
    expect(block).toContain(`Walnut's rule for your role still holds: ${orgSelfWorkRule('lead')}`)
    expect(coreInstructionsBlock({ project: 'Walnut' })).toBe('')
  })

  it('the refusal the guard hook gives names the hand-on, never "do it here"', () => {
    for (const role of ['main', 'lead'] as const) {
      const words = orgWorkRefusal(role)
      expect(words).toMatch(/Hand it on now: task_send/)
      expect(words).toMatch(/the start is queued/)
      for (const bad of DO_IT_YOURSELF) expect(words).not.toMatch(bad)
    }
  })
})

describe('the spawn reads the org role from the prompt Walnut wrote', () => {
  it('every role variant is read, and a worker or an ask is not', () => {
    for (const task of ORG_TASKS) expect(orgRoleOfPrompt(defaultInstructions(task)), JSON.stringify(task)).toBe(task.org_role)
    expect(orgRoleOfPrompt(defaultInstructions({ project: 'Walnut' }))).toBeUndefined()
    expect(orgRoleOfPrompt(defaultInstructions({ project: 'Walnut', parent_task_id: 'p1' }))).toBeUndefined()
    expect(orgRoleOfPrompt(undefined)).toBeUndefined()
    expect(orgRoleOfPrompt('')).toBeUndefined()
  })

  it('the oldest prompt still in use is read too (the Walnut VP spawned as "Walnut lead")', () => {
    const old = 'You are working on the task "Walnut lead" (id mvm0n3bu-6910, project "Walnut").\n\n'
      + 'Your task is the lead of project "Walnut": its open top-level tasks (its teams) report to you, and you report to the user\'s main agent.'
    expect(orgRoleOfPrompt(old)).toBe('lead')
  })

  it('a worker that only names its VP or Main is not read as one', () => {
    expect(orgRoleOfPrompt('Your task reports to "Walnut VP" (id x), the VP that leads its project. You are the user\'s main agent is what Main reads.')).toBeUndefined()
    expect(orgRoleOfPrompt('Your task is a subtask of "Walnut VP" (id mvm0n3bu-6910), your leader.')).toBeUndefined()
  })
})
