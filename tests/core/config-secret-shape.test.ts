/**
 * Secrets judged by the shape of their key (src/core/config-secret-shape.ts).
 *
 * A plugin's settings, a provider's extra headers, a host server's build env, a
 * tunnel provider's options and a hook action's arguments are maps no field list
 * describes. GET /api/config, every `config:changed` and the plugin settings
 * forms mask the values whose key names a secret, and PUT /api/config puts each
 * mask read back to its stored value. This file pins:
 *  - the rule, key by key, both ways (what it hides and what it keeps);
 *  - that it hides no key a shipped plugin's settings form shows;
 *  - where each client view applies it (the Mac: the free-form maps only; a
 *    replica and a bug report: everywhere), and that a map keyed by a name
 *    (a plugin id, a host) is never judged by that name;
 *  - the restore, including that a whole round trip of either view writes back
 *    exactly what was stored;
 *  - that every free-form map in the Config type is either masked by shape on
 *    the Mac or listed here with the reason it holds no secret.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  isSecretKey, isMaskedSecret, maskPluginFormValues, maskSecretShapes, NOT_SECRET_KEYS,
  PLUGIN_FORM_MASK, restoreMaskedSecrets,
} from '../../src/core/config-secret-shape.js'
import { maskForMacClients, redactConfig } from '../../src/core/config-redact.js'

const ROOT = path.resolve(__dirname, '../..')
const B = '\u2022'
const tail = (v: string) => B.repeat(8) + v.slice(-4)

describe('the key-shape rule', () => {
  it('hides the keys that name a secret, in any spelling', () => {
    const hidden = [
      'client_secret', 'clientSecret', 'CLIENT_SECRET', 'access_token', 'accessToken', 'refresh_token',
      'refreshToken', 'id_token', 'token', 'bearer_token', 'githubtoken', 'NPM_TOKEN', 'GITHUB_TOKEN',
      'api_key', 'apiKey', 'apikey', 'X-Api-Key', 'x-api-key', 'Ocp-Apim-Subscription-Key',
      'Authorization', 'Cookie', 'password', 'db_password', 'passwd', 'pwd', 'passphrase',
      'private_key', 'privateKey', 'signing_key', 'session_key', 'encryption_key', 'master_key',
      'aws_secret_access_key', 'aws_access_key_id', 'aws_session_token', 'webhook_secret',
      'credentials', 'jwt', 'key', 'hotspot_password', 'secret',
    ]
    expect(hidden.filter((k) => !isSecretKey(k))).toEqual([])
  })

  it('keeps the keys that do not, including every key on the allowlist', () => {
    const kept = [
      'project_key', 'sort_key', 'key_id', 'idempotency_key', 'client_id', 'base_url', 'issue_type',
      'email', 'type', 'auth', 'auth_header', 'aws_profile', 'region', 'max_tokens', 'maxTokens',
      'max_tokens_field', 'token_budget', 'memory_budget_tokens', 'input_tokens', 'estimatedTokens',
      'token_prefix', 'tokenPrefix', 'token_tag', 'token_type', 'token_url', 'token_endpoint',
      'token_expires_at', 'authorization_url', 'authorization_endpoint', 'aws_credential_export',
      'tokenizer', 'push_tokens', 'jql_filter', 'list_mapping', 'enabled', '',
    ]
    expect(kept.filter((k) => isSecretKey(k))).toEqual([])
    // The allowlist is spelled as the rule compares it (no case, no separators), and each
    // entry carries a secret word, so it is there because the rule would hide it otherwise.
    expect(NOT_SECRET_KEYS.size).toBeGreaterThan(5)
    for (const k of NOT_SECRET_KEYS) expect(k).toMatch(/^[a-z0-9]*(token|secret|credential|authorization|password)[a-z0-9]*$/)
  })

  it('hides no key of any shipped plugin\'s settings form, and the form fields it must keep are there', () => {
    const manifests = ['src/integrations', 'examples/plugins', 'plugin-store', 'tests/e2e/browser/fixtures']
      .flatMap((dir) => fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)).map((d) => path.join(dir, d, 'manifest.json')) : [])
      .filter((f) => fs.existsSync(path.join(ROOT, f)))
    expect(manifests.length).toBeGreaterThanOrEqual(10)
    const keys = new Map<string, string>()
    const walk = (schema: unknown, file: string) => {
      const props = (schema as { properties?: Record<string, unknown> } | null)?.properties
      if (!props || typeof props !== 'object') return
      for (const [k, v] of Object.entries(props)) { keys.set(k, file); walk(v, file); walk((v as { items?: unknown }).items, file) }
    }
    for (const f of manifests) walk((JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf-8')) as { configSchema?: unknown }).configSchema, f)
    for (const k of ['base_url', 'project_key', 'project', 'client_id', 'accounts', 'digest_time']) expect(keys.has(k), k).toBe(true)
    expect([...keys.keys()].filter(isSecretKey)).toEqual([])
  })
})

describe('masking by shape', () => {
  it('masks strings under a secret key at any depth, and nothing else', () => {
    const out = maskSecretShapes({
      client_id: 'acme-client', client_secret: 'acme-client-secret-1111', enabled: true, sync_interval_ms: 60_000,
      auth: { type: 'api-token', email: 'owner@example.invalid', token: 'acme-jira-token-2222' },
      oauth: { tokens: { access_token: 'acme-access-3333', refresh_token: 'acme-refresh-4444', token_type: 'Bearer' } },
      empty_secret: '', max_tokens: 4096,
    })
    expect(out).toEqual({
      client_id: 'acme-client', client_secret: tail('1111'), enabled: true, sync_interval_ms: 60_000,
      auth: { type: 'api-token', email: 'owner@example.invalid', token: tail('2222') },
      oauth: { tokens: { access_token: tail('3333'), refresh_token: tail('4444'), token_type: 'Bearer' } },
      empty_secret: '', max_tokens: 4096,
    })
  })

  it('a map under a secret key is all secrets; a record in a list under one is judged by its own keys', () => {
    const out = maskSecretShapes({
      secrets: { github: 'acme-gh-5555', nested: [{ any: 'acme-any-6666' }] },
      api_keys: [{ name: 'legacy', key: 'acme-legacy-7777', created_at: '2026-01-01' }],
      tokens_list: ['plain'],
      credentials: ['acme-cred-8888'],
    })
    expect(out).toEqual({
      secrets: { github: tail('5555'), nested: [{ any: tail('6666') }] },
      api_keys: [{ name: 'legacy', key: tail('7777'), created_at: '2026-01-01' }],
      tokens_list: ['plain'],
      credentials: [tail('8888')],
    })
  })

  it('the plugin settings forms get six bullets, the mask their save leaves out', () => {
    expect(PLUGIN_FORM_MASK).toBe(B.repeat(6))
    expect(maskPluginFormValues({ base_url: 'https://acme.invalid', auth: { token: 'acme-tok-9999' }, token_url: 'https://acme.invalid/t' }))
      .toEqual({ base_url: 'https://acme.invalid', auth: { token: B.repeat(6) }, token_url: 'https://acme.invalid/t' })
  })
})

/** A config with a secret in every free-form map, beside the typed secrets. */
function richConfig() {
  return {
    version: 1,
    user: { name: 'Owner' },
    provider: { bedrock_bearer_token: 'acme-bearer-aaaa' },
    providers: {
      openai: { api: 'openai-chat', api_key: 'acme-openai-bbbb', headers: { Authorization: 'Bearer acme-hdr-cccc', 'anthropic-version': '2023-06-01' } },
      'bearer-proxy': { api: 'anthropic', aws_session_token: 'acme-session-dddd', max_tokens_field: 'max_completion_tokens' },
    },
    plugins: {
      'acme-sync': {
        enabled: true, client_id: 'acme-client', client_secret: 'acme-secret-eeee', access_token: 'acme-access-ffff',
        refresh_token: 'acme-refresh-gggg', base_url: 'https://acme.invalid', project_key: 'ACME',
        oauth: { signing: { private_key: 'acme-pk-hhhh' } },
      },
      'token-sync': { enabled: true, label: 'Token sync', password: 'acme-pw-iiii' },
    },
    hosts: {
      'secret-box': {
        hostname: 'secret-box.invalid', label: 'Secret box', enabled: false,
        server: { enabled: false, build_env: { NPM_TOKEN: 'acme-npm-jjjj', NODE_OPTIONS: '--max-old-space-size=4096' }, expose: { enabled: false, options: { tunnel: 'acme', auth_token: 'acme-tun-kkkk' } } },
      },
    },
    expose: { enabled: false, provider: 'acme', options: { name: 'acme-tunnel', token: 'acme-expose-llll' } },
    hooks: { defs: [{ id: 'acme-hook', on: ['onTurnComplete'], action: { type: 'notify', message: 'done', webhook_secret: 'acme-hook-mmmm' } }] },
    api_keys: [{ name: 'legacy', key: 'acme-apikey-nnnn', created_at: '2026-01-01' }],
    push_tokens: [{ token: 'ab'.repeat(32), platform: 'ios', key_name: 'acme-phone', claims: ['acme-claim'] }],
  }
}

