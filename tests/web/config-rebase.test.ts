/**
 * rebaseOnto (web/src/hooks/config-rebase.ts): a Settings save keeps only what
 * the section changed relative to the config it rendered with, laid over the
 * server's current config. The 2026-09-22 incident it pins: an open Settings
 * window saved an unrelated agent field and wrote `main_provider: bedrock`
 * back over a newer `claude_cli`.
 */
import { describe, expect, it } from 'vitest'
import type { Config } from '../../src/core/types'
import { OwnWrites, rebaseOnto } from '../../web/src/hooks/config-rebase'

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

describe('OwnWrites: a save measured against what the user saw after this page\'s own writes', () => {
  // The 2026-11-11 Backup switch: on (painted), off (saved, refresh not back yet), on again.
  const painted = cfg({ backup: { enabled: true, interval_hours: 24 } })
  const off = { backup: { enabled: false, interval_hours: 24 } } as Partial<Config>
  const on = { backup: { enabled: true, interval_hours: 24 } } as Partial<Config>
  const server = cfg({ backup: { enabled: false, interval_hours: 24 } })

  it('measured against the painted config alone, turning it back on is lost (the bug this guards)', () => {
    expect(rebaseOnto(on, painted, server)).toEqual({ backup: { enabled: false, interval_hours: 24 } })
  })

  it('a second save before the first one\'s refresh keeps what the user picked last', () => {
    const own = new OwnWrites()
    const baseMark = own.mark()
    own.wrote(off, painted)
    expect(rebaseOnto(on, own.seen(painted, baseMark), server)).toEqual({ backup: { enabled: true, interval_hours: 24 } })
  })

  it('replays only what a write changed: another writer\'s field it carried along is not made an edit', () => {
    // An agent set interval_hours to 12 after the page painted 24; the first save carried 12 from the server.
    const agentServer = cfg({ backup: { enabled: true, interval_hours: 12 } })
    const own = new OwnWrites()
    const baseMark = own.mark()
    const sentA = rebaseOnto(off, painted, agentServer)
    expect(sentA).toEqual({ backup: { enabled: false, interval_hours: 12 } })
    own.wrote(off, painted)
    // The second save still holds the painted 24: only the switch is the user's edit.
    const afterA = cfg({ backup: { enabled: false, interval_hours: 12 } })
    expect(rebaseOnto(on, own.seen(painted, baseMark), afterA)).toEqual({ backup: { enabled: true, interval_hours: 12 } })
  })

  it('a config painted after a write is not given that write again', () => {
    const own = new OwnWrites()
    own.wrote(off, painted)
    const repainted = cfg({ backup: { enabled: false, interval_hours: 24 } })
    expect(own.seen(repainted, own.mark())).toBe(repainted)
  })

  it('a key a write left undefined is not laid over the base', () => {
    const own = new OwnWrites()
    const base = cfg({ backup: { enabled: true }, agent: { language: 'en' } })
    const mark = own.mark()
    own.wrote({ agent: undefined } as unknown as Partial<Config>, base)
    expect(own.seen(base, mark)).toEqual({ backup: { enabled: true }, agent: { language: 'en' } })
  })

  it('keeps a bounded list of writes', () => {
    const own = new OwnWrites()
    const base = cfg({ backup: { enabled: true, interval_hours: 0 } })
    for (let i = 0; i < 200; i++) own.wrote({ backup: { enabled: true, interval_hours: i } } as Partial<Config>, base)
    const seen = own.seen(base, own.mark() - 1) as unknown as { backup: { interval_hours: number } }
    expect(seen.backup.interval_hours).toBe(199)
    expect((own as unknown as { writes: unknown[] }).writes.length).toBeLessThanOrEqual(50)
  })
})
