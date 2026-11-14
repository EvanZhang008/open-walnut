import { describe, expect, it } from 'vitest'
import type { RouterArea } from '../../src/core/router/areas.js'
import { isRouterAreaSession, routerAreaProfile } from '../../src/core/router/session-policy.js'
import type { SessionEngine, SessionProfile, SessionRecord } from '../../src/core/types.js'

type PolicyRecord = Pick<SessionRecord, 'profile' | 'host' | 'engine'>

function area(id: string, host = '__local__'): RouterArea {
  return { id, name: `Area ${id}`, host, taskIds: [`task-${id}`], sources: [] }
}

const PERSONAL = area('personal')
const WORK = area('work')

function record(overrides: Partial<PolicyRecord> = {}): PolicyRecord {
  return { profile: routerAreaProfile(PERSONAL.id), host: '', engine: undefined, ...overrides }
}

function withProfile(change: (profile: SessionProfile) => SessionProfile): PolicyRecord {
  return record({ profile: change(structuredClone(routerAreaProfile(PERSONAL.id))) })
}

describe('routerAreaProfile', () => {
  it('grants no built-in tool, only the scoped router tools, in a strict slim launch', () => {
    const profile = routerAreaProfile('personal')
    expect(profile.areaId).toBe('personal')
    expect(profile.slim).toBe(true)
    expect(profile.systemPromptMode).toBe('replace')
    // `--tools ''`: every built-in tool is gone, the explicit MCP mount stays.
    expect(profile.tools).toEqual([''])
    expect(profile.allowedTools).toEqual(['mcp__walnut__router_context', 'mcp__walnut__router_route'])
    expect(Object.keys(profile.mcpServers ?? {})).toEqual(['walnut'])
  })

  it('is the only isolated profile: a legacy work profile is no router session', () => {
    expect(routerAreaProfile('personal').areaRole).toBe('router')
    const legacy = { ...structuredClone(routerAreaProfile('personal')), areaRole: 'work' } as unknown as SessionProfile
    expect(isRouterAreaSession(record({ profile: legacy }), PERSONAL)).toBe(false)
  })

  it('tells the router it is the triage and never creates tasks', () => {
    const prompt = routerAreaProfile('personal').systemPrompt ?? ''
    expect(prompt).toMatch(/you are the triage/)
    expect(prompt).toMatch(/you never create tasks/)
    expect(prompt).not.toMatch(/new_task_title/)
  })

  it('names the area in its prompt, so two areas never share one profile', () => {
    expect(routerAreaProfile('personal').systemPrompt).not.toBe(routerAreaProfile('work').systemPrompt)
  })
})

describe('isRouterAreaSession', () => {
  const engines: Array<SessionEngine | undefined> = [undefined, 'claude']
  for (const engine of engines) {
    it(`accepts the exact profile on the area's host (engine ${engine ?? 'unset'})`, () => {
      expect(isRouterAreaSession(record({ engine }), PERSONAL)).toBe(true)
    })
  }

  it('treats an unset record host as the local host', () => {
    expect(isRouterAreaSession(record({ host: undefined }), PERSONAL)).toBe(true)
    expect(isRouterAreaSession(record({ host: '__local__' }), PERSONAL)).toBe(true)
  })

  const refused: Array<[string, PolicyRecord, RouterArea?]> = [
    ['no profile', record({ profile: undefined })],
    ['an extra Bash tool', withProfile((p) => ({ ...p, tools: [...p.tools!, 'Bash'] }))],
    ['an extra Read tool', withProfile((p) => ({ ...p, tools: [...p.tools!, 'Read'] }))],
    ['the full built-in tool set (tools unset)', withProfile((p) => ({ ...p, tools: undefined }))],
    // An empty list spawns no `--tools` flag at all (claude-code-session.ts), so it is the full set too.
    ['the full built-in tool set (tools empty)', withProfile((p) => ({ ...p, tools: [] }))],
    ['ToolSearch in place of no tools', withProfile((p) => ({ ...p, tools: ['ToolSearch'] }))],
    ['an extra pre-approved MCP tool', withProfile((p) => ({ ...p, allowedTools: [...p.allowedTools!, 'mcp__walnut__task_send'] }))],
    ['a pre-approved built-in tool', withProfile((p) => ({ ...p, allowedTools: [...p.allowedTools!, 'Bash'] }))],
    ['an extra MCP server', withProfile((p) => ({ ...p, mcpServers: { ...p.mcpServers, other: { command: '/bin/true', args: [] } } }))],
    ['a changed walnut MCP command', withProfile((p) => ({ ...p, mcpServers: { walnut: { command: '/bin/sh', args: ['-c', 'exec walnut mcp-server'] } } }))],
    ['no MCP servers', withProfile((p) => ({ ...p, mcpServers: undefined }))],
    ['slim off', withProfile((p) => ({ ...p, slim: false }))],
    ['slim unset', withProfile((p) => ({ ...p, slim: undefined }))],
    ['an appended prompt', withProfile((p) => ({ ...p, systemPromptMode: 'append' }))],
    ['an unset prompt mode (append by default)', withProfile((p) => ({ ...p, systemPromptMode: undefined }))],
    ['no area policy version', withProfile((p) => ({ ...p, areaPolicyVersion: undefined }))],
    ['an unsupported area policy version', withProfile((p) => ({ ...p, areaPolicyVersion: 2 }))],
    ['an empty prompt', withProfile((p) => ({ ...p, systemPrompt: '' }))],
    ['another area\'s profile', record({ profile: routerAreaProfile(WORK.id) })],
    ['the area id alone changed', withProfile((p) => ({ ...p, areaId: WORK.id }))],
    ['no area id', withProfile((p) => ({ ...p, areaId: undefined }))],
    ['a remote host', record({ host: 'devbox' })],
    ['a local record against a remote area', record(), area('personal', 'devbox')],
    ['the codex engine', record({ engine: 'codex' })],
    ['the gemini engine', record({ engine: 'gemini' })],
  ]
  for (const [name, rec, target] of refused) {
    it(`refuses ${name}`, () => {
      expect(isRouterAreaSession(rec, target ?? PERSONAL)).toBe(false)
    })
  }

  it('refuses a personal session for the work area and the other way round', () => {
    expect(isRouterAreaSession(record(), WORK)).toBe(false)
    expect(isRouterAreaSession(record({ profile: routerAreaProfile(WORK.id) }), WORK)).toBe(true)
    expect(isRouterAreaSession(record({ profile: routerAreaProfile(WORK.id) }), PERSONAL)).toBe(false)
  })
})
