/**
 * Pure-logic pins behind settings-polish.spec.ts (N ids are review items).
 * Each block names the finding it would have caught.
 */
import { describe, expect, it } from 'vitest'
import { resolveMainProvider } from '../../web/src/components/settings/sections/main-provider.js'
import { defaultRunnerName, usesHelp } from '../../web/src/components/settings/sections/SmartTaskCreation.js'

describe('N01: a named provider entry resolves through its api', () => {
  const providers = {
    'work-cli': { api: 'claude-cli' },
    'team-bedrock': { api: 'bedrock' },
    'router-x': { api: 'openai-chat', base_url: 'https://openrouter.ai/api/v1' },
    'odd-one': { api: 'some-future-protocol' },
  }
  it('a claude-cli entry is Claude Code, not an unknown API', () => {
    const info = resolveMainProvider('work-cli', providers)
    expect(info.kind).toBe('cli')
    expect(info.label).toBe('Claude Code')
    expect(defaultRunnerName('work-cli', providers)).toBe('Claude Code')
    expect(usesHelp('default' as never, 'work-cli', providers)).toBe('Slow: each guess starts Claude Code once.')
  })
  it('a named entry of a known API shows that API label', () => {
    expect(resolveMainProvider('team-bedrock', providers)).toMatchObject({ kind: 'api', label: 'AWS Bedrock', custom: true })
    expect(resolveMainProvider('router-x', providers).label).toBe('OpenRouter')
    expect(usesHelp('default' as never, 'team-bedrock', providers)).toBe('Slow: each guess calls AWS Bedrock once.')
  })
  it('built-in ids and missing names keep their meaning', () => {
    expect(resolveMainProvider(undefined).kind).toBe('cli')
    expect(resolveMainProvider('claude_cli').kind).toBe('cli')
    expect(resolveMainProvider('bedrock')).toMatchObject({ kind: 'api', custom: false, label: 'AWS Bedrock' })
  })
  it('only an unknown protocol reads as your API', () => {
    expect(resolveMainProvider('odd-one', providers).kind).toBe('unknown')
    expect(resolveMainProvider('nothing-here', providers).kind).toBe('unknown')
    expect(defaultRunnerName('odd-one', providers)).toBe('Your API')
  })
})

import { codeRuns, HOOK_COPY } from '../../web/src/components/settings/sections/hook-copy.js'
import { permissionHelp } from '../../web/src/components/settings/sections/PermissionsSection.js'
import { tokensUnknown, usageName } from '../../web/src/components/settings/sections/UsageTables.js'
import { providerFallbackState } from '../../web/src/components/settings/sections/plugin-row-view.js'

describe('C8 N22: ids in hook text are set in code, names are human', () => {
  const codes = (t: string) => codeRuns(t).filter((r) => r.code).map((r) => r.text)
  it('wraps env names, file paths, flags, dotted ids and tool names', () => {
    expect(codes('Module: core/session-auto-continue.ts (epoch/TOCTOU semantics). Env defaults (WALNUT_AUTO_CONTINUE_*) still apply.'))
      .toEqual(['core/session-auto-continue.ts', 'TOCTOU', 'WALNUT_AUTO_CONTINUE_*'])
    expect(codes('Phase in NEED_ACTION')).toEqual(['NEED_ACTION'])
    expect(codes('In -p (non-interactive) mode AskUserQuestion never reaches the user.')).toEqual(['-p', 'AskUserQuestion'])
    expect(codes('Auto-updates task.cwd when a session renames it.')).toEqual(['task.cwd'])
    expect(codes('Saved to ~/.claude/settings.json.')).toEqual(['~/.claude/settings.json'])
    expect(codes('With auto_approve_bypass on.')).toEqual(['auto_approve_bypass'])
  })
  it('leaves plain prose alone', () => {
    expect(codes('Logs session errors for monitoring, turn-complete or not.')).toEqual([])
  })
  it('every shipped hook has a human name without ids', () => {
    for (const [id, c] of Object.entries(HOOK_COPY)) {
      expect(codes(c.name), id).toEqual([])
      expect(c.help.endsWith('.'), id).toBe(true)
      expect(/[–—]/.test(c.name + c.help), id).toBe(false)
    }
  })
})

describe('N21 C7: permission help is a real sentence', () => {
  it('a bare "Optional." takes the next sentence along', () => {
    expect(permissionHelp('Optional. Stops the repeated popups while Claude Code reads files. More text.'))
      .toBe('Optional. Stops the repeated popups while Claude Code reads files.')
    expect(permissionHelp('Lets Walnut read Apple Screen Time. Second.')).toBe('Lets Walnut read Apple Screen Time.')
  })
})

