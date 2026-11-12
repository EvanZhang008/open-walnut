/**
 * Whether a session runs with Walnut's session context, so its persona leaves out what that
 * context carries (USER.md, where work lives, the charter, the routing rules): positive evidence
 * only (personal-ai-lane.ts hasWalnutContext). 2026-11-12 review: an adopted AI search session has
 * no stored spawn prompt, and reading that as yes made the drift repair rebuild its persona
 * without any of them, with no notice to say so.
 *
 * Every kind of session the repair and a lane's resolve meet, then the real repair of an adopted
 * AI search session.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-context-evidence'))
process.env.WALNUT_FLEET_PROMPT_REFRESH = '0'
import { WALNUT_HOME } from '../../../src/constants.js'
import { contextHoldsRouting, hasWalnutContext } from '../../../src/core/sessions/personal-ai-lane.js'
import { WALNUT_PROMPT_MARK, defaultInstructions } from '../../../src/core/sessions/session-context.js'
import { consoleAgentPersona, personalAiPersona } from '../../../src/core/sessions/profiles.js'
import { TEAM_CHARTER } from '../../../src/core/team-charter.js'
import { WORK_PLACE_RULE } from '../../../src/core/work-place.js'
import { TASK_ROUTING_CONTRACT } from '../../../src/core/task-routing-contract.js'
import { fixtureUserMd, seedFixtureHome } from '../../helpers/prompt-size-fixture.js'

const besideContext = personalAiPersona('Avery', '', '', { withSessionContext: true }).systemPrompt
const besideMain = personalAiPersona('Avery', '', '', { withSessionContext: true, routingInContext: true }).systemPrompt
const mainContext = defaultInstructions({ org_role: 'main', walnut_agent: true, project: 'Ask Walnut' })
const whole = personalAiPersona('Avery', '', '').systemPrompt
const mentorBeside = consoleAgentPersona({ id: 'mentor', name: 'Mentor' }, '', '', { withSessionContext: true }).systemPrompt
const context = defaultInstructions({ walnut_agent: true, project: 'Ask Walnut' })

describe('hasWalnutContext: every kind of session', () => {
  const cases: Array<[string, Parameters<typeof hasWalnutContext>[0], boolean]> = [
    ['a quick-start ask, its spawn prompt stored', { appliedAppendSystemPrompt: `${whole}\n\n${context}`, profile: { systemPrompt: besideContext } }, true],
    ['a quick-start ask a moment after its mint, nothing stored yet', { profile: { systemPrompt: besideContext } }, true],
    ['an ask of another console agent, nothing stored yet', { profile: { systemPrompt: mentorBeside } }, true],
    ['an adopted AI search session (claimSession stores no spawn prompt)', { profile: { systemPrompt: whole } }, false],
    ['a session whose stored prompt is a caller\'s own', { appliedAppendSystemPrompt: 'You answer in haiku.', profile: { systemPrompt: besideContext } }, false],
    ['a stored prompt of null', { appliedAppendSystemPrompt: null, profile: { systemPrompt: whole } }, false],
    ['a record with no profile and nothing stored', {}, false],
    ['a caller\'s persona that is not Walnut\'s, nothing stored', { profile: { systemPrompt: 'You are a terse reviewer.' } }, false],
  ]
  for (const [name, record, want] of cases) it(name, () => expect(hasWalnutContext(record, WALNUT_PROMPT_MARK)).toBe(want))

  it('the two persona forms differ by the charter, the evidence it reads', () => {
    expect(besideContext).not.toContain(TEAM_CHARTER)
    expect(whole).toContain(TEAM_CHARTER)
  })
})

describe('contextHoldsRouting: the persona leaves the routing rules out only where the context carries them', () => {
  const cases: Array<[string, Parameters<typeof contextHoldsRouting>[0], boolean]> = [
    ['Main, its spawn prompt stored (its role carries the rules)', { appliedAppendSystemPrompt: mainContext, profile: { systemPrompt: besideMain } }, true],
    ['Main a moment after its mint', { profile: { systemPrompt: besideMain } }, true],
    ['an ask, its spawn prompt stored (an ask\'s context has none)', { appliedAppendSystemPrompt: context, profile: { systemPrompt: besideContext } }, false],
    ['an ask a moment after its mint', { profile: { systemPrompt: besideContext } }, false],
    ['an adopted AI search session', { profile: { systemPrompt: whole } }, false],
    ['nothing stored, no profile', {}, false],
  ]
  for (const [name, record, want] of cases) it(name, () => expect(contextHoldsRouting(record)).toBe(want))

  it('an ask\'s session context has no routing rules, Main\'s has them', () => {
    expect(context).not.toContain(TASK_ROUTING_CONTRACT.trim())
    expect(mainContext).toContain(TASK_ROUTING_CONTRACT.trim())
    expect(besideContext).toContain(TASK_ROUTING_CONTRACT.trim())
    expect(besideMain).not.toContain(TASK_ROUTING_CONTRACT.trim())
  })
})

describe('the drift repair of an adopted AI search session keeps everything its persona carries', () => {
  beforeAll(async () => { await seedFixtureHome(WALNUT_HOME) })

  it('USER.md, the charter, where work lives and the routing rules stay', async () => {
    const { addTask, updateTaskRaw } = await import('../../../src/core/task-manager.js')
    const { createSessionRecord, updateSessionRecord, getSessionByClaudeId } = await import('../../../src/core/session-tracker.js')
    const { buildLaneProfile, refreshWalnutSessionProfile } = await import('../../../src/core/sessions/personal-ai-lane.js')
    const { getConfig } = await import('../../../src/core/config-manager.js')
    const { task } = await addTask({ title: 'What did I decide about the release?', project: 'Ask Walnut' } as never)
    await updateTaskRaw(task.id, () => ({ walnut_agent: true }))
    const sid = '44444444-5555-6666-7777-000000000001'
    await createSessionRecord(sid, task.id, 'Ask Walnut', WALNUT_HOME, { title: task.title })
    // As claimSession writes it: the default Personal AI profile, no spawn prompt stored.
    const minted = (await buildLaneProfile(await getConfig(), 'general')).profile
    // An older persona, so the repair has something to rewrite.
    await updateSessionRecord(sid, { profile: { ...minted, systemPrompt: `${minted.systemPrompt}\n\nAn older line.` } } as never)

    await refreshWalnutSessionProfile(sid)

    const repaired = (await getSessionByClaudeId(sid))!.profile!.systemPrompt!
    expect(repaired).not.toContain('An older line.')
    for (const text of [TEAM_CHARTER, WORK_PLACE_RULE, TASK_ROUTING_CONTRACT]) expect(repaired).toContain(text.trim())
    // USER.md rides the persona: this session has no session context to carry it.
    expect(repaired).toContain(fixtureUserMd().split('\n').find((l) => l.startsWith('- Keep'))!)
  })
})

describe('the drift repair of an ask minted before the caps', () => {
  beforeAll(async () => { await seedFixtureHome(WALNUT_HOME) })

  it('keeps the routing rules in its persona: its stored session context has none', async () => {
    const { addTask, updateTaskRaw } = await import('../../../src/core/task-manager.js')
    const { createSessionRecord, updateSessionRecord, getSessionByClaudeId } = await import('../../../src/core/session-tracker.js')
    const { refreshWalnutSessionProfile } = await import('../../../src/core/sessions/personal-ai-lane.js')
    const { task } = await addTask({ title: 'Which tasks moved this week?', project: 'Ask Walnut' } as never)
    await updateTaskRaw(task.id, () => ({ walnut_agent: true }))
    const sid = '44444444-5555-6666-7777-000000000002'
    await createSessionRecord(sid, task.id, 'Ask Walnut', WALNUT_HOME, { title: task.title })
    // As the deploy before found it: the whole persona (every rule) and an ask's stored context.
    const stored = defaultInstructions({ ...task, walnut_agent: true } as never)
    await updateSessionRecord(sid, { profile: { systemPrompt: whole, systemPromptMode: 'append' }, appliedAppendSystemPrompt: stored } as never)

    await refreshWalnutSessionProfile(sid)

    const repaired = (await getSessionByClaudeId(sid))!.profile!.systemPrompt!
    expect(repaired).toContain(TASK_ROUTING_CONTRACT.trim())
    // Its context carries the charter and where work lives: one copy, there.
    expect(repaired).not.toContain(TEAM_CHARTER.trim())
    expect(stored).toContain(TEAM_CHARTER.trim())
    // A cold resume has the routing rules in one half: the persona.
    expect(stored).not.toContain(TASK_ROUTING_CONTRACT.trim())
  })
})
