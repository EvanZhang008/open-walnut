/**
 * rebaseOnto (web/src/hooks/config-rebase.ts): a Settings save keeps only what
 * the section changed relative to the config it rendered with, laid over the
 * server's current config. The 2026-09-22 incident it pins: an open Settings
 * window saved an unrelated agent field and wrote `main_provider: bedrock`
 * back over a newer `claude_cli`.
 */
import { describe, expect, it } from 'vitest'
import type { Config } from '../../src/core/types'
import { rebaseOnto } from '../../web/src/hooks/config-rebase'

const cfg = (c: Record<string, unknown>) => c as unknown as Config

describe('rebaseOnto', () => {
  it('keeps a sibling another writer changed after the page loaded', () => {
    const base = cfg({ agent: { main_provider: 'bedrock', language: 'en' } })
    const fresh = cfg({ agent: { main_provider: 'claude_cli', language: 'en' } })
    const partial = { agent: { main_provider: 'bedrock', language: 'zh' } } as Partial<Config>
    expect(rebaseOnto(partial, base, fresh)).toEqual({ agent: { main_provider: 'claude_cli', language: 'zh' } })
  })

  it('applies a field the section really changed even if another writer touched it too', () => {
    const base = cfg({ agent: { main_provider: 'bedrock' } })
    const fresh = cfg({ agent: { main_provider: 'openai' } })
    const partial = { agent: { main_provider: 'claude_cli' } } as Partial<Config>
    expect(rebaseOnto(partial, base, fresh)).toEqual({ agent: { main_provider: 'claude_cli' } })
  })

  it('keeps fields the section never saw (added elsewhere after load)', () => {
    const base = cfg({ agent: { language: 'en' } })
    const fresh = cfg({ agent: { language: 'en', session_organize: false } })
    const partial = { agent: { language: 'fr' } } as Partial<Config>
    expect(rebaseOnto(partial, base, fresh)).toEqual({ agent: { language: 'fr', session_organize: false } })
  })

  it('treats an undefined field the section had as a deletion, and ignores one it never had', () => {
    const base = cfg({ agent: { main_model: 'x', language: 'en' } })
    const fresh = cfg({ agent: { main_model: 'x', language: 'en', quick_parse: true } })
    const partial = { agent: { main_model: undefined, language: 'en', quick_parse: undefined } } as unknown as Partial<Config>
    // quick_parse was not in base: `undefined` there is "I don't know it", not "delete it".
    expect(rebaseOnto(partial, base, fresh)).toEqual({ agent: { language: 'en', quick_parse: true } })
  })

  it('compares nested values by content, not identity', () => {
    const base = cfg({ jev: { endpoint: 'a', decisions: { quick_parse: true } } })
    const fresh = cfg({ jev: { endpoint: 'b', decisions: { quick_parse: true } } })
    const partial = { jev: { endpoint: 'a', decisions: { quick_parse: false } } } as unknown as Partial<Config>
    expect(rebaseOnto(partial, base, fresh)).toEqual({ jev: { endpoint: 'b', decisions: { quick_parse: false } } })
  })

  it('passes null, scalars, arrays, and sections new on either side through as written', () => {
    const base = cfg({ jev: { endpoint: 'a' }, agent: { language: 'en' } })
    const fresh = cfg({ jev: { endpoint: 'a' } })
    const partial = {
      jev: null,
      agent: { language: 'de' },
      favorites: { projects: ['p'] },
    } as unknown as Partial<Config>
    expect(rebaseOnto(partial, base, fresh)).toEqual(partial)
  })

  it('merges two writes to one nested object field by field (token vs added model)', () => {
    const base = cfg({ providers: { bedrock: { api: 'bedrock', bearer_token: 'old', models: ['a'] } } })
    // The token save landed first; the add-model save was built from the same render.
    const fresh = cfg({ providers: { bedrock: { api: 'bedrock', bearer_token: 'new', models: ['a'] } } })
    const partial = { providers: { bedrock: { api: 'bedrock', bearer_token: 'old', models: ['a', 'b'] } } } as unknown as Partial<Config>
    expect(rebaseOnto(partial, base, fresh)).toEqual({ providers: { bedrock: { api: 'bedrock', bearer_token: 'new', models: ['a', 'b'] } } })
  })

  it('a nested field the section dropped is deleted; one it re-sent unchanged keeps the fresh value', () => {
    const base = cfg({ plugins: { calendar: { hidden_calendar_ids: ['x'], account: 'a', token: 't' } } })
    const fresh = cfg({ plugins: { calendar: { hidden_calendar_ids: ['x', 'y'], account: 'a', token: 't' } } })
    const partial = { plugins: { calendar: { hidden_calendar_ids: ['x'], account: 'b' } } } as unknown as Partial<Config>
    expect(rebaseOnto(partial, base, fresh)).toEqual({ plugins: { calendar: { hidden_calendar_ids: ['x', 'y'], account: 'b' } } })
  })

  it('leaves keys the partial does not name alone', () => {
    const base = cfg({ agent: { language: 'en' }, defaults: { engine: 'claude' } })
    const fresh = cfg({ agent: { language: 'en' }, defaults: { engine: 'codex' } })
    const out = rebaseOnto({ agent: { language: 'ja' } } as Partial<Config>, base, fresh)
    expect(out).toEqual({ agent: { language: 'ja' } })
  })
})
