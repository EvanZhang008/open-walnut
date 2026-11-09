/**
 * The session controls a direct Codex session shows: the same as the codex-acp
 * adapter (mode, collaboration mode, model, reasoning effort), with the same ids and
 * values, so a session record written under the adapter keeps working here and
 * back (acp-session.ts replays `acpConfig` by these ids).
 *
 * A change applies from the next turn (turnParams). The model and effort are sent only
 * once the session picked one: until then the thread runs on what Codex resolved from
 * the host's own config (and engines.codex, which reaches it through the thread config).
 */

import { mapCodexModels, type CodexModelRow } from '../codex-model-probe.js'

export interface CodexAgentMode {
  id: 'read-only' | 'agent' | 'agent-full-access'
  name: string
  description: string
  approvalPolicy: 'on-request' | 'never'
  sandboxPolicy: Record<string, unknown>
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
}

export const CODEX_AGENT_MODES: readonly CodexAgentMode[] = [
  {
    id: 'read-only', name: 'Read-only', description: 'Requires approval to edit files and run commands.',
    approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false }, sandboxMode: 'read-only',
  },
  {
    id: 'agent', name: 'Agent', description: 'Read and edit files, and run commands.',
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    sandboxMode: 'workspace-write',
  },
  {
    id: 'agent-full-access', name: 'Agent (full access)',
    description: 'Codex can edit files outside this workspace and run commands with network access. Exercise caution when using.',
    approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, sandboxMode: 'danger-full-access',
  },
]

export function findAgentMode(id: string | undefined): CodexAgentMode | undefined {
  return CODEX_AGENT_MODES.find((m) => m.id === id)
}

/** INITIAL_AGENT_MODE as the adapter read it: an unknown or absent value is `agent`. */
export function initialAgentMode(env: NodeJS.ProcessEnv): CodexAgentMode {
  return findAgentMode(env.INITIAL_AGENT_MODE) ?? CODEX_AGENT_MODES[1]
}

export type CollaborationMode = 'default' | 'plan'

/** The host's `[sandbox_workspace_write]` table, as config/read gives it. */
export interface WorkspaceWriteTable {
  writable_roots?: unknown
  network_access?: unknown
  exclude_tmpdir_env_var?: unknown
  exclude_slash_tmp?: unknown
}

export class CodexSessionControls {
  mode: CodexAgentMode
  /** Plan or default (Codex's collaboration mode); sent once the session set it. */
  collaboration: CollaborationMode = 'default'
  private collaborationSet = false
  /** The host's own workspace-write settings, laid under the Agent mode's sandbox. */
  private workspaceWrite: WorkspaceWriteTable | undefined
  model: string | undefined
  effort: string | undefined
  /** The session chose a model or effort (set_config_option): from then on each turn names both. */
  picked = false
  rows: CodexModelRow[] = []

  constructor(mode: CodexAgentMode) { this.mode = mode }

  adoptThread(model: string | null | undefined, effort: string | null | undefined): void {
    if (model) this.model = model
    if (effort) this.effort = effort
    if (!this.effort && this.model) this.effort = this.rows.find((r) => r.id === this.model)?.defaultReasoningEffort
  }

  /**
   * What a turn/start carries: the session mode's approval and sandbox policy (Walnut's
   * permission posture, as the adapter sent it), and the model and effort only once the
   * session picked them. Nothing else: the reasoning summary, service tier and the rest
   * stay as the host's Codex config has them. Codex keeps what a turn names for the turns
   * after it, so a change made between turns applies from the next one.
   */
  turnParams(): Record<string, unknown> {
    return {
      approvalPolicy: this.mode.approvalPolicy,
      sandboxPolicy: this.sandboxPolicy(),
      ...(this.picked && this.model ? { model: this.model } : {}),
      ...(this.picked && this.effort ? { effort: this.effort } : {}),
      // Codex's collaboration mode names a model: the one the thread runs on, picked or not.
      ...(this.collaborationSet && this.model ? {
        collaborationMode: { mode: this.collaboration, settings: { model: this.model, reasoning_effort: this.effort ?? null, developer_instructions: null } },
      } : {}),
    }
  }

  /** The host config's workspace-write table (writable roots, network): kept under the Agent mode. */
  adoptWorkspaceWrite(table: WorkspaceWriteTable | undefined): void { this.workspaceWrite = table }