const FREE_FORM_SECRETS = ['eeee', 'ffff', 'gggg', 'hhhh', 'iiii', 'cccc', 'jjjj', 'kkkk', 'llll', 'mmmm']
const TYPED_SECRETS = ['aaaa', 'bbbb', 'dddd', 'nnnn']
const raw = (suffix: string) => JSON.stringify(richConfig()).match(new RegExp(`"(?:Bearer )?(acme-[a-z]+-${suffix})"`))![1]!

describe('where each client view applies it', () => {
  it('the Mac masks the free-form maps and the push tokens; the typed fields Settings edits stay', () => {
    const out = maskForMacClients(richConfig())
    const text = JSON.stringify(out)
    for (const s of FREE_FORM_SECRETS) expect(text, s).not.toContain(raw(s))
    for (const s of TYPED_SECRETS) expect(text, s).toContain(raw(s))
    expect(out.plugins['acme-sync']).toMatchObject({ client_id: 'acme-client', base_url: 'https://acme.invalid', project_key: 'ACME', client_secret: tail('eeee'), access_token: tail('ffff'), refresh_token: tail('gggg') })
    expect(out.plugins['acme-sync'].oauth).toEqual({ signing: { private_key: tail('hhhh') } })
    // A plugin id is a name, not a field: a plugin called token-sync keeps its label.
    expect(out.plugins['token-sync']).toEqual({ enabled: true, label: 'Token sync', password: tail('iiii') })
    expect(out.providers.openai.headers).toEqual({ Authorization: tail('cccc'), 'anthropic-version': '2023-06-01' })
    expect(out.hosts['secret-box'].server.build_env).toEqual({ NPM_TOKEN: tail('jjjj'), NODE_OPTIONS: '--max-old-space-size=4096' })
    expect(out.hosts['secret-box'].label).toBe('Secret box')
    expect(out.hooks.defs[0]!.action).toEqual({ type: 'notify', message: 'done', webhook_secret: tail('mmmm') })
    expect(out.push_tokens[0]).not.toHaveProperty('claims')
  })

  it('a replica and a bug report mask every secret, by name or by shape; names of map entries are never judged', () => {
    const out = redactConfig(richConfig()) as ReturnType<typeof richConfig>
    const text = JSON.stringify(out)
    for (const s of [...FREE_FORM_SECRETS, ...TYPED_SECRETS]) expect(text, s).not.toContain(raw(s))
    expect(out.providers['bearer-proxy']).toEqual({ api: 'anthropic', aws_session_token: tail('dddd'), max_tokens_field: 'max_completion_tokens' })
    expect(out.plugins['token-sync'].label).toBe('Token sync')
    expect(out.hosts['secret-box']).toMatchObject({ hostname: 'secret-box.invalid', label: 'Secret box' })
    expect(out.api_keys).toEqual([{ name: 'legacy', key: tail('nnnn'), created_at: '2026-01-01' }])
    expect(out.push_tokens[0]).not.toHaveProperty('claims')
  })
})