describe('N09: usage names and unknown tokens', () => {
  it('capitalizes a bare lowercase id', () => {
    expect(usageName('jev')).toBe('Jev')
  })
  it('a cost with no token counts is unknown, a real zero-cost row is not', () => {
    expect(tokensUnknown({ cost_usd: 45.47, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })).toBe(true)
    expect(tokensUnknown({ cost_usd: 0, input_tokens: 0, output_tokens: 0 })).toBe(false)
    expect(tokensUnknown({ cost_usd: 1, input_tokens: 5, output_tokens: 0 })).toBe(false)
  })
})

describe('N06: a provider without a connection report still says its state', () => {
  it('names the state for every status', () => {
    expect(providerFallbackState({ status: 'needs-config' }).tag?.text).toBe('Not set up')
    // F16: no invented credential line; an active provider without a report is just "on".
    // N3-19: plain "On.", not a sentence about a report that does not exist.
    expect(providerFallbackState({ status: 'active' }).help).toBe('On.')
    expect(providerFallbackState({ status: 'active' }).help).not.toMatch(/sign-in\.$|system/)
    expect(providerFallbackState({ status: 'failed' }).tag?.text).toBe('Failed')
  })
})

import { filterEntries, type FilterEntry } from '../../web/src/components/settings/settings-filter.js'

describe('N17: Find a setting hints read like labels and keep the matched word', () => {
  const entries: FilterEntry[] = [
    { key: 'bug-report', kind: 'pane', label: 'Bug Report' },
    { key: 'advanced', kind: 'pane', label: 'Advanced', keywords: [{ word: 'port', rowLabel: 'Port', anchor: 'sdk-port' }, 'timeout'] },
    { key: 'integrations', kind: 'pane', label: 'Integrations', keywords: [{ word: 'bot', rowLabel: 'Slack bot for the agent to post as' }] },
  ]
  it('a whole-word keyword beats a mid-word label hit', () => {
    expect(filterEntries(entries, 'port')[0].key).toBe('advanced')
  })
  it('a bare keyword hint is capitalized', () => {
    expect(filterEntries(entries, 'timeout')[0].hint).toBe('Timeout')
  })
  it('truncation keeps the matched word', () => {
    const hint = filterEntries(entries, 'agent').find((h) => h.key === 'integrations')?.hint ?? ''
    expect(hint).toContain('agent')
  })
})

import { chunkRows, engineName, sentenceCase } from '../../web/src/components/settings/sections/EnginesSection.js'
import { isSmallEnum, optionLabel } from '../../web/src/components/settings/sections/EngineSettingRows.js'

describe('N12 N30: Engines copy and grouping', () => {
  it('chunks are balanced: no single leftover row under a continued heading', () => {
    expect(chunkRows(Array.from({ length: 11 }, (_, i) => i)).map((c) => c.length)).toEqual([6, 5])
    expect(chunkRows(Array.from({ length: 10 }, (_, i) => i)).map((c) => c.length)).toEqual([10])
  })
  it('labels and options read in sentence case, ids stay as sent', () => {
    expect(sentenceCase('user settings')).toBe('User settings')
    expect(optionLabel('auto')).toBe('Auto')
    expect(optionLabel('follows the permission mode')).toBe('Follows the permission mode')
    expect(optionLabel('in-process')).toBe('in-process')
    expect(optionLabel('24-hour UTC')).toBe('24-hour UTC')
  })
  it('only a closed enum of up to three short words becomes segmented', () => {
    const opt = (label: string) => ({ value: label, label })
    expect(isSmallEnum({ type: 'select', options: [opt('Fresh'), opt('HEAD')] })).toBe(true)
    expect(isSmallEnum({ type: 'select', options: [opt('Accept'), opt('Hold for review'), opt('Refuse')] })).toBe(false)
    expect(isSmallEnum({ type: 'select', allowCustom: true, options: [opt('a'), opt('b')] })).toBe(false)
  })
  it('the engine is Claude Code, never bare Claude', () => {
    expect(engineName('Claude')).toBe('Claude Code')
    expect(engineName('Claude (not installed)')).toBe('Claude Code (not installed)')
    expect(engineName('Claude Code')).toBe('Claude Code')
    expect(engineName('Codex')).toBe('Codex')
  })
})
