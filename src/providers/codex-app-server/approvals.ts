/**
 * Codex's approval requests as the ACP `session/request_permission` the codex-acp
 * adapter sent (same option ids, kinds and `_meta`), and the chosen option back as
 * Codex's decision. Walnut's own auto-answers read `_meta.codex.params.command` and
 * `_meta.is_mcp_tool_approval` (acp-permission-posture.ts), and a person's card
 * picks by option kind (acp-session.ts resolvePermissionRequest), so both stay as
 * they were. An answer that is not a known option declines; a cancelled or failed
 * ask cancels.
 */

import { stripShellPrefix, type AcpUpdate, type CodexEventMapper } from './events.js'

export interface AcpPermissionOption { optionId: string; name: string; kind: string; _meta?: Record<string, unknown> }
export interface AcpPermissionRequest {
  sessionId: string
  toolCall: Record<string, unknown> & { toolCallId: string }
  options: AcpPermissionOption[]
  _meta?: Record<string, unknown>
}
export type AcpPermissionResponse = { outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

type Ask = { request: AcpPermissionRequest; decide: (optionId: string | null) => unknown; afterAllow?: AcpUpdate }

/** A server request Walnut does not answer: JSON-RPC's "method not found". */
export class MethodNotFoundError extends Error { readonly code = -32601 }

function commandAsk(sessionId: string, p: Record<string, unknown>): Ask {
  const command = str(p.command)
  const options: AcpPermissionOption[] = [
    { optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once', _meta: { codex: { decision: 'accept' } } },
    { optionId: 'allow_always', name: p.networkApprovalContext ? 'Allow Host for Session' : 'Allow for Session', kind: 'allow_always', _meta: { codex: { decision: 'acceptForSession' } } },
  ]
  const amendment = Array.isArray(p.proposedExecpolicyAmendment) ? p.proposedExecpolicyAmendment.filter((a): a is string => typeof a === 'string') : []
  if (amendment.length > 0) {
    const joined = amendment.join(' ')
    options.push({
      optionId: 'accept_execpolicy_amendment',
      name: !joined || /[\n\r]/.test(joined) ? 'Allow and Remember Command Pattern' : `Allow Commands Starting With \`${joined}\``,
      kind: 'allow_always',
    })
  }
  const network = Array.isArray(p.proposedNetworkPolicyAmendments) ? p.proposedNetworkPolicyAmendments.filter(isRecord) : []
  network.forEach((a, i) => options.push({
    optionId: `apply_network_policy_amendment:${i}`,
    name: a.action === 'allow' ? `Allow ${str(a.host)} in the Future` : `Block ${str(a.host)} in the Future`,
    kind: a.action === 'allow' ? 'allow_always' : 'reject_always',
  }))
  options.push({ optionId: 'reject_once', name: 'Reject', kind: 'reject_once', _meta: { codex: { decision: 'decline' } } })
  return {
    request: {
      sessionId,
      toolCall: { toolCallId: str(p.itemId) ?? 'command', kind: 'execute', status: 'pending', rawInput: command ? { command: stripShellPrefix(command), cwd: p.cwd } : null },
      options,
      _meta: { codex: { params: p } },
    },
    decide: (optionId) => {
      if (optionId === null) return { decision: 'cancel' }
      if (optionId === 'allow_once') return { decision: 'accept' }
      if (optionId === 'allow_always') return { decision: 'acceptForSession' }
      if (optionId === 'accept_execpolicy_amendment' && amendment.length > 0) return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } }
      const m = /^apply_network_policy_amendment:(\d+)$/.exec(optionId)
      if (m && network[Number(m[1])]) return { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: network[Number(m[1])] } } }
      return { decision: 'decline' }
    },
  }
}

