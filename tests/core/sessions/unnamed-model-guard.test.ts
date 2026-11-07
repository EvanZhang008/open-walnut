/**
 * A Claude Code session whose starter named no model runs a Claude model
 * (src/core/sessions/unnamed-model-guard.ts). 2026-11-07: the Mac's CLI default was
 * gpt-6.1-sol, so every task session started there without a model ran Sol.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  isClaudeModelId, claudeFallback, decideUnnamedModel, guardUnnamedModel, resolvedModel, cliDefaultOf,
  insertModelArg, modelOfSettingsText, modelPartOfSettingsText, _resetUnnamedModelGuardCache, type UnnamedModelDeps,
} from '../../../src/core/sessions/unnamed-model-guard.js'

function deps(value: string | null, mainModel?: string, from?: string, pins?: Record<string, string>): UnnamedModelDeps {
  return {
    async readDefault() { return { value, ...(from ? { from } : {}), ...(pins ? { pins } : {}) } },
    async mainModel() { return mainModel },
  }
}

beforeEach(() => _resetUnnamedModelGuardCache())

describe('isClaudeModelId', () => {
  it('reads every form the CLI resolves to Claude as Claude', () => {
    for (const id of [
      '', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable', 'fable[1m]', 'default', 'best', 'opusplan',
      'claude-opus-5-5', 'claude-sonnet-4-5-20250929[1m]', 'global.anthropic.claude-opus-5-5[1m]',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'OPUS',
    ]) expect(isClaudeModelId(id), id).toBe(true)
    expect(isClaudeModelId(undefined)).toBe(true)
    expect(isClaudeModelId(null)).toBe(true)
  })

  it('reads a proxy-routed or other vendor model as not Claude', () => {
    for (const id of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'converse/global.openai.gpt-6.1-sol', 'qwen3-coder', 'opus-like-but-not'])
      expect(isClaudeModelId(id), id).toBe(false)
  })
})

describe('claudeFallback', () => {
  it('takes the family of Walnut\'s main model, else opus', () => {
    expect(claudeFallback('global.anthropic.claude-opus-5-5')).toBe('opus')
    expect(claudeFallback('global.anthropic.claude-sonnet-5-5[1m]')).toBe('sonnet')
    expect(claudeFallback('claude-haiku-5-5')).toBe('haiku')
    expect(claudeFallback('global.anthropic.claude-fable-5-1')).toBe('fable')
    expect(claudeFallback(undefined)).toBe('opus')
    expect(claudeFallback('')).toBe('opus')
    // A main model outside Claude never becomes the fallback.
    expect(claudeFallback('gpt-6.1-sol')).toBe('opus')
  })

  it('skips a family whose pin sends its alias outside Claude, and ends on a full Claude id', () => {
    expect(claudeFallback('global.anthropic.claude-opus-5-5', { opus: 'gpt-6.1-sol' })).toBe('sonnet')
    expect(claudeFallback('global.anthropic.claude-opus-5-5', { opus: 'global.anthropic.claude-opus-5-5[1m]' })).toBe('opus')
    const allAway = { opus: 'gpt-6.1-sol', sonnet: 'gpt-6-astra', haiku: 'gpt-6-luna', fable: 'gpt-6-luna' }
    expect(claudeFallback('global.anthropic.claude-opus-5-5', allAway)).toBe('global.anthropic.claude-opus-5-5')
    expect(claudeFallback(undefined, allAway)).toMatch(/claude/)
  })
})

describe('resolvedModel', () => {
  it('sends an alias (and the built-in default) through its family pin, a model id as itself', () => {
    expect(resolvedModel('opus', { opus: 'gpt-6.1-sol' })).toBe('gpt-6.1-sol')
    expect(resolvedModel('opus[1m]', { opus: 'gpt-6.1-sol' })).toBe('gpt-6.1-sol')
    expect(resolvedModel(null, { opus: 'gpt-6.1-sol' })).toBe('gpt-6.1-sol')
    expect(resolvedModel('sonnet', { opus: 'gpt-6.1-sol' })).toBe('sonnet')
    expect(resolvedModel('global.anthropic.claude-opus-5-5', { opus: 'gpt-6.1-sol' })).toBe('global.anthropic.claude-opus-5-5')
    expect(resolvedModel(null, undefined)).toBe('')
  })
})

describe('cliDefaultOf', () => {
  const part = (t: object) => modelPartOfSettingsText(JSON.stringify(t))
  const paths = ['/p/.claude/settings.local.json', '/p/.claude/settings.json', '~/.claude/settings.json']
  it('ANTHROPIC_MODEL in a settings file env outranks every model key (the CLI lays env over process.env)', () => {
    const r = cliDefaultOf({}, [part({}), part({}), part({ model: 'opus', env: { ANTHROPIC_MODEL: 'gpt-6.1-sol' } })], paths)
    expect(r).toMatchObject({ value: 'gpt-6.1-sol', from: 'ANTHROPIC_MODEL' })
    expect(decideUnnamedModel(r, 'global.anthropic.claude-opus-5-5')).toBe('opus')
  })
  it('a settings env wins over the process env, a higher file over a lower one', () => {
    expect(cliDefaultOf({ ANTHROPIC_MODEL: 'opus' }, [part({}), part({}), part({ env: { ANTHROPIC_MODEL: 'gpt-6.1-sol' } })], paths).value).toBe('gpt-6.1-sol')
    expect(cliDefaultOf({}, [part({ model: 'sonnet' }), part({}), part({ model: 'gpt-6.1-sol' })], paths)).toMatchObject({ value: 'sonnet', from: paths[0] })
    expect(cliDefaultOf({}, [part({}), part({}), part({})], paths).value).toBeNull()
  })
  it('collects the alias pins, so a pinned opus is judged by where it lands', () => {
    const r = cliDefaultOf({}, [part({}), part({}), part({ model: 'opus', env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-6.1-sol' } })], paths)
    expect(r.pins).toEqual({ opus: 'gpt-6.1-sol' })
    expect(decideUnnamedModel(r, 'global.anthropic.claude-opus-5-5')).toBe('sonnet')
  })
})

describe('decideUnnamedModel', () => {
  it('keeps a Claude default and an unset one, replaces any other', () => {
    expect(decideUnnamedModel({ value: null }, 'x')).toBeUndefined()
    expect(decideUnnamedModel({ value: 'global.anthropic.claude-opus-5-5[1m]' }, undefined)).toBeUndefined()
    expect(decideUnnamedModel({ value: 'sonnet' }, undefined)).toBeUndefined()
    expect(decideUnnamedModel({ value: 'gpt-6.1-sol' }, 'global.anthropic.claude-opus-5-5')).toBe('opus')
    expect(decideUnnamedModel({ value: 'gpt-6.1-sol' }, 'global.anthropic.claude-sonnet-5-5')).toBe('sonnet')
  })
})

describe('modelOfSettingsText', () => {
  it('reads model, and nothing from a file the CLI could not use', () => {
    expect(modelOfSettingsText('{"model":"gpt-6.1-sol","env":{}}')).toBe('gpt-6.1-sol')
    expect(modelOfSettingsText('{"model":"  "}')).toBeNull()
    expect(modelOfSettingsText('{"model":3}')).toBeNull()
    expect(modelOfSettingsText('{}')).toBeNull()
    expect(modelOfSettingsText('{not json')).toBeNull()
    expect(modelOfSettingsText(null)).toBeNull()
  })
})

describe('guardUnnamedModel', () => {
  it('adds the fallback for a non-Claude default and says where it came from', async () => {
    const d = deps('gpt-6.1-sol', 'global.anthropic.claude-opus-5-5', '~/.claude/settings.json')
    expect(await guardUnnamedModel('__local__', '/w', d)).toEqual({ cliDefault: 'gpt-6.1-sol', from: '~/.claude/settings.json', use: 'opus' })
  })

  it('replaces a Claude-looking alias whose pin lands outside Claude', async () => {
    const out = await guardUnnamedModel('__local__', '/w', deps('opus', 'global.anthropic.claude-opus-5-5', undefined, { opus: 'gpt-6.1-sol' }))
    expect(out).toMatchObject({ cliDefault: 'opus', resolved: 'gpt-6.1-sol', use: 'sonnet' })
  })

  it('leaves a Claude default alone', async () => {
    expect((await guardUnnamedModel(undefined, undefined, deps('global.anthropic.claude-opus-5-5[1m]'))).use).toBeUndefined()
    expect((await guardUnnamedModel(undefined, undefined, deps(null))).use).toBeUndefined()
  })

  it('a read that fails or hangs never blocks the start: no change, the error kept', async () => {
    const failing: UnnamedModelDeps = { readDefault: () => Promise.reject(new Error('daemon away')), mainModel: async () => undefined }
    expect(await guardUnnamedModel('clouddev', '/w', failing)).toEqual({ cliDefault: undefined, error: 'daemon away' })
    const hanging: UnnamedModelDeps = { readDefault: () => new Promise(() => {}), mainModel: async () => undefined }
    const t0 = Date.now()
    const out = await guardUnnamedModel('clouddev', '/w', hanging, 50)
    expect(out.use).toBeUndefined()
    expect(out.error).toMatch(/no answer within 50 ms/)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('insertModelArg', () => {
  it('puts --model after the permission mode, once', () => {
    const args = ['-p', '--permission-mode', 'bypassPermissions', '--resume', 'sid']
    insertModelArg(args, 'opus')
    expect(args).toEqual(['-p', '--permission-mode', 'bypassPermissions', '--model', 'opus', '--resume', 'sid'])
    insertModelArg(args, 'sonnet')
    expect(args.filter((a) => a === '--model')).toHaveLength(1)
    expect(insertModelArg(['-p'], 'opus')).toEqual(['-p', '--model', 'opus'])
  })
})
