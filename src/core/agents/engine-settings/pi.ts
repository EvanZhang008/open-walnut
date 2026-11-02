/**
 * pi's own settings, as data: keys of `~/.pi/agent/settings.json` (pi 1.4, docs/settings.md)
 * that matter to the sessions Walnut runs. pi reads the file when a session starts.
 * Project files (`.pi/settings.json`) load only after the user trusts the project, so
 * Walnut edits the user file alone.
 *
 * "Import from Claude Code" (claude-code-import.ts) writes the first three keys.
 */

import type { EngineSettingsSchema, EngineSettingItem, EngineSettingOption } from '../engine-settings-schema.js'

const USER = 'user'

const opt = (value: string, label = value, help?: string): EngineSettingOption => (help ? { value, label, help } : { value, label })

const SESSION_ITEMS: readonly EngineSettingItem[] = [
  {
    key: 'defaultProvider', label: 'Provider', type: 'text', default: null, placeholder: 'pi decides',
    suggestions: ['amazon-bedrock', 'anthropic', 'openai', 'google', 'openrouter'],
    file: USER, path: 'defaultProvider', scope: 'sessions',
    help: 'Which model provider a new pi session starts on. A session can still pick another model.',
  },
  {
    key: 'defaultModel', label: 'Model', type: 'text', default: null, placeholder: 'pi decides',
    suggestions: ['global.anthropic.claude-opus-5-5', 'global.anthropic.claude-sonnet-5-5', 'claude-opus-5-5'],
    file: USER, path: 'defaultModel', scope: 'sessions',
    help: 'The model id a new session starts with, as the provider names it (for Bedrock, the inference profile id).',
  },
  {
    key: 'defaultThinkingLevel', label: 'Thinking level', type: 'select', default: 'medium',
    options: [opt('off'), opt('minimal'), opt('low'), opt('medium'), opt('high'), opt('xhigh'), opt('max')],
    file: USER, path: 'defaultThinkingLevel', scope: 'sessions',
    help: 'How much the model reasons before answering when a session does not choose.',
  },
  {
    key: 'quietStartup', label: 'Quiet startup', type: 'boolean', default: false,
    file: USER, path: 'quietStartup', scope: 'sessions',
    help: 'Hide pi\'s startup banner. Without it, the banner shows as the first message of every Walnut session.',
  },
  {
    key: 'defaultProjectTrust', label: 'Project trust', type: 'select', default: 'ask',
    options: [
      opt('ask', 'Ask', 'Ask before loading a project\'s own pi settings, extensions and MCP servers'),
      opt('always', 'Always', 'Load them without asking'),
      opt('never', 'Never', 'Ignore them'),
    ],
    file: USER, path: 'defaultProjectTrust', scope: 'sessions',
    help: 'What pi does when a folder carries its own .pi settings. In Walnut, "Ask" shows as a question on the session.',
  },
  {
    key: 'compaction.enabled', label: 'Automatic compaction', type: 'boolean', default: true,
    file: USER, path: 'compaction.enabled', scope: 'sessions',
    help: 'Summarize older turns when the context fills up, so a long session keeps going.',
  },
  {
    key: 'retry.enabled', label: 'Retry failed requests', type: 'boolean', default: true,
    file: USER, path: 'retry.enabled', scope: 'sessions',
    help: 'Retry a model request that failed for a passing reason (throttling, a dropped connection).',
  },
  {
    key: 'enableSkillCommands', label: 'Skill commands', type: 'boolean', default: true,
    file: USER, path: 'enableSkillCommands', scope: 'sessions',
    help: 'Offer every skill as a /skill:name command.',
  },
]

export const PI_SETTINGS: EngineSettingsSchema = {
  files: [
    { id: USER, path: '~/.pi/agent/settings.json', format: 'json', label: 'settings.json', homeEnv: { name: 'PI_CODING_AGENT_DIR', replaces: '~/.pi/agent' } },
  ],
  note: 'Keys of ~/.pi/agent/settings.json on the selected host; every other key in the file is left as it is. A change is picked up by the next pi session.',
  appliesOn: 'new-session',
  groups: [
    { id: 'sessions', title: 'Sessions', help: 'Read by pi when a session starts, including the sessions Walnut runs.', items: SESSION_ITEMS },
  ],
}
