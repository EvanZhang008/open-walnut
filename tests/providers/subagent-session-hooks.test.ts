/**
 * A subagent's session (subagent_run with host, core/subagents/on-host.ts) acts as its caller:
 * its `walnut` calls carry the caller's identity (acp-caller-sid.ts setCallerAlias). A hook that
 * asks Walnut what is still open "for this session" (open_items) would read the caller's open
 * requests and asks, and the subagent would spend its last turn answering them in place of its
 * own answer (2026-11-16, proof run sa-c426610a4b: its answer was a reply to the caller's Stop
 * hook reminder). So no hook of a subagent's session calls open_items, whatever hook is added,
 * while every guard hook a task session has stays.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'
import { isSubagentLane, SUBAGENT_LANE_PREFIX } from '../../src/core/subagents/types.js'

const env = {} as NodeJS.ProcessEnv
const commands = (hooks: Record<string, unknown> | null): string[] => JSON.stringify(hooks ?? {}).match(/"command":"(?:[^"\\]|\\.)*"/g) ?? []

describe('the hooks of a subagent\'s session', () => {
  it('include no hook that reads open items, and every other hook a task session has', () => {
    const task = commands(sessionSettingsHooks(env))
    const sub = commands(sessionSettingsHooks(env, { subagent: true }))
    // The task session's own does read them (else this guard would check nothing).
    expect(task.some((c) => c.includes('open_items'))).toBe(true)
    expect(sub.filter((c) => c.includes('open_items'))).toEqual([])
    // Nothing else is dropped: the subagent's hooks are the task session's minus those.
    expect(sub).toEqual(task.filter((c) => !c.includes('open_items')))
  })

  it('are chosen from the lane its session starts in', () => {
    expect(isSubagentLane(`${SUBAGENT_LANE_PREFIX}acp-123`)).toBe(true)
    expect(isSubagentLane('side:abc')).toBe(false)
    expect(isSubagentLane(undefined)).toBe(false)
  })
  it('reach the CLI: the session spawn hands its lane to the hooks', () => {
    // The one spawn path of a native session (send()); a subagent's starts there through SESSION_START.
    const src = fs.readFileSync(new URL('../../src/providers/claude-code-session.ts', import.meta.url), 'utf8')
    const calls = src.match(/sessionSettingsHooks\([^)]*\)[^\n]*/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c).toContain('subagent: isSubagentLane(this._lane)')
  })
})
