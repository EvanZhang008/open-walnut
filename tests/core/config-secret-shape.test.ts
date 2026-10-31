/**
 * Secrets judged by the shape of their key (src/core/config-secret-shape.ts).
 *
 * A plugin's settings, a provider's extra headers, an engine's environment, a
 * host server's build env, a tunnel provider's options and a hook action's
 * arguments are maps no field list describes. GET /api/config, every
 * `config:changed` and the plugin settings forms mask the values whose key names
 * a secret and the password of any URL in a value, and PUT /api/config puts each
 * mask read back to its stored value. This file pins:
 *  - the rule, key by key, both ways (what it hides and what it keeps);
 *  - that it hides no key a shipped plugin's settings form shows;
 *  - where each client view applies it (the Mac: the free-form maps only; a
 *    replica and a bug report: everywhere), and that a map keyed by a name
 *    (a plugin id, a host) is never judged by that name;
 *  - the restore, including that a whole round trip of either view writes back
 *    exactly what was stored;
 *  - that every free-form map in the Config type is either masked by shape on
 *    the Mac or listed here with the reason it holds no secret, and that every
 *    section of the config the code reads without its type is in that type.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  BLIND_LIST_MASK, holdsEditedMask, isSecretKey, isMaskedSecret, listEntriesWithoutTail, maskPluginFormValues, maskSecretShapes, maskUrlPasswords,
  MaskedValueError, NOT_SECRET_KEYS, PLUGIN_FORM_MASK, restoreMaskedSecrets,
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
      // A vendor's key, whatever the vendor; a key for ssh, hmac, tls or a deploy.
      'OPENAI_KEY', 'STRIPE_KEY', 'ANTHROPIC_KEY', 'stripe_key', 'openaiKey', 'SSH_KEY', 'ssh_key', 'ssh_keys',
      'DEPLOY_KEY', 'STORAGE_KEY', 'tls_key', 'hmac_key', 'hmacKey', 'keys',
      // A personal access token.
      'GITHUB_PAT', 'gitlab_pat', 'githubPat', 'pat',
      // Plural tokens: a list of them.
      'tokens', 'api_tokens', 'apiTokens', 'access_tokens', 'refresh_tokens', 'oauth_tokens', 'githubtokens', 'tokens_list',
      'passcode', 'passwords', 'basic_auth', 'totp_seed',
      // A password by its short names, as the last word; lists of tokens to read or write with.
      'DB_PASS', 'SMTP_PASS', 'MAIL_PASS', 'PASS', 'pass', 'DB_PW', 'LDAP_BIND_PW', 'READ_TOKENS', 'write_tokens',
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
      'tokenizer', 'jql_filter', 'list_mapping', 'enabled', '',
      // A key that is a lookup, the public half of a pair, or a path to a key.
      'public_key', 'publicKey', 'primary_key', 'partition_key', 'space_key', 'team_key', 'issue_key',
      'shortcut_key', 'cache_key', 'hotkey', 'ssh_key_path', 'key_name', 'key_path', 'monkey',
      // Counts of tokens.
      'output_tokens', 'prompt_tokens', 'total_tokens', 'budget_tokens', 'cache_read_input_tokens', 'cachedTokens',
      'patch', 'path', 'dispatch', 'bypass', 'pass_through', 'compass', 'passive', 'pwa_name',
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
      oauth: { grant: { access_token: 'acme-access-3333', refresh_token: 'acme-refresh-4444', token_type: 'Bearer' } },
      empty_secret: '', max_tokens: 4096,
    })
    expect(out).toEqual({
      client_id: 'acme-client', client_secret: tail('1111'), enabled: true, sync_interval_ms: 60_000,
      auth: { type: 'api-token', email: 'owner@example.invalid', token: tail('2222') },
      oauth: { grant: { access_token: tail('3333'), refresh_token: tail('4444'), token_type: 'Bearer' } },
      empty_secret: '', max_tokens: 4096,
    })
  })

  it('a map under a secret key is all secrets; a record in a list under one is judged by its own keys', () => {
    const out = maskSecretShapes({
      secrets: { github: 'acme-gh-5555', nested: [{ any: 'acme-any-6666' }] },
      api_keys: [{ name: 'legacy', key: 'acme-legacy-7777', created_at: '2026-01-01' }],
      labels: ['plain'],
      credentials: ['acme-cred-8888'],
      oauth: { tokens: { access_token: 'acme-access-9999', token_type: 'Bearer' } },
    })
    expect(out).toEqual({
      secrets: { github: tail('5555'), nested: [{ any: tail('6666') }] },
      api_keys: [{ name: 'legacy', key: tail('7777'), created_at: '2026-01-01' }],
      labels: ['plain'],
      credentials: [tail('8888')],
      // `tokens` is a map of tokens: all of it, its scheme name too (display only, a write restores it).
      oauth: { tokens: { access_token: tail('9999'), token_type: tail('arer') } },
    })
  })

  it('masks the password of a URL in any value, and only the password', () => {
    const M = B.repeat(8)
    expect(maskSecretShapes({
      database_url: 'postgres://acme:hunter2-acme@db.acme.invalid:5432/acme',
      redis: 'redis://:p%40ss@cache.acme.invalid:6379/0',
      command: 'psql postgres://ops:at@sign@db.acme.invalid/acme -c "select 1"',
      dsn: 'https://publickey@o1.ingest.acme.invalid/2',
      plain: 'https://acme.invalid/path?q=a:b@c',
      ssh: 'git@github.com:acme/repo.git',
      port: 'https://acme.invalid:8443/x',
    })).toEqual({
      database_url: `postgres://acme:${M}@db.acme.invalid:5432/acme`,
      redis: `redis://:${M}@cache.acme.invalid:6379/0`,
      command: `psql postgres://ops:${M}@db.acme.invalid/acme -c "select 1"`,
      // A URL with a user and no password, a query, an scp-style address and a port are no password.
      dsn: 'https://publickey@o1.ingest.acme.invalid/2',
      plain: 'https://acme.invalid/path?q=a:b@c',
      ssh: 'git@github.com:acme/repo.git',
      port: 'https://acme.invalid:8443/x',
    })
    expect(maskUrlPasswords('mysql://a:b@h/x and amqp://c:d@h2')).toBe(`mysql://a:${M}@h/x and amqp://c:${M}@h2`)
    // A secret-named key masks the whole value, URL or not.
    expect(maskSecretShapes({ DATABASE_PASSWORD: 'postgres://acme:pw-acme-1234@db' })).toEqual({ DATABASE_PASSWORD: B.repeat(8) + '4@db' })
  })

  it('the plugin settings forms get six bullets, the mask their save leaves out; a list keeps its entries apart', () => {
    expect(PLUGIN_FORM_MASK).toBe(B.repeat(6))
    expect(maskPluginFormValues({ base_url: 'https://acme.invalid', auth: { token: 'acme-tok-9999' }, token_url: 'https://acme.invalid/t', db: 'postgres://u:pw@h/d' }))
      .toEqual({ base_url: 'https://acme.invalid', auth: { token: B.repeat(6) }, token_url: 'https://acme.invalid/t', db: `postgres://u:${B.repeat(8)}@h/d` })
    // A list of secrets is edited as a whole, so in the console's form each entry shows its tail (as
    // GET /api/config does): a save after deleting one says which ones are left. A record in a list
    // keeps the form's mask.
    const values = { api_keys: ['sk-acme-1111', 'sk-acme-2222'], secrets: [{ name: 'NPM_TOKEN', value: 'v-npm-3333' }] }
    expect(maskPluginFormValues(values, { listTails: true }))
      .toEqual({ api_keys: [tail('1111'), tail('2222')], secrets: [{ name: 'NPM_TOKEN', value: B.repeat(6) }] })
    // Without `listTails` (GET /api/v1/integrations/settings, which the companion can forward): no tails.
    expect(maskPluginFormValues(values)).toEqual({ api_keys: [B.repeat(6), B.repeat(6)], secrets: [{ name: 'NPM_TOKEN', value: B.repeat(6) }] })
    // Either view, saved back as read, writes every value back.
    expect(restoreMaskedSecrets(maskPluginFormValues(values), values)).toEqual(values)
    expect(restoreMaskedSecrets(maskPluginFormValues(values, { listTails: true }), values)).toEqual(values)
  })

  it('a list entry whose tail would not tell it apart, or that a mask could not carry, shows bullets only; a comma or a space inside the tail is an ordinary character, whitespace at its end is not', () => {
    const list = ['sk-dup-a-1111', 'sk-dup-b-1111', 'sk-tail-c,dd', 'sk-sp-ab c', 'sk-end-abc ', 'abcd', 'q7', 'sk-solo-5678', 'sk-dot-\u2022xyz', 'sk-nl-ab\ncd', 'sk-cr-ab\rcd']
    // The form trims each line of a list of secrets, so a tail that ends in whitespace would come back without it.
    expect([...listEntriesWithoutTail(list)].sort()).toEqual(['abcd', 'q7', 'sk-cr-ab\rcd', 'sk-dot-\u2022xyz', 'sk-dup-a-1111', 'sk-dup-b-1111', 'sk-end-abc ', 'sk-nl-ab\ncd'].sort())
    const X = BLIND_LIST_MASK
    const shown = [X, X, tail('c,dd'), tail('ab c'), X, X, X, tail('5678'), X, X, X]
    expect(BLIND_LIST_MASK).toBe(B.repeat(8))
    // Every view that shows tails shows these without one: the Mac's, the companion's, the console's form.
    expect(maskSecretShapes({ api_keys: list })).toEqual({ api_keys: shown })
    expect((maskForMacClients({ plugins: { acme: { api_keys: list } } }) as any).plugins.acme.api_keys).toEqual(shown)
    expect((redactConfig({ plugins: { acme: { api_keys: list } } }) as any).plugins.acme.api_keys).toEqual(shown)
    expect(maskPluginFormValues({ api_keys: list }, { listTails: true })).toEqual({ api_keys: shown })
    // A value at a key is not in a list: its tail shows as before.
    expect(maskSecretShapes({ api_key: 'sk-tail-c,dd' })).toEqual({ api_key: tail('c,dd') })
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
      'bearer-proxy': { api: 'anthropic', aws_session_token: 'acme-session-dddd', max_tokens_field: 'max_completion_tokens', base_url: 'https://proxy:acme-proxy-xxxx@proxy.acme.invalid/v1' },
    },
    engines: {
      custom: { adapter_cmd: ['acme-agent', 'acp'], env: { ANTHROPIC_API_KEY: 'acme-engine-oooo', ANTHROPIC_BASE_URL: 'https://proxy.acme.invalid', DISABLE_TELEMETRY: null } },
      // An engine id is a name, never judged: this one would read as a secret.
      'secret-agent': { adapter_cmd: ['secret-agent', 'acp'] },
    },
    plugins: {
      'acme-sync': {
        enabled: true, client_id: 'acme-client', client_secret: 'acme-secret-eeee', access_token: 'acme-access-ffff',
        refresh_token: 'acme-refresh-gggg', base_url: 'https://acme.invalid', project_key: 'ACME',
        oauth: { signing: { private_key: 'acme-pk-hhhh' } },
        GITHUB_PAT: 'acme-pat-pppp', api_tokens: 'acme-tokens-qqqq', stripe_key: 'acme-stripe-rrrr',
        database_url: 'postgres://acme:acme-dbpw-ssss@db.acme.invalid:5432/acme',
        servers: ['imap://acme:acme-imap-uuuu@h1.acme.invalid/', 'imap://acme:acme-imap-vvvv@h2.acme.invalid/'],
        secrets: [{ name: 'GITHUB_TOKEN', value: 'acme-listed-wwww' }, { name: 'REGION', value: 'us-west-2' }],
      },
      'token-sync': { enabled: true, label: 'Token sync', password: 'acme-pw-iiii' },
    },
    hosts: {
      'secret-box': {
        hostname: 'secret-box.invalid', label: 'Secret box', enabled: false,
        server: { enabled: false, build_env: { NPM_TOKEN: 'acme-npm-jjjj', OPENAI_KEY: 'acme-vendor-tttt', NODE_OPTIONS: '--max-old-space-size=4096' }, expose: { enabled: false, options: { tunnel: 'acme', auth_token: 'acme-tun-kkkk' } } },
      },
    },
    expose: { enabled: false, provider: 'acme', options: { name: 'acme-tunnel', token: 'acme-expose-llll' } },
    hooks: { defs: [{ id: 'acme-hook', on: ['onTurnComplete'], action: { type: 'notify', message: 'done', webhook_secret: 'acme-hook-mmmm' } }] },
    api_keys: [{ name: 'legacy', key: 'acme-apikey-nnnn', created_at: '2026-01-01' }],
    push_tokens: [{ token: 'ab'.repeat(32), platform: 'ios', key_name: 'acme-phone', claims: ['acme-claim'] }],
  }
}

const FREE_FORM_SECRETS = ['eeee', 'ffff', 'gggg', 'hhhh', 'iiii', 'cccc', 'jjjj', 'kkkk', 'llll', 'mmmm', 'oooo', 'pppp', 'qqqq', 'rrrr', 'ssss', 'tttt', 'uuuu', 'vvvv', 'wwww']
const TYPED_SECRETS = ['aaaa', 'bbbb', 'dddd', 'nnnn', 'xxxx']
const raw = (suffix: string) => JSON.stringify(richConfig()).match(new RegExp(`(?:"|Bearer |:)(acme-[a-z]+-${suffix})(?:"|@)`))![1]!
const DB_URL = (password: string) => `postgres://acme:${password}@db.acme.invalid:5432/acme`

describe('where each client view applies it', () => {
  it('the Mac masks the free-form maps and the push tokens; the typed fields Settings edits stay', () => {
    const out = maskForMacClients(richConfig())
    const text = JSON.stringify(out)
    for (const s of FREE_FORM_SECRETS) expect(text, s).not.toContain(raw(s))
    for (const s of TYPED_SECRETS) expect(text, s).toContain(raw(s))
    expect(out.plugins['acme-sync']).toMatchObject({ client_id: 'acme-client', base_url: 'https://acme.invalid', project_key: 'ACME', client_secret: tail('eeee'), access_token: tail('ffff'), refresh_token: tail('gggg') })
    expect(out.plugins['acme-sync'].oauth).toEqual({ signing: { private_key: tail('hhhh') } })
    expect(out.plugins['acme-sync']).toMatchObject({ GITHUB_PAT: tail('pppp'), api_tokens: tail('qqqq'), stripe_key: tail('rrrr'), database_url: DB_URL(B.repeat(8)) })
    // Each string in a list has its URL password masked; a `{ name, value }` entry named like a secret has its value masked.
    expect(out.plugins['acme-sync'].servers).toEqual([`imap://acme:${B.repeat(8)}@h1.acme.invalid/`, `imap://acme:${B.repeat(8)}@h2.acme.invalid/`])
    expect(out.plugins['acme-sync'].secrets).toEqual([{ name: 'GITHUB_TOKEN', value: tail('wwww') }, { name: 'REGION', value: 'us-west-2' }])
    // An engine's environment: its API key masked, the rest (and the engine id, a name) as it is.
    expect(out.engines.custom).toEqual({ adapter_cmd: ['acme-agent', 'acp'], env: { ANTHROPIC_API_KEY: tail('oooo'), ANTHROPIC_BASE_URL: 'https://proxy.acme.invalid', DISABLE_TELEMETRY: null } })
    // A plugin id is a name, not a field: a plugin called token-sync keeps its label.
    expect(out.plugins['token-sync']).toEqual({ enabled: true, label: 'Token sync', password: tail('iiii') })
    expect(out.providers.openai.headers).toEqual({ Authorization: tail('cccc'), 'anthropic-version': '2023-06-01' })
    expect(out.hosts['secret-box'].server.build_env).toEqual({ NPM_TOKEN: tail('jjjj'), OPENAI_KEY: tail('tttt'), NODE_OPTIONS: '--max-old-space-size=4096' })
    expect(out.hosts['secret-box'].label).toBe('Secret box')
    expect(out.hooks.defs[0]!.action).toEqual({ type: 'notify', message: 'done', webhook_secret: tail('mmmm') })
    expect(out.push_tokens[0]).not.toHaveProperty('claims')
  })

  it('a replica and a bug report mask every secret, by name or by shape; names of map entries are never judged', () => {
    const out = redactConfig(richConfig()) as ReturnType<typeof richConfig>
    const text = JSON.stringify(out)
    for (const s of [...FREE_FORM_SECRETS, ...TYPED_SECRETS]) expect(text, s).not.toContain(raw(s))
    expect(out.providers['bearer-proxy']).toEqual({ api: 'anthropic', aws_session_token: tail('dddd'), max_tokens_field: 'max_completion_tokens', base_url: `https://proxy:${B.repeat(8)}@proxy.acme.invalid/v1` })
    expect(out.plugins['acme-sync'].servers).toEqual([`imap://acme:${B.repeat(8)}@h1.acme.invalid/`, `imap://acme:${B.repeat(8)}@h2.acme.invalid/`])
    expect(out.plugins['acme-sync'].secrets[0]).toEqual({ name: 'GITHUB_TOKEN', value: tail('wwww') })
    expect(out.plugins['token-sync'].label).toBe('Token sync')
    expect(out.hosts['secret-box']).toMatchObject({ hostname: 'secret-box.invalid', label: 'Secret box' })
    expect(out.api_keys).toEqual([{ name: 'legacy', key: tail('nnnn'), created_at: '2026-01-01' }])
    expect(out.push_tokens[0]).not.toHaveProperty('claims')
    expect(out.engines.custom.env).toEqual({ ANTHROPIC_API_KEY: tail('oooo'), ANTHROPIC_BASE_URL: 'https://proxy.acme.invalid', DISABLE_TELEMETRY: null })
    expect(out.engines['secret-agent']).toEqual({ adapter_cmd: ['secret-agent', 'acp'] })
    expect(out.plugins['acme-sync'].database_url).toBe(DB_URL(B.repeat(8)))
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

  it('a mask with nothing stored at its path is refused, naming the path, never written or guessed', () => {
    // A key renamed with its value still masked would otherwise lose the value with the old key.
    expect(() => restoreMaskedSecrets({ a: { secret: B.repeat(6), other: 'x' } }, { b: { secret: 'elsewhere' } }, 'plugins'))
      .toThrow(expect.objectContaining({ name: 'MaskedValueError', code: 'masked_value_unmatched', field: 'plugins.a.secret' }))
    expect(() => restoreMaskedSecrets({ a: B.repeat(4) }, { a: 7 })).toThrow(expect.objectContaining({ field: 'a' }))
    expect(() => restoreMaskedSecrets({ list: [B.repeat(6)] }, {})).toThrow(expect.objectContaining({ field: 'list[0]' }))
    expect(() => restoreMaskedSecrets({ list: [{ token: B.repeat(6) }] }, { list: ['x'] })).toThrow(expect.objectContaining({ field: 'list[0]' }))
    expect(() => restoreMaskedSecrets({ a: { secret: B.repeat(6) } }, { b: {} })).toThrow(expect.objectContaining({ reason: 'missing' }))
    // The error says what to do, and never carries a value.
    expect(new MaskedValueError('plugins.a.secret', 'missing').message).toBe('plugins.a.secret was sent back hidden, and nothing is stored under the same name or address. Type the full value of plugins.a.secret.')
  })

  it('records in a list are paired by id, then by name, never by position; a new one carries no mask', () => {
    const stored = {
      defs: [{ id: 'one', action: { token: 's-one' } }, { id: 'two', action: { token: 's-two' } }],
      api_keys: [{ name: 'a', key: 'k-a' }, { name: 'b', key: 'k-b' }],
      secrets: [{ name: 'GH_TOKEN', value: 'v-gh' }, { name: 'NPM_TOKEN', value: 'v-npm' }],
    }
    expect(restoreMaskedSecrets({
      defs: [{ id: 'two', action: { token: B.repeat(4) } }, { id: 'new', action: { token: 'typed' } }, { id: 'one', action: { token: B.repeat(4) } }],
      api_keys: [{ name: 'b', key: B.repeat(4) }],
      secrets: [{ name: 'NPM_TOKEN', value: B.repeat(8) + '-npm' }, { name: 'GH_TOKEN', value: B.repeat(8) + '-gh' }],
    }, stored)).toEqual({
      defs: [{ id: 'two', action: { token: 's-two' } }, { id: 'new', action: { token: 'typed' } }, { id: 'one', action: { token: 's-one' } }],
      api_keys: [{ name: 'b', key: 'k-b' }],
      secrets: [{ name: 'NPM_TOKEN', value: 'v-npm' }, { name: 'GH_TOKEN', value: 'v-gh' }],
    })
    // Paired by name, a record keeps its stored secret while another field of it is edited.
    expect(restoreMaskedSecrets({ secrets: [{ name: 'NPM_TOKEN', value: B.repeat(6), scope: 'ci' }] }, stored))
      .toEqual({ secrets: [{ name: 'NPM_TOKEN', value: 'v-npm', scope: 'ci' }] })
    // A record whose id or name is not stored, with a mask in it (a copy, a rename): refused, never dropped.
    expect(() => restoreMaskedSecrets({ defs: [{ id: 'copy', action: { token: B.repeat(4) } }] }, stored)).toThrow(MaskedValueError)
    expect(() => restoreMaskedSecrets({ secrets: [{ name: 'GITHUB_TOKEN', value: B.repeat(8) + '-gh' }] }, stored, 'plugins.acme'))
      .toThrow(expect.objectContaining({ field: 'plugins.acme.secrets[0].name' }))
  })

  it('a list of secrets: sent back as read it is restored as stored; changed, each mask takes the one entry it shows', () => {
    const stored = { keys: ['sk-acme-1111', 'sk-acme-2222', 'sk-acme-3333'] }
    const tails = stored.keys.map(tail)
    // As read (the plugin form shows six bullets, no tail), deleted, inserted at the top, reordered.
    expect(restoreMaskedSecrets({ keys: [B.repeat(6), B.repeat(6), B.repeat(6)] }, stored)).toEqual(stored)
    expect(restoreMaskedSecrets({ keys: [tails[1], tails[2]] }, stored)).toEqual({ keys: ['sk-acme-2222', 'sk-acme-3333'] })
    expect(restoreMaskedSecrets({ keys: ['sk-typed-0000', ...tails] }, stored)).toEqual({ keys: ['sk-typed-0000', ...stored.keys] })
    expect(restoreMaskedSecrets({ keys: [tails[2], tails[0], tails[1]] }, stored)).toEqual({ keys: ['sk-acme-3333', 'sk-acme-1111', 'sk-acme-2222'] })
    // A mask that could stand for more than one entry, or for none: refused.
    expect(() => restoreMaskedSecrets({ keys: [B.repeat(6), B.repeat(6)] }, stored)).toThrow(expect.objectContaining({ field: 'keys[0]' }))
    expect(() => restoreMaskedSecrets({ keys: [B.repeat(8) + 'zzzz'] }, stored)).toThrow(MaskedValueError)
    // Records with no id or name: each takes the one stored record it shows unchanged.
    const hosts = { list: [{ url: 'h1', token: 't-1111' }, { url: 'h2', token: 't-2222' }] }
    expect(restoreMaskedSecrets({ list: [{ url: 'h2', token: tail('t-2222') }] }, hosts)).toEqual({ list: [{ url: 'h2', token: 't-2222' }] })
    expect(() => restoreMaskedSecrets({ list: [{ url: 'h3', token: tail('t-2222') }] }, hosts)).toThrow(MaskedValueError)
  })

  it('a masked URL password takes the password of the stored URL with the same address, never by position', () => {
    const M = B.repeat(8)
    const url = (n: number, password: string) => `imap://acme:${password}@h${n}.acme.invalid/`
    const stored = { servers: [url(1, 'P1'), url(2, 'P2'), url(3, 'P3')] }
    const read = { servers: [url(1, M), url(2, M), url(3, M)] }
    expect(restoreMaskedSecrets(read, stored)).toEqual(stored)
    // Delete the first, insert a typed one at the top, swap two, a typed one before a masked one.
    expect(restoreMaskedSecrets({ servers: [url(2, M), url(3, M)] }, stored)).toEqual({ servers: [url(2, 'P2'), url(3, 'P3')] })
    expect(restoreMaskedSecrets({ servers: [url(0, 'typed'), ...read.servers] }, stored)).toEqual({ servers: [url(0, 'typed'), ...stored.servers] })
    expect(restoreMaskedSecrets({ servers: [url(2, M), url(1, M), url(3, M)] }, stored)).toEqual({ servers: [url(2, 'P2'), url(1, 'P1'), url(3, 'P3')] })
    expect(restoreMaskedSecrets({ servers: [url(1, 'typed'), url(2, M)] }, stored)).toEqual({ servers: [url(1, 'typed'), url(2, 'P2')] })
    // A changed host, user, scheme or port with the password still hidden matches nothing: refused, naming the field.
    for (const moved of ['imap://acme:%s@h9.acme.invalid/', 'imap://ops:%s@h1.acme.invalid/', 'imaps://acme:%s@h1.acme.invalid/', 'imap://acme:%s@h1.acme.invalid:993/']) {
      expect(() => restoreMaskedSecrets({ servers: [moved.replace('%s', M)] }, stored, 'plugins.acme'), moved)
        .toThrow(expect.objectContaining({ field: 'plugins.acme.servers[0]' }))
    }
    // Two stored entries with the same address and different passwords: refused rather than guessed.
    expect(() => restoreMaskedSecrets({ servers: [url(1, M)] }, { servers: [url(1, 'P1'), url(1, 'P9')] })).toThrow(MaskedValueError)
  })

  it('in one string, each masked URL takes its own password; the rest of the string is the client\'s', () => {
    const M = B.repeat(8)
    const stored = { broker: 'amqp://a:P3@h3.acme.invalid/x amqp://b:P4@h4.acme.invalid/y', db: DB_URL('pw-1'), cmd: `psql ${DB_URL('pw-2')} -c "select 1"` }
    expect(restoreMaskedSecrets({
      broker: `amqp://b:${M}@h4.acme.invalid/y`,
      db: DB_URL(M),
      cmd: `psql ${DB_URL(M)} -c "select 2"`,
    }, stored)).toEqual({ broker: 'amqp://b:P4@h4.acme.invalid/y', db: DB_URL('pw-1'), cmd: `psql ${DB_URL('pw-2')} -c "select 2"` })
    // A typed password beside a masked one: the typed one is written as typed.
    expect(restoreMaskedSecrets({ broker: `amqp://a:typed@h3.acme.invalid/x amqp://b:${M}@h4.acme.invalid/y` }, stored))
      .toEqual({ broker: 'amqp://a:typed@h3.acme.invalid/x amqp://b:P4@h4.acme.invalid/y' })
    // Swapped in the string: each keeps its own.
    expect(restoreMaskedSecrets({ broker: `amqp://b:${M}@h4.acme.invalid/y amqp://a:${M}@h3.acme.invalid/x` }, stored))
      .toEqual({ broker: 'amqp://b:P4@h4.acme.invalid/y amqp://a:P3@h3.acme.invalid/x' })
    // A URL more than stored, or nothing stored at the key.
    expect(() => restoreMaskedSecrets({ broker: `amqp://c:${M}@h5.acme.invalid/z` }, stored)).toThrow(expect.objectContaining({ field: 'broker' }))
    expect(() => restoreMaskedSecrets({ other: DB_URL(M), db: DB_URL(M) }, stored)).toThrow(expect.objectContaining({ field: 'other' }))
  })

  it('a URL is told apart by its path too: two on one host keep their own passwords, a changed path is refused', () => {
    const M = B.repeat(8)
    const at = (path: string, password: string) => `imap://acme:${password}@h1.acme.invalid/${path}`
    const stored = { servers: [at('inbox', 'P1'), at('archive', 'P2')], db: DB_URL('pw-1') }
    expect(restoreMaskedSecrets({ servers: [at('archive', M)] }, stored)).toEqual({ servers: [at('archive', 'P2')] })
    expect(restoreMaskedSecrets({ servers: [at('archive', M), at('inbox', M)] }, stored)).toEqual({ servers: [at('archive', 'P2'), at('inbox', 'P1')] })
    // A path no stored URL has: nothing matches (an address without its path would match two).
    expect(() => restoreMaskedSecrets({ servers: [at('sent', M)] }, stored)).toThrow(expect.objectContaining({ field: 'servers[0]', reason: 'missing' }))
    expect(() => restoreMaskedSecrets({ db: DB_URL(M).replace(':5432/acme', ':5432/other') }, stored)).toThrow(expect.objectContaining({ field: 'db', reason: 'missing' }))
  })

  it('a record is paired by its id before its name', () => {
    const stored = { defs: [{ id: 'a', name: 'first', action: { token: 's-first-1111' } }, { id: 'b', name: 'second', action: { token: 's-second-2222' } }] }
    // The record with id b now carries the other record's name: it is still b, with b's token.
    expect(restoreMaskedSecrets({ defs: [{ id: 'b', name: 'first', action: { token: B.repeat(6) } }] }, stored))
      .toEqual({ defs: [{ id: 'b', name: 'first', action: { token: 's-second-2222' } }] })
  })

  it('a record whose only mask is a URL password is paired too, and the mask never reaches disk', () => {
    const M = B.repeat(8)
    const stored = { mailboxes: [{ name: 'work', url: 'imap://acme:P1@h1.acme.invalid/' }, { name: 'home', url: 'imap://acme:P2@h2.acme.invalid/' }] }
    expect(restoreMaskedSecrets({ mailboxes: [{ name: 'home', url: `imap://acme:${M}@h2.acme.invalid/` }] }, stored))
      .toEqual({ mailboxes: [{ name: 'home', url: 'imap://acme:P2@h2.acme.invalid/' }] })
    expect(restoreMaskedSecrets({ mailboxes: [{ name: 'home', url: `imap://acme:${M}@h2.acme.invalid/` }, { name: 'work', url: `imap://acme:${M}@h1.acme.invalid/` }] }, stored))
      .toEqual({ mailboxes: [stored.mailboxes[1], stored.mailboxes[0]] })
  })

  it('a string sent back as read is the stored one, even with one address twice under two passwords', () => {
    const M = B.repeat(8)
    const twice = 'amqp://a:P1@h1.acme.invalid/x amqp://a:P2@h1.acme.invalid/x'
    const shown = `amqp://a:${M}@h1.acme.invalid/x amqp://a:${M}@h1.acme.invalid/x`
    expect(maskUrlPasswords(twice)).toBe(shown)
    expect(restoreMaskedSecrets({ broker: shown, other: 'x' }, { broker: twice })).toEqual({ broker: twice, other: 'x' })
    // In a list the client changed, an entry sent back as read is that entry.
    expect(restoreMaskedSecrets({ brokers: [shown] }, { brokers: ['amqp://b:P3@h3.acme.invalid/', twice] })).toEqual({ brokers: [twice] })
    // Changed, its two masks cannot be told apart: refused, not guessed.
    expect(() => restoreMaskedSecrets({ broker: `amqp://a:${M}@h1.acme.invalid/x` }, { broker: twice })).toThrow(expect.objectContaining({ reason: 'ambiguous' }))
  })

  it('a `{ name, value }` entry renamed with its value hidden is refused, so the value never shows under the new name', () => {
    const stored = { header: { name: 'GITHUB_TOKEN', value: 'v-gh-1111' }, defs: [{ id: 'x', name: 'GITHUB_TOKEN', value: 'v-gh-2222' }] }
    expect(() => restoreMaskedSecrets({ header: { name: 'GITHUB_NOTE', value: tail('1111') } }, stored, 'plugins.acme'))
      .toThrow(expect.objectContaining({ field: 'plugins.acme.header.name', reason: 'renamed' }))
    // Paired by its id in a list, the same.
    expect(() => restoreMaskedSecrets({ defs: [{ id: 'x', name: 'GITHUB_NOTE', value: tail('2222') }] }, stored))
      .toThrow(expect.objectContaining({ field: 'defs[0].name', reason: 'renamed' }))
    // Renamed with the value typed in, or kept under its name: written as sent.
    expect(restoreMaskedSecrets({ header: { name: 'GITHUB_NOTE', value: 'typed' } }, stored)).toEqual({ header: { name: 'GITHUB_NOTE', value: 'typed' } })
    expect(restoreMaskedSecrets({ header: { name: 'GITHUB_TOKEN', value: tail('1111') } }, stored)).toEqual({ header: stored.header })
  })

  it('every refusal names an action that works: reload only where the stored value changed, else the full value', () => {
    const unmatched = new MaskedValueError('plugins.acme.api_keys[0]')
    expect(unmatched).toMatchObject({ code: 'masked_value_unmatched', reason: 'unmatched' })
    expect(unmatched.message).toBe('plugins.acme.api_keys[0] was sent back hidden, and no value stored there matches it now (it changed after it was read). Reload to get the current settings and try again, or type the full value of plugins.acme.api_keys[0].')
    for (const reason of ['missing', 'ambiguous'] as const) {
      const message = new MaskedValueError('k[1]', reason).message
      expect(message, reason).toMatch(/ Type the full value of k\[1\]\.$/)
      expect(message, reason).not.toMatch(/Reload/)
    }
    expect(new MaskedValueError('k[1]', 'ambiguous').message).toMatch(/more than one stored value/)
    // A renamed entry's field is its name; what was sent back hidden, and what to type, is its value.
    expect(new MaskedValueError('env[0].name', 'renamed', 'env[0].value').message)
      .toBe('env[0].value was sent back hidden, while the name of its entry changed. Type the full value of env[0].value to keep it under the new name.')
    // A mask with other text typed next to it: keep the mask as shown, or type the full value.
    expect(new MaskedValueError('plugins.acme.api_keys[2]', 'edited_mask').message)
      .toBe('plugins.acme.api_keys[2] was sent back hidden, with other text added to it. Keep the hidden value exactly as it was shown, or replace it with the full value of plugins.acme.api_keys[2].')
    // A value the server changed after the client read it: a tail that matches nothing stored now.
    expect(() => restoreMaskedSecrets({ keys: [tail('1111')] }, { keys: ['sk-rotated-9999', 'sk-other-8888'] }))
      .toThrow(expect.objectContaining({ field: 'keys[0]', reason: 'unmatched' }))
    expect(() => restoreMaskedSecrets({ keys: [B.repeat(6)] }, { keys: ['sk-a-1111', 'sk-b-2222'] }))
      .toThrow(expect.objectContaining({ reason: 'ambiguous' }))
  })

  it('the plugin form\'s list, read with a tail per entry, saves a delete, a reorder and an added key', () => {
    const stored = { api_keys: ['sk-acme-1111', 'sk-acme-2222', 'sk-acme-3333'] }
    const read = maskPluginFormValues(stored, { listTails: true }) as { api_keys: string[] }
    expect(restoreMaskedSecrets({ api_keys: [read.api_keys[1]] }, stored)).toEqual({ api_keys: ['sk-acme-2222'] })
    expect(restoreMaskedSecrets({ api_keys: [read.api_keys[2], read.api_keys[0]] }, stored)).toEqual({ api_keys: ['sk-acme-3333', 'sk-acme-1111'] })
    expect(restoreMaskedSecrets({ api_keys: [...read.api_keys, 'sk-typed-4444'] }, stored)).toEqual({ api_keys: [...stored.api_keys, 'sk-typed-4444'] })
  })

  it('bullets-only entries of a changed list pair with the entries shown that way, in order, when all come back', () => {
    const X = BLIND_LIST_MASK
    const keys = ['sk-dup-a-1111', 'sk-dup-b-1111', 'sk-tail-c,dd', 'q7', 'sk-solo-5678']
    const read = maskSecretShapes({ keys }).keys as string[]
    // The comma entry shows its tail and pairs by it; the three bullets-only ones pair in order.
    expect(read).toEqual([X, X, tail('c,dd'), X, tail('5678')])
    const typed = 'sk-typed-9999'
    for (const [label, sent, want] of [
      ['the one with a tail deleted', read.slice(0, 4), keys.slice(0, 4)],
      ['reordered', [read[4], ...read.slice(0, 4)], [keys[4], ...keys.slice(0, 4)]],
      ['one added', [...read, typed], [...keys, typed]],
      ['one added in the middle', [read[0], typed, ...read.slice(1)], [keys[0], typed, ...keys.slice(1)]],
    ] as Array<[string, string[], string[]]>) {
      expect(restoreMaskedSecrets({ keys: sent }, { keys }), label).toEqual({ keys: want })
    }
    // One of them deleted: the two left could each be any of three. Refused, with the action that works.
    expect(() => restoreMaskedSecrets({ keys: [X, X, tail('c,dd'), tail('5678')] }, { keys }, 'plugins.acme'))
      .toThrow(expect.objectContaining({ field: 'plugins.acme.keys[0]', reason: 'ambiguous', message: expect.stringMatching(/Type the full value of plugins\.acme\.keys\[0\]\.$/) }))
    // A tail two different entries end with, sent back by a view read before they were shown without
    // one: it names neither of them, so it is refused, never guessed.
    expect(() => restoreMaskedSecrets({ keys: [tail('1111'), tail('5678')] }, { keys }, 'plugins.acme'))
      .toThrow(expect.objectContaining({ field: 'plugins.acme.keys[0]', reason: 'ambiguous' }))
    // Copies of one secret: any of them is that secret, so a delete pairs.
    const copy_keys = ['sk-same-1111', 'sk-same-1111', 'sk-solo-5678']
    expect(maskSecretShapes({ copy_keys }).copy_keys).toEqual([X, X, tail('5678')])
    expect(restoreMaskedSecrets({ copy_keys: [X, tail('5678')] }, { copy_keys })).toEqual({ copy_keys: ['sk-same-1111', 'sk-solo-5678'] })
    // Sent back with their tail (a view read before they were shown without one): still that one secret.
    expect(restoreMaskedSecrets({ copy_keys: [tail('1111'), tail('5678')] }, { copy_keys })).toEqual({ copy_keys: ['sk-same-1111', 'sk-solo-5678'] })
    // A comma in its tail: shown, and paired by it like any other tail.
    const comma_keys = ['sk-one-1111', 'sk-gate-c,dd', 'sk-three-3333']
    expect(maskSecretShapes({ comma_keys }).comma_keys).toEqual([tail('1111'), tail('c,dd'), tail('3333')])
    expect(restoreMaskedSecrets({ comma_keys: [tail('c,dd'), tail('3333')] }, { comma_keys })).toEqual({ comma_keys: ['sk-gate-c,dd', 'sk-three-3333'] })
    // A view with no tails at all (six bullets): one back pairs with the one stored; more is ambiguous.
    expect(restoreMaskedSecrets({ one: [PLUGIN_FORM_MASK, typed] }, { one: ['sk-only-1111'] })).toEqual({ one: ['sk-only-1111', typed] })
    expect(() => restoreMaskedSecrets({ two: [PLUGIN_FORM_MASK] }, { two: ['sk-a-1111', 'sk-b-2222'] })).toThrow(expect.objectContaining({ reason: 'ambiguous' }))
    // Nothing stored to pair with.
    expect(() => restoreMaskedSecrets({ none: [X, typed] }, { none: [] })).toThrow(expect.objectContaining({ field: 'none[0]', reason: 'missing' }))
  })

  it('a `{ name, value }` entry with no `id` renamed, or with its name removed, while its value is hidden is refused as renamed', () => {
    const env = [{ name: 'GITHUB_TOKEN', value: 'v-gh-1111' }, { name: 'REGION', value: 'us-west-2' }]
    const stored = { env, header: { name: 'GITHUB_TOKEN', value: 'v-hdr-2222' } }
    const renamed = expect.objectContaining({ field: 'env[0].name', reason: 'renamed', message: expect.stringMatching(/Type the full value of env\[0\]\.value /) })
    expect(() => restoreMaskedSecrets({ env: [{ name: 'GITHUB_NOTE', value: tail('1111') }, env[1]] }, stored)).toThrow(renamed)
    expect(() => restoreMaskedSecrets({ env: [{ name: 'GITHUB_NOTE', value: tail('1111') }] }, stored)).toThrow(renamed)
    // Its name removed or made a number: the value would show in full the same way.
    expect(() => restoreMaskedSecrets({ env: [{ value: tail('1111') }, env[1]] }, stored)).toThrow(renamed)
    expect(() => restoreMaskedSecrets({ env: [{ value: tail('1111') }] }, stored)).toThrow(renamed)
    expect(() => restoreMaskedSecrets({ header: { value: tail('2222') } }, stored)).toThrow(expect.objectContaining({ field: 'header.name', reason: 'renamed' }))
    expect(() => restoreMaskedSecrets({ header: { name: null, value: tail('2222') } }, stored)).toThrow(expect.objectContaining({ field: 'header.name', reason: 'renamed' }))
    // Its name made null or a number in a list, the other entry kept or dropped (gate r9 L-1).
    for (const name of [null, 7]) {
      expect(() => restoreMaskedSecrets({ env: [{ name, value: tail('1111') }, env[1]] }, stored), String(name)).toThrow(renamed)
      expect(() => restoreMaskedSecrets({ env: [{ name, value: tail('1111') }] }, stored), String(name)).toThrow(renamed)
    }
    // Renamed with its value typed in: written as sent.
    expect(restoreMaskedSecrets({ env: [{ name: 'GITHUB_NOTE', value: 'typed' }] }, stored)).toEqual({ env: [{ name: 'GITHUB_NOTE', value: 'typed' }] })
  })

  it('a hidden value moved onto the name of another entry (one the same write drops, or a swap) is refused as renamed', () => {
    const env = [{ name: 'GITHUB_TOKEN', value: 'v-gh-5555' }, { name: 'NPM_TOKEN', value: 'v-npm-6666' }]
    const moved = expect.objectContaining({ field: 'env[0].name', reason: 'renamed', message: expect.stringMatching(/Type the full value of env\[0\]\.value /) })
    // The first renamed to the second's name, the second dropped (gate r9 L-2): the mask shows the first's tail.
    expect(() => restoreMaskedSecrets({ env: [{ name: 'NPM_TOKEN', value: tail('5555') }] }, { env })).toThrow(moved)
    // The two names swapped.
    expect(() => restoreMaskedSecrets({ env: [{ name: 'NPM_TOKEN', value: tail('5555') }, { name: 'GITHUB_TOKEN', value: tail('6666') }] }, { env })).toThrow(moved)
    // The first dropped, the second kept as read: its own value.
    expect(restoreMaskedSecrets({ env: [{ name: 'NPM_TOKEN', value: tail('6666') }] }, { env })).toEqual({ env: [env[1]] })
    // A tail no stored entry ends with (the value changed after it was read): the namesake's, as at a key.
    expect(restoreMaskedSecrets({ env: [{ name: 'NPM_TOKEN', value: tail('0000') }] }, { env })).toEqual({ env: [env[1]] })
    // Bullets only say nothing about which value it was: the namesake's.
    expect(restoreMaskedSecrets({ env: [{ name: 'NPM_TOKEN', value: PLUGIN_FORM_MASK }] }, { env })).toEqual({ env: [env[1]] })
    // Two entries whose values end alike, both sent back as read with a third added: each keeps its own
    // (a tail that shows the namesake's value is never refused, even when another entry ends alike).
    const alike = [{ name: 'GITHUB_TOKEN', value: 'v-gh-7777' }, { name: 'NPM_TOKEN', value: 'v-npm-7777' }]
    const added = { name: 'PYPI_TOKEN', value: 'v-pypi-typed' }
    expect(restoreMaskedSecrets({ env: [{ name: 'GITHUB_TOKEN', value: tail('7777') }, { name: 'NPM_TOKEN', value: tail('7777') }, added] }, { env: alike }))
      .toEqual({ env: [...alike, added] })
  })

  it('records whose hidden value is not called `value` ({ name, token }) pair the same way, and a refusal names their own key', () => {
    const recs = [{ name: 'deploy', token: 'tok-deploy-5555' }, { name: 'publish', token: 'tok-publish-6666' }]
    const read = maskSecretShapes({ recs }).recs as Array<{ name: string; token: string }>
    expect(read).toEqual([{ name: 'deploy', token: tail('5555') }, { name: 'publish', token: tail('6666') }])
    const renamed = (n: number) => expect.objectContaining({
      field: `recs[${n}].name`, reason: 'renamed',
      message: `recs[${n}].token was sent back hidden, while the name of its entry changed. Type the full value of recs[${n}].token to keep it under the new name.`,
    })
    // The names swapped (gate r10 M14): refused, naming the token.
    expect(() => restoreMaskedSecrets({ recs: [{ name: 'publish', token: tail('5555') }, { name: 'deploy', token: tail('6666') }] }, { recs })).toThrow(renamed(0))
    // Renamed onto the name of the entry the same write drops.
    expect(() => restoreMaskedSecrets({ recs: [{ name: 'publish', token: tail('5555') }] }, { recs })).toThrow(renamed(0))
    // Renamed to a name nothing is stored under (it used to answer missing at the name).
    expect(() => restoreMaskedSecrets({ recs: [read[0]!, { name: 'release', token: tail('6666') }] }, { recs })).toThrow(renamed(1))
    // As read, with one added and one typed in full under a new name: each keeps its own.
    const added = { name: 'mirror', token: 'tok-mirror-typed' }
    expect(restoreMaskedSecrets({ recs: [...read, added] }, { recs })).toEqual({ recs: [...recs, added] })
    expect(restoreMaskedSecrets({ recs: [{ name: 'release', token: 'tok-release-typed' }, read[1]] }, { recs }))
      .toEqual({ recs: [{ name: 'release', token: 'tok-release-typed' }, recs[1]] })
  })

  it('a string that still holds a run of bullets after the pairing is refused as edited_mask wherever it stands, and nothing with a mask in it is written', () => {
    const api_keys = ['sk-one-1111', 'sk-two-2222', 'sk-three-3333']
    const read = maskSecretShapes({ api_keys }).api_keys as string[]
    expect(read).toEqual([tail('1111'), tail('2222'), tail('3333')])
    const edited = (field: string) => expect.objectContaining({ name: 'MaskedValueError', code: 'masked_value_unmatched', field, reason: 'edited_mask' })
    // The gate r10 sequences, as the server receives them (the settings form trims and refuses these
    // first; a JSON caller does not): a key typed after a hidden line, comma-separated text over the list,
    // a stray space at either end of a line, a trailing comma, a space and a key.
    for (const [label, sent, at] of [
      ['P5d: a key typed after the last hidden line', [read[0], read[1], `${read[2]}, sk-new-7777`], 2],
      ['P5c: comma-separated text over the list', [`${read[1]}, ${read[0]}, sk-fox-6666`], 0],
      ['P5e: a space after the first line', [`${read[0]} `, read[1], read[2]], 0],
      ['P5f: a space before the second line', [read[0], ` ${read[1]}`, read[2]], 1],
      ['P5g: a comma after the first line', [`${read[0]},`, read[1], read[2]], 0],
      ['P5h: a space and a key after the last line', [read[0], read[1], `${read[2]} sk-hotel-8888`], 2],
      ['text before a hidden line', [`x${read[0]}`, read[1], read[2]], 0],
      ['six bullets and a key', [read[0], read[1], `${B.repeat(6)}sk-new-7777`], 2],
    ] as Array<[string, string[], number]>) {
      expect(() => restoreMaskedSecrets({ api_keys: sent }, { api_keys }, 'plugins.acme'), label).toThrow(edited(`plugins.acme.api_keys[${at}]`))
    }
    // The same edits made right save: the hidden lines kept as shown, the new key on its own line.
    expect(restoreMaskedSecrets({ api_keys: [...read, 'sk-new-7777'] }, { api_keys })).toEqual({ api_keys: [...api_keys, 'sk-new-7777'] })
    // At a key: a tunnel token with a space after it (gate r10 T6/H6), a mask with text, six bullets with text.
    const options = { token: 'tok-form-9999', endpoint: 'https://acme:tunnel-pw@t1.acme.invalid/' }
    expect(() => restoreMaskedSecrets({ token: `${tail('9999')} `, endpoint: options.endpoint }, options, 'expose.options')).toThrow(edited('expose.options.token'))
    expect(() => restoreMaskedSecrets({ token: `${B.repeat(6)}tok-x` }, options, 'expose.options')).toThrow(edited('expose.options.token'))
    // A URL: a password edited next to its bullets, or bullets anywhere but the password.
    const url = 'https://acme:tunnel-pw@t1.acme.invalid/'
    expect(() => restoreMaskedSecrets({ endpoint: `https://acme:${B.repeat(8)}x@t1.acme.invalid/` }, { endpoint: url })).toThrow(edited('endpoint'))
    expect(() => restoreMaskedSecrets({ endpoint: `${maskUrlPasswords(url)} ${B.repeat(4)}` }, { endpoint: url })).toThrow(edited('endpoint'))
    expect(restoreMaskedSecrets({ endpoint: maskUrlPasswords(url) }, { endpoint: url })).toEqual({ endpoint: url })
    // A string that is not a secret: bullets typed into it are refused; stored that way and sent back
    // unchanged, it is not an edit (at a key, and in a list).
    expect(() => restoreMaskedSecrets({ note: `a ${B.repeat(4)} b` }, { note: 'a b' })).toThrow(edited('note'))
    expect(restoreMaskedSecrets({ note: `a ${B.repeat(4)} b` }, { note: `a ${B.repeat(4)} b` })).toEqual({ note: `a ${B.repeat(4)} b` })
    expect(restoreMaskedSecrets({ notes: ['new', `a ${B.repeat(4)} b`] }, { notes: [`a ${B.repeat(4)} b`] })).toEqual({ notes: ['new', `a ${B.repeat(4)} b`] })
    // A record in a changed list with no mask left in it, but an edited one: refused at the string.
    const env = [{ name: 'GITHUB_TOKEN', value: 'v-gh-5555' }, { name: 'REGION', value: 'us-west-2' }]
    expect(() => restoreMaskedSecrets({ env: [{ name: 'GITHUB_TOKEN', value: `${tail('5555')}, v-new` }, env[1]] }, { env })).toThrow(edited('env[0].value'))
    expect(() => restoreMaskedSecrets({ env: [env[1], { name: 'NOTE', value: `${B.repeat(8)} v-new` }] }, { env })).toThrow(edited('env[1].value'))
    // A stored record with bullets in it, sent back unchanged in a changed list: not an edit.
    const odd = [{ name: 'NOTE', value: `a ${B.repeat(4)} b` }]
    expect(restoreMaskedSecrets({ odd: [{ name: 'NEW', value: 'x' }, odd[0]] }, { odd })).toEqual({ odd: [{ name: 'NEW', value: 'x' }, odd[0]] })
    // The rule itself: a mask is not an edited one; a mask with anything around it is.
    expect(holdsEditedMask(tail('3333'))).toBe(false)
    expect(holdsEditedMask(BLIND_LIST_MASK)).toBe(false)
    expect(holdsEditedMask(PLUGIN_FORM_MASK)).toBe(false)
    expect(holdsEditedMask(maskUrlPasswords(url))).toBe(false)
    expect(holdsEditedMask('sk-plain-1111')).toBe(false)
    expect(holdsEditedMask(`${B.repeat(3)}x`)).toBe(false)
    expect(holdsEditedMask(`${tail('3333')} `)).toBe(true)
    expect(holdsEditedMask(`${tail('3333')}, sk-new`)).toBe(true)
    expect(holdsEditedMask(`x${B.repeat(4)}`)).toBe(true)
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
    'engines.env': (s) => ({ engines: { custom: { env: { ANTHROPIC_API_KEY: s } } } }),
    build_env: (s) => ({ hosts: { acme: { hostname: 'acme.invalid', server: { build_env: { NPM_TOKEN: s } } } } }),
    'hosts.options': (s) => ({ hosts: { acme: { hostname: 'acme.invalid', server: { expose: { options: { token: s } } } } } }),
    'expose.options': (s) => ({ expose: { options: { token: s } } }),
    action: (s) => ({ hooks: { defs: [{ id: 'acme', on: ['onTurnComplete'], action: { type: 'notify', token: s } }] } }),
  }
  /** Maps whose values are typed (each field judged by name and, on a replica, by shape) or hold no secret. */
  const NOT_FREE_FORM: Record<string, string> = {
    providers: 'keyed by provider name; each value is a typed ProviderConfig',
    engines: 'keyed by engine id; each value is a typed EngineConfigEntry',
    hosts: 'keyed by host name; each value is a typed host record',
    session_limits: 'numbers',
    plugin_ai: 'keyed by plugin id; each value is an on/off switch and a monthly budget',
    plugin_jobs: 'keyed by plugin id; each value names the machine its jobs run on',
    excluded_cwds: 'directory paths per host',
    overrides: 'hooks.overrides: enabled, priority, timeoutMs',
    tag_display: 'shown | value | hidden',
    tag_links: 'tag name to a link template',
    link_tags: 'tag key to a link pattern (a regex over URLs)',
    proxy_log_dirs: 'usage.proxy_log_dirs: a log directory path per host',
    prices: 'usage.prices: per-model rates in USD per million tokens',
    hints: 'session.hints: keyed by hint kind; each value is typed MessageHintSettings (switch, triggers, placement, audience, text a person writes to the model)',
    stt_corrections: 'a term the user says to the forms speech mishears it as (src/core/stt/corrections.ts)',
  }

  it('each map the types declare is masked or explained', () => {
    const body = (file: string, start: RegExp) => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf-8')
      const from = text.search(start)
      expect(from, file).toBeGreaterThanOrEqual(0)
      return text.slice(from, text.indexOf('\n}', from))
    }
    const owners = (text: string) => [...text.matchAll(/^\s*(?:'([^']+)'|(\w+))\??:\s*(?:Record<string,|\{[^\n]*\[key: string\])/gm)].map((m) => m[1] ?? m[2])
    const found = [
      ...owners(body('src/core/types.ts', /^export interface Config \{/m)),
      ...owners(body('src/model/providers/types.ts', /^export interface ProviderConfig \{/m)),
      ...owners(body('src/core/types.ts', /^export interface EngineConfigEntry \{/m)),
    ]
    // `options` appears twice: under a host server's expose and under this server's expose.
    expect(found.filter((k) => k === 'options')).toHaveLength(2)
    const accounted = new Set([...Object.keys(MASKED).map((k) => k.replace(/^.*\./, '')), ...Object.keys(NOT_FREE_FORM)])
    // A new map fails here: mask it in maskFreeFormMaps and add it to MASKED, or say in
    // NOT_FREE_FORM why it holds no secret.
    expect(found.filter((k) => !accounted.has(k))).toEqual([])
    expect([...new Set(found)].sort()).toEqual([...accounted].sort())
  })

  it('every section of the config the code reads without its type is declared in Config, so the check above sees its maps', () => {
    // `(config as { engines?: ... })` and `getConfig() as { push?: ... }`: a read that steps around the
    // type. engines.<id>.env was such a section, and the check above could not see it (gate L2).
    const config = fs.readFileSync(path.join(ROOT, 'src/core/types.ts'), 'utf-8')
    const from = config.search(/^export interface Config \{/m)
    const declared = new Set([...config.slice(from, config.indexOf('\n}', from)).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]))
    const files = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [])
    const reads: string[] = []
    for (const file of files('src')) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf-8')
      if (!/getConfig\b|config-manager/.test(text)) continue
      for (const m of text.matchAll(/(?:\(\s*config|getConfig\(\)\)?)\s+as\s+\{\s*(\w+)\??:/g)) reads.push(`${m[1]} (${file})`)
    }
    expect(reads.some((r) => r.startsWith('engines '))).toBe(true)
    expect(reads.filter((r) => !declared.has(r.split(' ')[0]!))).toEqual([])
  })

  it('the Mac view masks a secret placed in each masked map', () => {
    for (const [name, place] of Object.entries(MASKED)) {
      const secret = `acme-${name.replace(/\W/g, '')}-secret-zz`
      expect(JSON.stringify(maskForMacClients(place(secret))), name).not.toContain(secret)
    }
  })
})
