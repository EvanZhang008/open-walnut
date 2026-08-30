/**
 * L1 pure-logic tests for the unified `agent.*` daemon command family
 * (agent-commands-v1, docs/plan/agent-provider-platform.md P1).
 *
 * resolveAgentCommand is the whole routing contract: one namespace in, one
 * legacy per-engine daemon command out. Both daemon twins dispatch through it
 * (the source twin via a hand-inlined copy), so the table is pinned here plus a
 * cheap text-parity guard over the template.
 *
 * The module is dependency-free on purpose (the bun daemon bundles it), so it
 * duplicates the "which engines are ACP" answer that engine-registry owns. That
 * duplication is pinned by the registry-consistency test below.
 *
 * No spawning, no fs writes.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ACP_ENGINES, AGENT_OPS, resolveAgentCommand, type AgentOp } from '../../src/providers/agent-command-map.js'
import { acpEngineIds } from '../../src/core/agents/engine-registry.js'
import { SESSION_ENGINE_IDS } from '../../src/core/types.js'

const ROOT = path.resolve(__dirname, '../..')

const ACP_TABLE: Record<AgentOp, string> = {
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

const NATIVE_SUPPORTED: Partial<Record<AgentOp, string>> = {
  start: 'start',
  send: 'send',
  // A FIFO write IS the native mid-turn path: steering a native session is an
  // ordinary send into the long-running CLI's stdin.
  steer: 'send',
  setOption: 'setMode',
  state: 'getState',
  stop: 'stop',
}

const NATIVE_UNSUPPORTED: Record<string, string> = {
  cancel: 'native interrupts ride sendRaw control frames',
  respond: 'native permission resolution happens over the CLI control protocol, not a daemon command',
  newSession: 'native sessions are created via start',
  subscribe: 'native subscription is implicit in start/attach',
}

// Every ACP engine rides the same worker family, so the full op matrix must
// answer identically for all of them — that is the whole point of ACP_ENGINES.
describe.each(acpEngineIds())('resolveAgentCommand — %s (ACP family)', (engine) => {
  for (const [op, cmd] of Object.entries(ACP_TABLE)) {
    it(`agent.${op} → ${cmd}`, () => {
      expect(resolveAgentCommand(engine, op)).toEqual({ ok: true, cmd })
    })
  }

  it('routes every declared op (no op silently unsupported on an ACP engine)', () => {
    for (const op of AGENT_OPS) {
      expect(resolveAgentCommand(engine, op).ok, `${engine} ${op}`).toBe(true)
    }
  })
})

describe('resolveAgentCommand — native family', () => {
  for (const [op, cmd] of Object.entries(NATIVE_SUPPORTED)) {
    it(`agent.${op} → ${cmd}`, () => {
      expect(resolveAgentCommand('claude', op)).toEqual({ ok: true, cmd })
    })
  }

  for (const [op, reason] of Object.entries(NATIVE_UNSUPPORTED)) {
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
    expect(Object.keys(NATIVE_SUPPORTED).length + Object.keys(NATIVE_UNSUPPORTED).length).toBe(AGENT_OPS.length)
  })
})

describe('resolveAgentCommand — engine selection', () => {
  it('undefined / null / claude / an unknown engine all route native', () => {
    for (const engine of [undefined, null, 'claude', 'some-future-engine', '', 42, {}]) {
      expect(resolveAgentCommand(engine, 'send'), `engine=${String(engine)}`).toEqual({ ok: true, cmd: 'send' })
    }
  })

  it('every registered engine routes to its own family, for every op', () => {
    const acp = new Set<string>(acpEngineIds())
    for (const engine of SESSION_ENGINE_IDS) {
      for (const op of AGENT_OPS) {
        const route = resolveAgentCommand(engine, op)
        if (acp.has(engine)) {
          expect(route, `${engine} ${op}`).toEqual({ ok: true, cmd: ACP_TABLE[op] })
        } else if (NATIVE_SUPPORTED[op]) {
          expect(route, `${engine} ${op}`).toEqual({ ok: true, cmd: NATIVE_SUPPORTED[op] })
        } else {
          expect(route.ok, `${engine} ${op}`).toBe(false)
        }
      }
    }
  })

  it('engine matching is exact and case-sensitive (no fuzzy vendor match)', () => {
    for (const engine of acpEngineIds()) {
      expect(resolveAgentCommand(engine, 'send')).toEqual({ ok: true, cmd: 'acpSend' })
      const shouted = engine.toUpperCase()
      expect(resolveAgentCommand(shouted, 'send'), `engine=${shouted}`).toEqual({ ok: true, cmd: 'send' })
      expect(resolveAgentCommand(` ${engine}`, 'send'), `engine=" ${engine}"`).toEqual({ ok: true, cmd: 'send' })
    }
  })

  it('the native-only refusals apply per engine, not globally', () => {
    expect(resolveAgentCommand('codex', 'cancel')).toEqual({ ok: true, cmd: 'acpCancel' })
    expect(resolveAgentCommand('gemini', 'cancel')).toEqual({ ok: true, cmd: 'acpCancel' })
    expect(resolveAgentCommand('claude', 'cancel').ok).toBe(false)
  })
})

describe('ACP_ENGINES stays in sync with the engine registry', () => {
  it('the dependency-free set equals registry runtimeKind==="acp"', () => {
    expect([...ACP_ENGINES].sort()).toEqual([...acpEngineIds()].sort())
  })

  it('every member is a registered engine (no phantom vendor in the set)', () => {
    for (const engine of ACP_ENGINES) {
      expect(SESSION_ENGINE_IDS as readonly string[], `${engine} is not a registered engine`).toContain(engine)
    }
  })

  it('the default engine is never in the ACP set', () => {
    expect(ACP_ENGINES.has('claude')).toBe(false)
  })
})

describe('resolveAgentCommand — unknown ops', () => {
  it('an op outside AGENT_OPS is agent_op_unknown for either engine', () => {
    for (const engine of ['codex', 'goose', 'claude', undefined]) {
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

  it('prototype-shaped ENGINES do not sneak into the ACP family', () => {
    for (const engine of ['constructor', 'hasOwnProperty', '__proto__', 'toString']) {
      expect(resolveAgentCommand(engine, 'send'), `engine=${engine}`).toEqual({ ok: true, cmd: 'send' })
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
    const start = templateSrc.indexOf('var AGENT_ACP_ENGINES')
    expect(start, 'inlined AGENT_ACP_ENGINES not found').toBeGreaterThan(-1)
    const end = templateSrc.indexOf('function dispatchCommand', start)
    expect(end, 'dispatchCommand after the inlined resolver not found').toBeGreaterThan(start)
    const block = templateSrc.slice(start, end)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const inlined = new Function(`${block}; return resolveAgentCommand;`)() as typeof resolveAgentCommand
    const engines = [
      undefined, null, '', 'claude', 'some-future-engine', 'constructor', 'CODEX',
      ...SESSION_ENGINE_IDS,
    ]
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
