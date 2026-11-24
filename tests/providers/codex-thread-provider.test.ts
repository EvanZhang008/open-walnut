/**
 * A resumed Codex thread resumes under the provider id it recorded (codex-thread-provider.ts):
 * a fake CODEX_HOME holds rollouts whose session_meta names an old provider id.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findCodexRollout, planCodexResume, readRolloutProvider, userDefinedCodexProviders,
} from '../../src/providers/codex-thread-provider.js'

// A UUIDv7 minted at 2026-11-24T13:31:16.410Z (its first 48 bits are that time in ms).
const THREAD = '01a20dc0-e997-7051-8000-000000000000'
const CURRENT = { name: 'box-a-proxy', base_url: 'http://127.0.0.1:8402/openai/v1', wire_api: 'responses', requires_openai_auth: false }
const CONFIG = JSON.stringify({ model_provider: 'box-a-proxy', model_providers: { 'box-a-proxy': CURRENT }, model: 'gpt-x' })

let home: string

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-provider-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

function writeRollout(threadId: string, provider: string | undefined, opts: { day?: string; instructions?: string; archived?: boolean } = {}): string {
  const dir = opts.archived ? path.join(home, 'archived_sessions') : path.join(home, 'sessions', ...(opts.day ?? '2026/11/24').split('/'))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-11-24T13-31-16-${threadId}.jsonl`)
  const meta = { timestamp: '2026-11-24T13:31:19.398Z', type: 'session_meta', payload: { id: threadId, cwd: '/w', ...(provider ? { model_provider: provider } : {}), base_instructions: { text: opts.instructions ?? 'be brief' } } }
  fs.writeFileSync(file, JSON.stringify(meta) + '\n' + JSON.stringify({ type: 'response_item', payload: { model_provider: 'not-this-one' } }) + '\n')
  return file
}

describe('planCodexResume', () => {
  it('aliases the id an old thread recorded to the provider used now, and names it on resume', async () => {
    writeRollout(THREAD, 'old-proxy')
    const plan = await planCodexResume({ codexConfig: CONFIG, codexHome: home, threadIds: [null, THREAD] })
    expect(plan.providers).toEqual({ [THREAD]: 'old-proxy' })
    const next = JSON.parse(plan.codexConfig!)
    expect(next.model_providers['old-proxy']).toEqual({ ...CURRENT, name: 'old-proxy' })
    // Today's provider stays the one new threads start on, and stays defined.
    expect(next.model_provider).toBe('box-a-proxy')
    expect(next.model_providers['box-a-proxy']).toEqual(CURRENT)
    expect(next.model).toBe('gpt-x')
    expect(plan.notes).toEqual([{ thread: THREAD, recorded: 'old-proxy', current: 'box-a-proxy', action: 'alias' }])
  })

  it('the alias is a copy of the provider resolved for this host, so it adds no endpoint (a loopback one stays local)', async () => {
    writeRollout(THREAD, 'old-proxy')
    const tagged = JSON.stringify({ model_provider: 'box-a-proxy', model_providers: {
      'box-a-proxy': { ...CURRENT, http_headers: { 'x-tag': 's1' } },
      // A provider of another machine the server left in the user's CODEX_CONFIG is never what the alias copies.
      'far-proxy': { name: 'far-proxy', base_url: 'https://far.example/v1', wire_api: 'responses' },
    } })
    const next = JSON.parse((await planCodexResume({ codexConfig: tagged, codexHome: home, threadIds: [THREAD] })).codexConfig!)
    expect(next.model_providers['old-proxy']).toEqual({ ...CURRENT, http_headers: { 'x-tag': 's1' }, name: 'old-proxy' })
  })

  it('changes nothing when the thread recorded today\'s id', async () => {
    writeRollout(THREAD, 'box-a-proxy')
    expect(await planCodexResume({ codexConfig: CONFIG, codexHome: home, threadIds: [THREAD] })).toEqual({ providers: {}, notes: [] })
  })

  it('names, without an alias, an old id Walnut\'s CODEX_CONFIG still defines', async () => {
    writeRollout(THREAD, 'old-proxy')
    const both = JSON.stringify({ model_provider: 'box-a-proxy', model_providers: { 'box-a-proxy': CURRENT, 'old-proxy': { name: 'old-proxy', base_url: 'http://127.0.0.1:9000/v1' } } })
    const plan = await planCodexResume({ codexConfig: both, codexHome: home, threadIds: [THREAD] })
    expect(plan.providers).toEqual({ [THREAD]: 'old-proxy' })
    expect(plan.codexConfig).toBeUndefined()
    expect(plan.notes[0].action).toBe('named')
  })

  it('leaves alone an id the user\'s own config.toml defines, and Codex\'s built-in ones', async () => {
    writeRollout(THREAD, 'my-own')
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n[model_providers.my-own]\nname = "mine"\nbase_url = "http://10.0.0.2/v1"\n')
    const plan = await planCodexResume({ codexConfig: CONFIG, codexHome: home, threadIds: [THREAD] })
    expect(plan.providers).toEqual({})
    expect(plan.codexConfig).toBeUndefined()
    expect(plan.notes[0].action).toBe('user-provider')

    const other = '01a20dc0-e997-7051-8000-000000000001'
    writeRollout(other, 'openai')
    expect((await planCodexResume({ codexConfig: CONFIG, codexHome: home, threadIds: [other] })).providers).toEqual({})
  })

  it('changes nothing for a rollout it cannot find, cannot read, or that names no provider', async () => {
    expect(await planCodexResume({ codexConfig: CONFIG, codexHome: home, threadIds: [THREAD] })).toEqual({ providers: {}, notes: [] })
    writeRollout(THREAD, undefined)
    expect((await planCodexResume({ codexConfig: CONFIG, codexHome: home, threadIds: [THREAD] })).providers).toEqual({})
    const file = writeRollout(THREAD, 'old-proxy')
    fs.writeFileSync(file, 'not json\n')
    expect((await planCodexResume({ codexConfig: CONFIG, codexHome: home, threadIds: [THREAD] })).providers).toEqual({})
    // A read that never answers: the deadline gives today's behaviour.
    const hung = await planCodexResume({ codexConfig: CONFIG, codexHome: home, threadIds: [THREAD] }, {
      readRecorded: () => new Promise(() => {}), deadlineMs: 50,
    })
    expect(hung).toEqual({ providers: {}, notes: [] })
    const threw = await planCodexResume({ codexConfig: CONFIG, codexHome: home, threadIds: [THREAD] }, {
      readRecorded: async () => { throw new Error('EACCES') },
    })
    expect(threw).toEqual({ providers: {}, notes: [] })
  })

  it('does nothing when Walnut names no provider (the host\'s own config decides)', async () => {
    writeRollout(THREAD, 'old-proxy')
    for (const codexConfig of [undefined, '', 'nope', JSON.stringify({ model: 'gpt-x' }), JSON.stringify({ model_provider: 'from-toml' })]) {
      expect(await planCodexResume({ codexConfig, codexHome: home, threadIds: [THREAD] })).toEqual({ providers: {}, notes: [] })
    }
  })

  it('maps each thread a start may load to its own recorded id (the restored one and the requested one)', async () => {
    const fresh = '01a20dc0-e997-7051-8000-000000000002'
    writeRollout(THREAD, 'old-proxy')
    writeRollout(fresh, 'box-a-proxy')
    const plan = await planCodexResume({ codexConfig: CONFIG, codexHome: home, threadIds: [THREAD, fresh] })
    expect(plan.providers).toEqual({ [THREAD]: 'old-proxy' })
    expect(JSON.parse(plan.codexConfig!).model_provider).toBe('box-a-proxy')
  })

  it('with the codex-acp adapter, the first thread\'s recorded id becomes the provider (the adapter names one for all)', async () => {
    writeRollout(THREAD, 'old-proxy')
    const plan = await planCodexResume({ codexConfig: CONFIG, codexHome: home, threadIds: [THREAD], adapter: true })
    const next = JSON.parse(plan.codexConfig!)
    expect(next.model_provider).toBe('old-proxy')
    expect(next.model_providers['old-proxy'].base_url).toBe(CURRENT.base_url)
  })
})

describe('finding and reading a rollout', () => {
  it('finds a UUIDv7 thread in its day folder or the one beside it, and in archived_sessions', async () => {
    const file = writeRollout(THREAD, 'old-proxy', { day: '2026/11/23' })
    expect(await findCodexRollout(home, THREAD)).toBe(file)
    const archived = '01a20dc0-e997-7051-8000-000000000003'
    const a = writeRollout(archived, 'old-proxy', { archived: true })
    expect(await findCodexRollout(home, archived)).toBe(a)
    expect(await findCodexRollout(home, '../../etc/passwd')).toBeUndefined()
  })

  it('finds a thread id that carries no time in the newest day folders', async () => {
    const v4 = '5f1c2d3e-4a5b-4c6d-8e7f-0123456789ab'
    const file = writeRollout(v4, 'old-proxy', { day: '2025/03/09' })
    expect(await findCodexRollout(home, v4)).toBe(file)
  })

  it('reads the first line only, and a first line past the cap by its key', async () => {
    const file = writeRollout(THREAD, 'old-proxy', { instructions: 'x'.repeat(1_500_000) })
    expect(await readRolloutProvider(file)).toBe('old-proxy')
    const notMeta = path.join(home, 'other.jsonl')
    fs.writeFileSync(notMeta, JSON.stringify({ type: 'response_item', payload: { model_provider: 'nope' } }) + '\n')
    expect(await readRolloutProvider(notMeta)).toBeUndefined()
    expect(await readRolloutProvider(path.join(home, 'missing.jsonl'))).toBeUndefined()
  })
})

describe('userDefinedCodexProviders', () => {
  it('reads table headers, sub-tables, dotted keys, a [model_providers] table and an inline table', async () => {
    fs.writeFileSync(path.join(home, 'config.toml'), [
      'model_provider = "a"',
      'model_providers.dot.base_url = "http://x"',
      'model_providers = { inl = { base_url = "http://y" }, "inl-2" = { base_url = "http://z" } }',
      '[model_providers.a]',
      'base_url = "http://a"',
      '[model_providers."quoted-b".aws]',
      'profile = "p"',
      '[model_providers]',
      'root-c = { base_url = "http://c" }',
      '[profiles.fast]',
      'model_provider = "not-a-definition"',
    ].join('\n'))
    expect([...await userDefinedCodexProviders(home)].sort()).toEqual(['a', 'dot', 'inl', 'inl-2', 'quoted-b', 'root-c'])
  })

  it('is empty without a config.toml', async () => {
    expect((await userDefinedCodexProviders(home)).size).toBe(0)
  })
})