describe('a mask written back keeps the stored value', () => {
  it('recognises every mask a view sends, and nothing else', () => {
    for (const m of [B.repeat(4), B.repeat(6), B.repeat(8) + 'abcd', B.repeat(8) + 'ab']) expect(isMaskedSecret(m), m).toBe(true)
    for (const v of ['', 'abcd', `${B.repeat(3)}abcd`, `${B.repeat(8)}abcde`, `ab${B.repeat(8)}cd`, 'acme-secret', 42]) expect(isMaskedSecret(v), String(v)).toBe(false)
  })

  it('a mask becomes the stored value at its own path; an edit, an empty value and a removed key are written as sent', () => {
    const stored = { a: { client_secret: 'stored-1', token: 'stored-2', gone: 'stored-3', note: 'n' } }
    const sent = { a: { client_secret: B.repeat(8) + '-1', token: 'typed-new', note: '' } }
    expect(restoreMaskedSecrets(sent, stored)).toEqual({ a: { client_secret: 'stored-1', token: 'typed-new', note: '' } })
  })

  it('a mask with nothing stored at its path is left out, never written', () => {
    expect(restoreMaskedSecrets({ a: { secret: B.repeat(6), other: 'x' } }, { b: { secret: 'elsewhere' } })).toEqual({ a: { other: 'x' } })
    expect(restoreMaskedSecrets({ a: B.repeat(4) }, { a: 7 })).toEqual({})
  })

  it('records in a list are paired by id, then by name, then by position, so a reordered list keeps each one\'s value', () => {
    const stored = {
      defs: [{ id: 'one', action: { token: 's-one' } }, { id: 'two', action: { token: 's-two' } }],
      api_keys: [{ name: 'a', key: 'k-a' }, { name: 'b', key: 'k-b' }],
      list: ['s-0', 's-1'],
    }
    const sent = {
      defs: [{ id: 'two', action: { token: B.repeat(4) } }, { id: 'new', action: { token: B.repeat(4) } }, { id: 'one', action: { token: B.repeat(4) } }],
      api_keys: [{ name: 'b', key: B.repeat(4) }, { name: 'a', key: B.repeat(4) }],
      list: [B.repeat(4), 'typed'],
    }
    expect(restoreMaskedSecrets(sent, stored)).toEqual({
      defs: [{ id: 'two', action: { token: 's-two' } }, { id: 'new', action: {} }, { id: 'one', action: { token: 's-one' } }],
      api_keys: [{ name: 'b', key: 'k-b' }, { name: 'a', key: 'k-a' }],
      list: ['s-0', 'typed'],
    })
  })

  it('a key called __proto__ in a write stays a key, as JSON.parse made it, and changes no prototype', () => {
    const sent = JSON.parse('{"__proto__": {"hosts": {"x": {}}}, "plugins": {"acme": {"token": "\\u2022\\u2022\\u2022\\u2022"}}}') as Record<string, unknown>
    const out = restoreMaskedSecrets(sent, { plugins: { acme: { token: 'stored' } } }) as Record<string, any>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.keys(out)).toEqual(['__proto__', 'plugins'])
    expect(out.hosts).toBeUndefined()
    expect(out.plugins.acme.token).toBe('stored')
    const masked = maskSecretShapes(sent) as Record<string, unknown>
    expect(Object.getPrototypeOf(masked)).toBe(Object.prototype)
    expect(Object.keys(masked)).toEqual(['__proto__', 'plugins'])
  })

  it('a whole round trip of either view writes back exactly what was stored', () => {
    const views: Array<(c: unknown) => unknown> = [maskForMacClients, redactConfig]
    for (const view of views) {
      const stored = richConfig()
      const read = JSON.parse(JSON.stringify(view(stored))) as Record<string, unknown>
      expect(JSON.stringify(read)).toContain(B)
      // push_tokens are never written through the config (PUT drops them), and claims never leave.
      const { push_tokens: _read, ...sent } = read
      const { push_tokens: _stored, ...rest } = stored
      expect(restoreMaskedSecrets(sent, stored)).toEqual(rest)
    }
  })
})

