/**
 * No "Fix with agent" while an agent cannot run on this computer (review round 2,
 * D08): with Claude Code missing, a repair session failed the same way as the error
 * it was asked to fix, and the bell gained one more error. The setup card's install
 * or sign-in step is the way on.
 *
 * Guard: every component that starts a repair (startNotificationFix / runHostFix)
 * reads the gate, so a new Fix with agent surface fails here until it does.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentCannotRun } from '../../web/src/utils/local-claude-banner'
import { localAgentBlocked, noteLocalAgentHealth } from '../../web/src/utils/local-agent-runnable'
import type { SystemHealth } from '../../web/src/hooks/useSystemHealth'
import { AGENT_CANNOT_RUN_KINDS } from '../../src/core/hosts/host-problem'
import { READINESS_PROBLEM_KINDS } from '../../src/core/hosts/host-readiness-problems'

const MISSING = { kind: 'claude_missing', message: 'Claude Code is not installed on this computer.', commands: ['install'] }
const SIGN_IN = { kind: 'claude_not_logged_in', message: 'Claude Code is not signed in.', commands: ['claude'] }
const OUTDATED = { kind: 'claude_outdated', message: 'Claude Code is old.', commands: ['claude update'] }
const local = (problems: unknown[]) => ({ claude: { found: true }, problems, checkedAt: 1, source: 'daemon' }) as unknown as SystemHealth['localClaude']
const ready: SystemHealth = { hasReadyProvider: true, claudeCliAvailable: true }

describe('agentCannotRun', () => {
  it('missing, unable to start or signed out blocks an agent; outdated and ready do not', () => {
    expect(agentCannotRun({ ...ready, localClaude: local([MISSING]) })).toBe(true)
    expect(agentCannotRun({ ...ready, claudeCliAvailable: false })).toBe(true)
    expect(agentCannotRun({ ...ready, localClaude: local([{ kind: 'claude_error', message: 'did not start', commands: [] }]) })).toBe(true)
    expect(agentCannotRun({ ...ready, localClaude: local([SIGN_IN]) })).toBe(true)
    expect(agentCannotRun({ ...ready, localClaude: local([OUTDATED]) })).toBe(false)
    expect(agentCannotRun(ready)).toBe(false)
    // No health read yet: nothing is hidden on a guess.
    expect(agentCannotRun(undefined)).toBe(false)
    expect(agentCannotRun({})).toBe(false)
  })

  it('the shared store follows the latest health read, both ways', () => {
    noteLocalAgentHealth({ ...ready, localClaude: local([MISSING]) })
    expect(localAgentBlocked()).toBe(true)
    noteLocalAgentHealth(ready)
    expect(localAgentBlocked()).toBe(false)
  })
})

describe('guard: every Fix with agent surface reads the gate', () => {
  const WEB = path.join(__dirname, '../../web/src')
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [])
  // The plumbing that performs a start; the components that offer one are what this checks.
  const PLUMBING = new Set(['api/notifications.ts', 'api/config.ts', 'utils/host-fix-store.ts'])

  it('a component that starts a repair also reads useLocalAgentBlocked or agentCannotRun', () => {
    const starters = walk(WEB)
      .map((f) => ({ rel: path.relative(WEB, f), text: fs.readFileSync(f, 'utf8') }))
      .filter((f) => !PLUMBING.has(f.rel) && /\b(startNotificationFix|runHostFix)\(/.test(f.text))
    expect(starters.map((f) => f.rel).sort()).toEqual(['components/common/HostFixButton.tsx', 'components/common/NotificationPanel.tsx'])
    for (const f of starters) expect(f.text, f.rel).toMatch(/useLocalAgentBlocked\(|agentCannotRun\(/)
  })

  it('the health hook feeds the store on every read', () => {
    const hook = fs.readFileSync(path.join(WEB, 'hooks/useSystemHealth.ts'), 'utf8')
    expect(hook.match(/setHealth\(data/g)?.length).toBe(hook.match(/noteLocalAgentHealth\(data/g)?.length)
  })
})

describe('the web gate and the server refusal judge every readiness kind alike', () => {
  const SRC = path.join(__dirname, '../../src')
  // Every kind the readiness code can report: its type is derived from this list, so a new kind is judged here.
  const kinds: string[] = [...READINESS_PROBLEM_KINDS]

  it('a kind blocks the web\'s Fix with agent exactly when the server refuses the repair', () => {
    expect(kinds).toContain('claude_error')
    for (const kind of kinds) {
      const web = agentCannotRun({ ...ready, localClaude: local([{ kind, message: kind, commands: [] }]) })
      expect(web, kind).toBe(AGENT_CANNOT_RUN_KINDS.includes(kind))
    }
  })

  it('the server reads the shared list, never a list of its own', () => {
    const route = fs.readFileSync(path.join(SRC, 'web/routes/notifications.ts'), 'utf8')
    expect(route).toMatch(/AGENT_BLOCKING_KINDS = new Set\(AGENT_CANNOT_RUN_KINDS\)/)
    expect(route).not.toMatch(/new Set\(\[\s*'claude_/)
  })
})