  /** The mode's sandbox, with the host's own workspace-write settings where the mode writes the workspace. */
  sandboxPolicy(): Record<string, unknown> {
    const policy = this.mode.sandboxPolicy
    const t = this.workspaceWrite
    if (policy.type !== 'workspaceWrite' || !t) return policy
    const roots = Array.isArray(t.writable_roots) ? t.writable_roots.filter((r): r is string => typeof r === 'string') : []
    return {
      ...policy,
      writableRoots: roots,
      ...(typeof t.network_access === 'boolean' ? { networkAccess: t.network_access } : {}),
      ...(typeof t.exclude_tmpdir_env_var === 'boolean' ? { excludeTmpdirEnvVar: t.exclude_tmpdir_env_var } : {}),
      ...(typeof t.exclude_slash_tmp === 'boolean' ? { excludeSlashTmp: t.exclude_slash_tmp } : {}),
    }
  }

  /** Apply one set_config_option; throws for an id or value the session does not offer. */
  set(configId: string, value: string): void {
    if (configId === 'mode') {
      const mode = findAgentMode(value)
      if (!mode) throw new Error(`Unknown mode: ${value}`)
      this.mode = mode
      return
    }
    if (configId === 'collaboration_mode') {
      if (value !== 'default' && value !== 'plan') throw new Error(`Unknown collaboration mode: ${value}`)
      this.collaboration = value
      this.collaborationSet = true
      return
    }
    if (configId === 'model') {
      // The model menu's ids carry the effort (`gpt-x[high]`); the model select carries the base id.
      const m = /^(?<model>[^[]+?)(?:\[(?<effort>[^\]]+)\])?$/.exec(value)
      const model = m?.groups?.model
      if (!model) throw new Error(`Unsupported model id: ${value}`)
      // Only a model Codex lists (an endpoint with prefixed ids lists none of the plain ones).
      if (this.rows.length > 0 && model !== this.model && !this.rows.some((r) => r.id === model)) throw new Error(`Codex does not list model ${model}`)
      this.model = model
      const effort = m.groups?.effort
        ?? (this.rows.find((r) => r.id === model)?.supportedReasoningEfforts.some((e) => e.reasoningEffort === this.effort) ? undefined
          : this.rows.find((r) => r.id === model)?.defaultReasoningEffort)
      if (effort) this.effort = effort
      this.picked = true
      return
    }
    if (configId === 'reasoning_effort') {
      const efforts = this.rows.find((r) => r.id === this.model)?.supportedReasoningEfforts
      if (efforts && !efforts.some((e) => e.reasoningEffort === value)) throw new Error(`${this.model} has no reasoning effort ${value}`)
      this.effort = value
      this.picked = true
      return
    }
    throw new Error(`Unknown config option: ${configId}`)
  }

  currentModelId(): string | undefined {
    return this.model ? `${this.model}[${this.effort ?? 'medium'}]` : undefined
  }

  /** The `models` / `modes` / `configOptions` an ACP session response carries. */
  sessionState(): Record<string, unknown> {
    const configOptions: unknown[] = [{
      id: 'mode', name: 'Mode', description: 'Approval and sandboxing preset for the session', category: 'mode', type: 'select',
      currentValue: this.mode.id,
      options: CODEX_AGENT_MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })),
    }, {
      id: 'collaboration_mode', name: 'Collaboration mode', description: 'How Codex collaborates for subsequent turns',
      category: 'collaboration_mode', type: 'select', currentValue: this.collaboration,
      options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan', description: 'Plan before making changes' }],
    }]
    if (this.model) {
      const options = this.rows.map((r) => ({ value: r.id, name: r.displayName, description: r.description }))
      if (!this.rows.some((r) => r.id === this.model)) options.unshift({ value: this.model, name: this.model, description: null as unknown as string })
      configOptions.push({
        id: 'model', name: 'Model', description: 'Model Codex uses for the session', category: 'model', type: 'select',
        currentValue: this.model, options,
      })
      const efforts = this.rows.find((r) => r.id === this.model)?.supportedReasoningEfforts ?? []
      if (efforts.length > 0 && this.effort) {
        configOptions.push({
          id: 'reasoning_effort', name: 'Reasoning effort', description: 'How much reasoning effort the model should use',
          category: 'thought_level', type: 'select', currentValue: this.effort,
          options: efforts.map((e) => ({ value: e.reasoningEffort, name: e.reasoningEffort.charAt(0).toUpperCase() + e.reasoningEffort.slice(1), description: e.description })),
        })
      }
    }
    const current = this.currentModelId()
    return {
      models: { availableModels: mapCodexModels(this.rows), ...(current ? { currentModelId: current } : {}) },
      modes: { availableModes: CODEX_AGENT_MODES.map((m) => ({ id: m.id, name: m.name, description: m.description })), currentModeId: this.mode.id },
      configOptions,
    }
  }
}