describe('every free-form map in the Config type is accounted for', () => {
  /**
   * Masked by shape on the Mac (maskFreeFormMaps in src/core/config-redact.ts), with a
   * path to put a secret at. A new entry needs a line in maskFreeFormMaps too.
   */
  const MASKED: Record<string, (secret: string) => Record<string, unknown>> = {
    plugins: (s) => ({ plugins: { acme: { client_secret: s } } }),
    headers: (s) => ({ providers: { acme: { api: 'openai-chat', headers: { Authorization: s } } } }),
    build_env: (s) => ({ hosts: { acme: { hostname: 'acme.invalid', server: { build_env: { NPM_TOKEN: s } } } } }),
    'hosts.options': (s) => ({ hosts: { acme: { hostname: 'acme.invalid', server: { expose: { options: { token: s } } } } } }),
    'expose.options': (s) => ({ expose: { options: { token: s } } }),
    action: (s) => ({ hooks: { defs: [{ id: 'acme', on: ['onTurnComplete'], action: { type: 'notify', token: s } }] } }),
  }
  /** Maps whose values are typed (each field judged by name and, on a replica, by shape) or hold no secret. */
  const NOT_FREE_FORM: Record<string, string> = {
    providers: 'keyed by provider name; each value is a typed ProviderConfig',
    hosts: 'keyed by host name; each value is a typed host record',
    session_limits: 'numbers',
    excluded_cwds: 'directory paths per host',
    overrides: 'hooks.overrides: enabled, priority, timeoutMs',
    tag_display: 'shown | value | hidden',
    tag_links: 'tag name to a link template',
  }

  it('each map the types declare is masked or explained', () => {
    const body = (file: string, start: RegExp) => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf-8')
      const from = text.search(start)
      expect(from, file).toBeGreaterThanOrEqual(0)
      return text.slice(from, text.indexOf('\n}', from))
    }
    const owners = (text: string) => [...text.matchAll(/^\s*(?:'([^']+)'|(\w+))\??:\s*(?:Record<string,|\{[^\n]*\[key: string\])/gm)].map((m) => m[1] ?? m[2])
    const found = [...owners(body('src/core/types.ts', /^export interface Config \{/m)), ...owners(body('src/model/providers/types.ts', /^export interface ProviderConfig \{/m))]
    // `options` appears twice: under a host server's expose and under this server's expose.
    expect(found.filter((k) => k === 'options')).toHaveLength(2)
    const accounted = new Set([...Object.keys(MASKED).map((k) => k.replace(/^.*\./, '')), ...Object.keys(NOT_FREE_FORM)])
    // A new map fails here: mask it in maskFreeFormMaps and add it to MASKED, or say in
    // NOT_FREE_FORM why it holds no secret.
    expect(found.filter((k) => !accounted.has(k))).toEqual([])
    expect([...new Set(found)].sort()).toEqual([...accounted].sort())
  })

  it('the Mac view masks a secret placed in each masked map', () => {
    for (const [name, place] of Object.entries(MASKED)) {
      const secret = `acme-${name.replace(/\W/g, '')}-secret-zz`
      expect(JSON.stringify(maskForMacClients(place(secret))), name).not.toContain(secret)
    }
  })
})
