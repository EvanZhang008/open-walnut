/**
 * Codex CLI's own settings, as data: the top-level keys of `~/.codex/config.toml`
 * (verified against codex 0.154). Only top-level scalars are declared: the
 * file's tables (`[projects."..."]`, `[model_providers.*]`, `[tui]`) carry
 * per-directory trust and provider wiring that a settings screen has no
 * business rewriting, and the TOML editor edits top-level lines only so it can
 * leave comments and tables byte-for-byte alone.
 *
 * `approval_policy` and `sandbox_mode` are also what Walnut reads to pick a new
 * Codex session's initial approval preset (resolveCodexInitialMode), so a
 * change here is felt on the next session start.
 */

import type { EngineSettingsSchema, EngineSettingItem, EngineSettingOption } from '../engine-settings-schema.js'

const CONFIG = 'config'

const opt = (value: string, label = value, help?: string): EngineSettingOption => (help ? { value, label, help } : { value, label })

const SESSION_ITEMS: readonly EngineSettingItem[] = [
  {
    key: 'model', label: 'Model', type: 'text', default: '', placeholder: 'engine default',
    suggestions: ['gpt-5-codex', 'gpt-5', 'o3'],
    file: CONFIG, path: 'model', scope: 'sessions',
    help: 'Model id sent to the provider when a session does not pick one. Empty lets codex choose.',
  },
  {
    key: 'model_reasoning_effort', label: 'Reasoning effort', type: 'select', default: 'medium',
    options: [opt('minimal'), opt('low'), opt('medium'), opt('high'), opt('xhigh'), opt('max'), opt('ultra')],
    file: CONFIG, path: 'model_reasoning_effort', scope: 'sessions',
    help: 'How much the model reasons before answering. A session\'s own effort pill overrides this for that session.',
  },
  {
    key: 'approval_policy', label: 'Approval policy', type: 'select', default: 'on-request',
    options: [
      opt('untrusted', 'Untrusted', 'Ask before every command that is not known-safe'),
      opt('on-failure', 'On failure', 'Run in the sandbox, ask only when a command fails'),
      opt('on-request', 'On request', 'Let the model decide when to ask'),
      opt('granular', 'Granular', 'Per-tool approval rules'),
      opt('never', 'Never', 'Never ask'),
    ],
    file: CONFIG, path: 'approval_policy', scope: 'sessions',
    help: 'When codex asks before running a command. Walnut reads this with the sandbox mode to pick a new session\'s starting approval preset.',
  },
  {
    key: 'sandbox_mode', label: 'Sandbox mode', type: 'select', default: 'read-only',
    options: [
      opt('read-only', 'Read only', 'Commands may read but not write'),
      opt('workspace-write', 'Workspace write', 'Writes allowed inside the working directory'),
      opt('danger-full-access', 'Full access', 'No sandbox'),
    ],
    file: CONFIG, path: 'sandbox_mode', scope: 'sessions',
    help: 'What commands may touch. Walnut maps read-only, workspace-write and danger-full-access onto its approval presets.',
  },
  {
    key: 'personality', label: 'Personality', type: 'select', default: 'friendly',
    options: [opt('friendly', 'Friendly'), opt('pragmatic', 'Pragmatic')],
    file: CONFIG, path: 'personality', scope: 'sessions',
    help: 'Tone of the model\'s replies.',
  },
  {
    key: 'model_provider', label: 'Model provider', type: 'text', default: '', placeholder: 'openai',
    file: CONFIG, path: 'model_provider', scope: 'sessions',
    help: 'Key of a [model_providers.*] table in config.toml to route requests through. Empty uses the built-in OpenAI provider.',
  },
]

const UPDATE_ITEMS: readonly EngineSettingItem[] = [
  {
    key: 'check_for_update_on_startup', label: 'Check for updates on startup', type: 'boolean', default: true,
    file: CONFIG, path: 'check_for_update_on_startup', scope: 'updates',
    help: 'Look for a newer codex release each time it starts.',
  },
]

export const CODEX_SETTINGS: EngineSettingsSchema = {
  files: [
    { id: CONFIG, path: '~/.codex/config.toml', format: 'toml-top-level', label: 'config.toml', homeEnv: { name: 'CODEX_HOME', replaces: '~/.codex' } },
  ],
  note: 'The top-level keys of ~/.codex/config.toml on the selected host. Tables such as [projects] and [model_providers] are left untouched; a change is picked up by the next codex session.',
  appliesOn: 'new-session',
  groups: [
    { id: 'sessions', title: 'Sessions', help: 'Read by codex on every start, including the sessions Walnut runs.', items: SESSION_ITEMS },
    { id: 'updates', title: 'Updates', help: 'The CLI\'s own update check.', items: UPDATE_ITEMS },
  ],
}