function fileChangeAsk(sessionId: string, p: Record<string, unknown>): Ask {
  return {
    request: {
      sessionId,
      toolCall: { toolCallId: str(p.itemId) ?? 'edit', kind: 'edit', status: 'pending' },
      options: [
        { optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once', _meta: { codex: { decision: 'accept' } } },
        { optionId: 'allow_always', name: p.grantRoot ? 'Allow Root for Session' : 'Allow for Session', kind: 'allow_always', _meta: { codex: { decision: 'acceptForSession', grantRoot: p.grantRoot } } },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once', _meta: { codex: { decision: 'decline' } } },
      ],
      _meta: { codex: { params: p } },
    },
    decide: (optionId) => optionId === null ? { decision: 'cancel' }
      : optionId === 'allow_once' ? { decision: 'accept' }
        : optionId === 'allow_always' ? { decision: 'acceptForSession' } : { decision: 'decline' },
  }
}

function permissionsAsk(sessionId: string, p: Record<string, unknown>): Ask {
  const perms = isRecord(p.permissions) ? p.permissions : {}
  const lines: string[] = []
  if (str(p.reason)) lines.push(p.reason as string)
  const net = isRecord(perms.network) ? perms.network : undefined
  if (net && typeof net.enabled === 'boolean') lines.push(`Network Access: ${net.enabled}`)
  const fsPerm = isRecord(perms.fileSystem) ? perms.fileSystem : undefined
  if (fsPerm && Array.isArray(fsPerm.read) && fsPerm.read.length > 0) lines.push(`File System Read Access: ${fsPerm.read.join(', ')}`)
  if (fsPerm && Array.isArray(fsPerm.write) && fsPerm.write.length > 0) lines.push(`File System Write Access: ${fsPerm.write.join(', ')}`)
  if (fsPerm && fsPerm.entries !== undefined && fsPerm.entries !== null) lines.push(`File System Entries: ${JSON.stringify(fsPerm.entries)}`)
  const granted = { ...(perms.network !== undefined ? { network: perms.network } : {}), ...(perms.fileSystem !== undefined ? { fileSystem: perms.fileSystem } : {}) }
  return {
    request: {
      sessionId,
      toolCall: {
        toolCallId: str(p.itemId) ?? 'permissions', kind: 'other', status: 'pending', title: str(p.reason) ?? 'Permissions Request', rawInput: p,
        ...(lines.length > 0 ? { content: [{ type: 'content', content: { type: 'text', text: lines.join('\n\n') } }] } : {}),
      },
      options: [
        { optionId: 'allow_permissions_session', name: 'Allow for Session', kind: 'allow_always' },
        { optionId: 'allow_permissions_turn', name: 'Allow Once', kind: 'allow_once' },
        { optionId: 'reject_permissions', name: 'Reject', kind: 'reject_once' },
      ],
      _meta: { codex: { params: p } },
    },
    decide: (optionId) => optionId === 'allow_permissions_session' || optionId === 'allow_always'
      ? { permissions: granted, scope: 'session', strictAutoReview: false }
      : optionId === 'allow_permissions_turn' || optionId === 'allow_once'
        ? { permissions: granted, scope: 'turn', strictAutoReview: false }
        : { permissions: {}, scope: 'turn', strictAutoReview: true },
  }
}

function elicitationAsk(sessionId: string, p: Record<string, unknown>, events: CodexEventMapper): Ask {
  const meta = isRecord(p._meta) ? p._meta : {}
  const toolApproval = meta.codex_approval_kind === 'mcp_tool_call'
  const persist = Array.isArray(meta.persist) ? meta.persist : meta.persist !== undefined ? [meta.persist] : []
  const server = str(p.serverName) ?? 'mcp'
  const message = str(p.message) ?? ''
  const correlated = toolApproval ? events.mcpCallByServer.get(server) : undefined
  let toolCall: AcpPermissionRequest['toolCall']
  if (p.mode === 'url') {
    toolCall = {
      toolCallId: `elicitation-${str(p.elicitationId) ?? server}`, kind: 'fetch', status: 'pending',
      content: [{ type: 'content', content: { type: 'text', text: message } }], rawInput: { serverName: server, url: p.url },
    }
  } else if (correlated) {
    toolCall = { toolCallId: correlated, kind: 'execute', status: 'pending' }
  } else {
    toolCall = {
      toolCallId: `elicitation-${server}`, kind: toolApproval ? 'execute' : 'other', status: 'pending',
      content: [{ type: 'content', content: { type: 'text', text: message } }], rawInput: { serverName: server, schema: p.requestedSchema },
    }
  }
  const options: AcpPermissionOption[] = toolApproval
    ? [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        ...(persist.includes('session') ? [{ optionId: 'allow_session', name: 'Allow for This Session', kind: 'allow_always' }] : []),
        ...(persist.includes('always') ? [{ optionId: 'allow_always', name: 'Allow and Don\'t Ask Again', kind: 'allow_always' }] : []),
        { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
      ]
    : [{ optionId: 'accept', name: 'Accept', kind: 'allow_once' }, { optionId: 'decline', name: 'Decline', kind: 'reject_once' }]
  return {
    request: { sessionId, toolCall, options, ...(toolApproval ? { _meta: { is_mcp_tool_approval: true } } : {}) },
    decide: (optionId) => optionId === null ? { action: 'cancel', content: null, _meta: null }
      : optionId === 'allow_session' ? { action: 'accept', content: null, _meta: { persist: 'session' } }
        : optionId === 'allow_always' ? { action: 'accept', content: null, _meta: { persist: 'always' } }
          : optionId === 'allow_once' || optionId === 'accept' ? { action: 'accept', content: null, _meta: null }
            : { action: 'decline', content: null, _meta: null },
    ...(correlated ? { afterAllow: { sessionUpdate: 'tool_call_update', toolCallId: correlated, status: 'in_progress' } } : {}),
  }
}

export class CodexApprovals {
  private open = 0
  private cancels = new Set<() => void>()

  constructor(
    private readonly ask: (req: AcpPermissionRequest) => Promise<AcpPermissionResponse>,
    private readonly sessionId: () => string,
    private readonly events: CodexEventMapper,
    private readonly emit: (update: AcpUpdate) => void = () => {},
  ) {}

  /** A person (or Walnut's own answer) is being waited on: the stall watchdog holds still. */
  get waiting(): boolean { return this.open > 0 }

  async answer(method: string, params: unknown): Promise<unknown> {
    const p = isRecord(params) ? params : {}
    const sid = this.sessionId()
    let ask: Ask
    switch (method) {
      case 'item/commandExecution/requestApproval': ask = commandAsk(sid, p); break
      case 'item/fileChange/requestApproval': ask = fileChangeAsk(sid, p); break
      case 'item/permissions/requestApproval': ask = permissionsAsk(sid, p); break
      case 'mcpServer/elicitation/request': ask = elicitationAsk(sid, p, this.events); break
      // No form support: an empty answer, as the adapter gave one.
      case 'item/tool/requestUserInput': return { answers: {} }
      default: throw new MethodNotFoundError(`${method} is not supported by Walnut`)
    }
    this.open++
    try {
      const response = await new Promise<AcpPermissionResponse>((resolve) => {
        const cancel = () => resolve({ outcome: { outcome: 'cancelled' } })
        this.cancels.add(cancel)
        this.ask(ask.request).then(resolve, cancel).finally(() => this.cancels.delete(cancel))
      })
      const optionId = response.outcome.outcome === 'selected' ? response.outcome.optionId : null
      const decision = ask.decide(optionId)
      if (ask.afterAllow && optionId !== null && optionId !== 'decline') this.emit(ask.afterAllow)
      return decision
    } finally {
      this.open--
    }
  }

  /**
   * A plan Codex finished in plan mode: implement it? The adapter's card (same ids, kind
   * switch_mode, `_meta.codex.kind` plan_review). True only for "Yes, implement".
   */
  async askPlan(planItemId: string, plan: string): Promise<boolean> {
    const request: AcpPermissionRequest = {
      sessionId: this.sessionId(),
      toolCall: { toolCallId: `plan-review:${planItemId}`, title: 'Implement this plan?', kind: 'switch_mode', status: 'pending', rawInput: { plan } },
      options: [
        { optionId: 'implement_plan', name: 'Yes, implement this plan', kind: 'allow_once' },
        { optionId: 'revise_plan', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
      ],
      _meta: { codex: { kind: 'plan_review', planItemId } },
    }
    this.open++
    try {
      const response = await new Promise<AcpPermissionResponse>((resolve) => {
        const cancel = () => resolve({ outcome: { outcome: 'cancelled' } })
        this.cancels.add(cancel)
        this.ask(request).then(resolve, cancel).finally(() => this.cancels.delete(cancel))
      })
      const approved = response.outcome.outcome === 'selected' && response.outcome.optionId === 'implement_plan'
      const words = approved ? 'User approved the plan.'
        : response.outcome.outcome === 'cancelled' ? 'Stopped before an answer.' : 'User kept the session in plan mode.'
      this.emit({ sessionUpdate: 'tool_call_update', toolCallId: request.toolCall.toolCallId, status: 'completed', rawOutput: words })
      return approved
    } finally {
      this.open--
    }
  }

  /** The app-server is gone: every open ask is answered cancelled. */
  cancelAll(): void {
    for (const cancel of [...this.cancels]) cancel()
  }
}
