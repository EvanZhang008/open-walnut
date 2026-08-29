/**
 * L1 pure-logic tests for the unified `agent.*` daemon command family
 * (agent-commands-v1, docs/plan/agent-provider-platform.md P1).
 *
 * resolveAgentCommand is the whole routing contract: one namespace in, one
 * legacy per-engine daemon command out. Both daemon twins dispatch through it
 * (the source twin via a hand-inlined copy), so the table is pinned here plus a
 * cheap text-parity guard over the template.
 *
 * No spawning, no fs writes — the module is dependency-free by design.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_OPS, resolveAgentCommand, type AgentOp } from '../../src/providers/agent-command-map.js'

const ROOT = path.resolve(__dirname, '../..')

describe('resolveAgentCommand — codex (ACP family)', () => {
  const table: Record<AgentOp, string> = {
    start: 'acpStart',
    send: 'acpSend',
    steer: 'acpSteer',
    cancel: 'acpCancel',
    respond: 'acpRespond',
    setOption: 'acpSetConfigOption',
    state: 'acpState',
    newSession: 'acpNewSession',
    stop: 'acpStop',
    subscribe: 'acpSubscribe',
  }

  for (const [op, cmd] of Object.entries(table)) {
    it(`agent.${op} → ${cmd}`, () => {
      expect(resolveAgentCommand('codex', op)).toEqual({ ok: true, cmd })
    })
  }

  it('routes every declared op (no op silently unsupported on codex)', () => {
    for (const op of AGENT_OPS) {
      expect(resolveAgentCommand('codex', op).ok, `codex ${op}`).toBe(true)
    }
  })
})

describe('resolveAgentCommand — native family', () => {
  const supported: Partial<Record<AgentOp, string>> = {
    start: 'start',
    send: 'send',
    // A FIFO write IS the native mid-turn path: steering a native session is an
    // ordinary send into the long-running CLI's stdin.
    steer: 'send',
    setOption: 'setMode',
    state: 'getState',
    stop: 'stop',
  }

  for (const [op, cmd] of Object.entries(supported)) {
    it(`agent.${op} → ${cmd}`, () => {
      expect(resolveAgentCommand('claude', op)).toEqual({ ok: true, cmd })
    })
  }

  const unsupported: Record<string, string> = {
    cancel: 'native interrupts ride sendRaw control frames',
    respond: 'native permission resolution happens over the CLI control protocol, not a daemon command',
    newSession: 'native sessions are created via start',
    subscribe: 'native subscription is implicit in start/attach',
  }

  for (const [op, reason] of Object.entries(unsupported)) {
    it(`agent.${op} is refused with agent_op_unsupported and a reason`, () => {
      const route = resolveAgentCommand('claude', op)
      expect(route).toEqual({
        ok: false,
        errorKind: 'agent_op_unsupported',
        error: `agent.${op} is not supported for the native engine (${reason})`,
      })
    })
  }

  it('every declared op either routes or is refused with a reason (no silent near-miss)', () => {
    for (const op of AGENT_OPS) {
      const route = resolveAgentCommand('claude', op)
      if (route.ok) expect(route.cmd, `native ${op}`).toBeTruthy()
      else expect(route.errorKind, `native ${op}`).toBe('agent_op_unsupported')
    }
    expect(Object.keys(supported).length + Object.keys(unsupported).length).toBe(AGENT_OPS.length)
  })
})

describe('resolveAgentCommand — engine selection', () => {
  it('undefined / null / claude / an unknown engine all route native', () => {
    for (const engine of [undefined, null, 'claude', 'opencode', '', 42, {}]) {
      expect(resolveAgentCommand(engine, 'send'), `engine=${String(engine)}`).toEqual({ ok: true, cmd: 'send' })
    }
  })

  it("only the exact string 'codex' routes to the ACP family", () => {
    expect(resolveAgentCommand('codex', 'send')).toEqual({ ok: true, cmd: 'acpSend' })
    expect(resolveAgentCommand('Codex', 'send')).toEqual({ ok: true, cmd: 'send' })
  })

  it('the native-only refusals apply per engine, not globally', () => {
    expect(resolveAgentCommand('codex', 'cancel')).toEqual({ ok: true, cmd: 'acpCancel' })
    expect(resolveAgentCommand('claude', 'cancel').ok).toBe(false)
  })
})

describe('resolveAgentCommand — unknown ops', () => {
  it('an op outside AGENT_OPS is agent_op_unknown for either engine', () => {
    for (const engine of ['codex', 'claude', undefined]) {
      expect(resolveAgentCommand(engine, 'history')).toEqual({
        ok: false, errorKind: 'agent_op_unknown', error: 'unknown agent op: history',
      })
    }
  })

  it('non-string / prototype-shaped ops are rejected, never resolved', () => {
    for (const op of [undefined, null, 42, {}, [], 'constructor', 'hasOwnProperty', 'Start', 'agent.send']) {
      const route = resolveAgentCommand('claude', op)
      expect(route.ok, `op=${String(op)}`).toBe(false)
      if (!route.ok) expect(route.errorKind).toBe('agent_op_unknown')
    }
  })
})

describe('daemon-source twin carries the agent.* dispatch block', () => {
  // The SSH-deployed template can't import the module, so it inlines a copy.
  // Cheap sync guard: the case labels and the inlined resolver must be present.
  const templateSrc = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8')

  it("has the case 'agent.start': entry point", () => {
    expect(templateSrc).toContain("case 'agent.start':")
  })

  it('has a case label for every declared op', () => {
    for (const op of AGENT_OPS) {
      expect(templateSrc, `missing case 'agent.${op}':`).toContain(`case 'agent.${op}':`)
    }
  })

  it('inlines resolveAgentCommand and names the module it must stay in sync with', () => {
    expect(templateSrc).toMatch(/function resolveAgentCommand\(engine, op\)/)
    expect(templateSrc).toContain('Keep in sync with src/providers/agent-command-map.ts')
  })

  it('replies with the structured errorKind instead of a bare error', () => {
    expect(templateSrc).toMatch(/errorKind:\s*agentRoute\.errorKind/)
  })

  it('BEHAVIORAL parity: the inlined routing table answers every (engine, op) pair identically', () => {
    // Text presence can't catch a drifted table VALUE ('setOption' → 'setmode'
    // in one twin only). Extract the inlined block, evaluate it, and sweep the
    // full matrix against the module. The extracted text is our own source.
    const start = templateSrc.indexOf('var AGENT_CODEX_ROUTES')
    expect(start, 'inlined AGENT_CODEX_ROUTES not found').toBeGreaterThan(-1)
    const end = templateSrc.indexOf('function dispatchCommand', start)
    expect(end, 'dispatchCommand after the inlined resolver not found').toBeGreaterThan(start)
    const block = templateSrc.slice(start, end)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const inlined = new Function(`${block}; return resolveAgentCommand;`)() as typeof resolveAgentCommand
    const engines = [undefined, null, 'claude', 'codex', 'opencode', ''] as const
    for (const engine of engines) {
      for (const op of [...AGENT_OPS, 'bogus']) {
        expect(inlined(engine, op), `divergence at (${String(engine)}, ${op})`)
          .toEqual(resolveAgentCommand(engine, op))
      }
    }
  })
})

describe('daemon-standalone twin carries the agent.* dispatch block', () => {
  const standaloneSrc = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')

  it('has a case label for every declared op', () => {
    for (const op of AGENT_OPS) {
      expect(standaloneSrc, `missing case 'agent.${op}':`).toContain(`case 'agent.${op}':`)
    }
  })
})

describe('bridge allowlist never exposes agent.*', () => {
  // The agent.* re-dispatch bypasses the bridge allowlist check by
  // construction (the allowlist runs BEFORE dispatch). Adding agent.start
  // "for symmetry" would hand a compromised cloud box arbitrary-argv spawn —
  // pin the invariant on both twins.
  for (const file of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
    it(`${file} BRIDGE_ALLOWED_COMMANDS has no agent.* entry`, () => {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf-8')
      const defStart = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
      expect(defStart, 'BRIDGE_ALLOWED_COMMANDS not found').toBeGreaterThan(-1)
      const defEnd = src.indexOf('])', defStart)
      expect(defEnd, 'BRIDGE_ALLOWED_COMMANDS closing ]) not found').toBeGreaterThan(defStart)
      const block = src.slice(defStart, defEnd)
      expect(block).not.toMatch(/['"]agent\./)
    })
  }
})
