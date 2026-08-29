/** Unified agent.* daemon command family → legacy per-engine handler mapping (agent-commands-v1). */

/**
 * FIRST slice of the platform's L2 unification (docs/plan/
 * agent-provider-platform.md P1): the daemon today carries TWO parallel command
 * families — `start/send/stop/...` for the Claude CLI and `acpStart/acpSend/
 * acpStop/...` for ACP — so every caller has to know which vendor it is talking
 * to before it can name a command. This module gives the daemon ONE namespace
 * (`agent.*`) and does the engine routing in one table, so the namespace and the
 * engine dispatch are unified NOW while both legacy families keep working
 * untouched underneath.
 *
 * What this slice deliberately does NOT do: unify payload shapes or semantics.
 * `agent.send` still carries whatever the routed handler expects, and the two
 * families still differ in how they name ids, report state, and answer errors.
 * That unification arrives with the shared supervisor (same plan, P1's second
 * half), which is where the payload contract can be changed once for both
 * transports instead of twice.
 *
 * Keep this module dependency-free (no imports from src/core) — daemon-standalone
 * bundles it into the compiled bun binary, and the source twin inlines a copy of
 * `resolveAgentCommand` by hand (see the twin-sync comment there).
 */

export const AGENT_OPS = ['start', 'send', 'steer', 'cancel', 'respond', 'setOption', 'state', 'newSession', 'stop', 'subscribe'] as const

export type AgentOp = typeof AGENT_OPS[number]

export type AgentCommandRoute =
  | { ok: true; cmd: string; acpOp?: string }
  | { ok: false; error: string; errorKind: 'agent_op_unsupported' | 'agent_op_unknown' }

/** engine 'codex' → the ACP worker family. */
const CODEX_ROUTES: Record<AgentOp, string> = {
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

/**
 * Anything that is not 'codex' → the native (Claude CLI, stream-json over FIFO)
 * family. Ops the native transport has no daemon command for are refused with a
 * reason rather than silently mapped onto a near-miss handler.
 */
const NATIVE_ROUTES: Record<AgentOp, string | null> = {
  start: 'start',
  send: 'send',
  // A FIFO write IS the native mid-turn path — the long-running CLI reads new
  // input from its stdin FIFO between and DURING turns, so steering a native
  // session is just an ordinary send.
  steer: 'send',
  cancel: null,
  respond: null,
  setOption: 'setMode',
  state: 'getState',
  newSession: null,
  stop: 'stop',
  subscribe: null,
}

const NATIVE_UNSUPPORTED_REASON: Record<string, string> = {
  cancel: 'native interrupts ride sendRaw control frames',
  respond: 'native permission resolution happens over the CLI control protocol, not a daemon command',
  newSession: 'native sessions are created via start',
  subscribe: 'native subscription is implicit in start/attach',
}

/**
 * Resolve one `agent.<op>` command to the legacy per-engine daemon command that
 * implements it. `engine` is whatever the caller put on the command frame —
 * undefined/null/'claude'/any unknown engine all route to the native family.
 */
export function resolveAgentCommand(engine: unknown, op: unknown): AgentCommandRoute {
  if (typeof op !== 'string' || !(AGENT_OPS as readonly string[]).includes(op)) {
    return { ok: false, error: `unknown agent op: ${String(op)}`, errorKind: 'agent_op_unknown' }
  }
  const agentOp = op as AgentOp
  if (engine === 'codex') {
    const cmd = CODEX_ROUTES[agentOp]
    return { ok: true, cmd }
  }
  const cmd = NATIVE_ROUTES[agentOp]
  if (!cmd) {
    return {
      ok: false,
      error: `agent.${agentOp} is not supported for the native engine (${NATIVE_UNSUPPORTED_REASON[agentOp]})`,
      errorKind: 'agent_op_unsupported',
    }
  }
  return { ok: true, cmd }
}
