/**
 * What an AI may change in a plugin's settings (src/core/plugins/plugin-settings-plan.ts): values
 * checked against the plugin's own schema, an undeclared stored key kept in its shape, secrets left
 * to the person, the switch left alone, and all or nothing.
 */
import { describe, it, expect } from 'vitest'
import { describePluginFields, planPluginSettings, type PluginSchemaInput } from '../../../src/core/plugins/plugin-settings-plan.js'
import { PLUGIN_FORM_MASK } from '../../../src/core/config-secret-shape.js'

const SCHEMA: PluginSchemaInput = {
  configSchema: {
    type: 'object',
    required: ['base_url'],
    properties: {
      base_url: { type: 'string' },
      poll_minutes: { type: 'integer', minimum: 1, maximum: 60 },
      mode: { type: 'string', enum: ['fast', 'slow'] },
      channels: { type: 'array', items: { type: 'string' } },
      api_key: { type: 'string' },
      passphrase: { type: 'string', format: 'password' },
      auth: { type: 'object', properties: { email: { type: 'string' }, token: { type: 'string' } } },
      accounts: { type: 'object', additionalProperties: { type: 'object', properties: { host: { type: 'string' }, port: { type: 'integer' } } } },
    },
  },
  uiHints: { poll_minutes: { label: 'Poll interval', help: 'Minutes between polls' } },
}

const STORED = () => ({
  enabled: true,
  base_url: 'https://a.invalid',
  poll_minutes: 10,
  api_key: 'sk-stored-0001',
  auth: { email: 'me@example.invalid', token: 'tok-stored-0002' },
  // Undeclared, drawn by the plugin's own App (coderelay's endpoints).
  endpoints: [{ name: 'hub', host: 'box', port: 19402 }],
})

describe('planPluginSettings', () => {
  it('writes a valid declared value and reports from and to', () => {
    const plan = planPluginSettings('acme', SCHEMA, STORED(), { set: { poll_minutes: 5, mode: 'fast' } })
    expect(plan.refused).toEqual([])
    expect(plan.needsPerson).toEqual([])
    expect(plan.next).toMatchObject({ poll_minutes: 5, mode: 'fast', base_url: 'https://a.invalid', enabled: true })
    expect(plan.changes).toEqual([
      { key: 'poll_minutes', label: 'Poll interval', from: 10, to: 5 },
      { key: 'mode', label: 'mode', to: 'fast' },
    ])
  })

  it('refuses a value that breaks the schema, and then writes nothing at all', () => {
    for (const set of [{ poll_minutes: 2.5 }, { poll_minutes: 0 }, { poll_minutes: 61 }, { mode: 'medium' }, { channels: 'general' }, { channels: [1] }, { base_url: 3 }]) {
      const plan = planPluginSettings('acme', SCHEMA, STORED(), { set: { base_url: 'https://b.invalid', ...set } })
      expect(plan.next, JSON.stringify(set)).toBeNull()
      expect(plan.refused.length, JSON.stringify(set)).toBeGreaterThan(0)
    }
  })

  it('refuses a key the plugin has no setting for and names the ones it has', () => {
    const plan = planPluginSettings('acme', SCHEMA, STORED(), { set: { colour: 'red' } })
    expect(plan.next).toBeNull()
    expect(plan.refused[0].reason).toContain('no setting named colour')
    expect(plan.refused[0].reason).toContain('poll_minutes')
    expect(plan.refused[0].reason).toContain('endpoints')
  })

  it('takes an undeclared stored key in the same shape, and refuses another shape', () => {
    const added = [...STORED().endpoints, { name: 'spoke', host: 'box', port: 19403 }]
    const ok = planPluginSettings('acme', SCHEMA, STORED(), { set: { endpoints: added } })
    expect(ok.next?.endpoints).toEqual(added)
    const bad = planPluginSettings('acme', SCHEMA, STORED(), { set: { endpoints: { name: 'hub' } } })
    expect(bad.next).toBeNull()
    expect(bad.refused[0].reason).toContain('holds a array')
  })

  it('checks a key of a map against additionalProperties', () => {
    const ok = planPluginSettings('acme', SCHEMA, STORED(), { set: { accounts: { work: { host: 'imap.invalid', port: 993 } } } })
    expect(ok.next?.accounts).toEqual({ work: { host: 'imap.invalid', port: 993 } })
    const bad = planPluginSettings('acme', SCHEMA, STORED(), { set: { accounts: { work: { host: 'imap.invalid', port: '993' } } } })
    expect(bad.refused[0].reason).toContain('accounts.work.port: expected integer')
  })

  it('never sets a secret: a key that reads like one, a password format, or one inside an object', () => {
    for (const set of [{ api_key: 'sk-made-up' }, { passphrase: 'hunter2' }, { auth: { email: 'me@example.invalid', token: 'tok-new' } }]) {
      const plan = planPluginSettings('acme', SCHEMA, STORED(), { set })
      expect(plan.next, JSON.stringify(set)).toBeNull()
      expect(plan.needsPerson.length, JSON.stringify(set)).toBe(1)
    }
  })

  it('never adds a URL password inside an undeclared value', () => {
    const plan = planPluginSettings('acme', SCHEMA, STORED(), { set: { endpoints: [{ name: 'hub', host: 'box', port: 19402, url: 'https://u:pw-new@x.invalid/' }] } })
    expect(plan.next).toBeNull()
    expect(plan.needsPerson).toHaveLength(1)
  })

  it('keeps a secret sent back masked, so an object with one can still be edited', () => {
    const plan = planPluginSettings('acme', SCHEMA, STORED(), { set: { auth: { email: 'new@example.invalid', token: PLUGIN_FORM_MASK } } })
    expect(plan.needsPerson).toEqual([])
    expect(plan.next?.auth).toEqual({ email: 'new@example.invalid', token: 'tok-stored-0002' })
    // The answer shows the secret masked, never its value.
    expect(JSON.stringify(plan.changes)).not.toContain('tok-stored')
  })

  it('removes a setting so its default applies, but never a required one, a secret or the switch', () => {
    const ok = planPluginSettings('acme', SCHEMA, STORED(), { unset: ['poll_minutes'] })
    expect(ok.next).not.toHaveProperty('poll_minutes')
    expect(ok.changes).toEqual([{ key: 'poll_minutes', label: 'Poll interval', from: 10, removed: true }])
    expect(planPluginSettings('acme', SCHEMA, STORED(), { unset: ['base_url'] }).refused).toHaveLength(1)
    expect(planPluginSettings('acme', SCHEMA, STORED(), { unset: ['api_key'] }).needsPerson).toHaveLength(1)
    expect(planPluginSettings('acme', SCHEMA, STORED(), { unset: ['enabled'] }).refused).toHaveLength(1)
    expect(planPluginSettings('acme', SCHEMA, STORED(), { set: { enabled: false } }).refused).toHaveLength(1)
  })

  it('writes nothing when every value is already set that way', () => {
    const plan = planPluginSettings('acme', SCHEMA, STORED(), { set: { poll_minutes: 10 }, unset: ['mode'] })
    expect(plan.next).toBeNull()
    expect(plan.unchanged).toEqual(['poll_minutes', 'mode'])
  })

  it('takes nothing undeclared for a plugin that describes no settings and stores none', () => {
    const plan = planPluginSettings('bare', {}, {}, { set: { anything: 1 } })
    expect(plan.next).toBeNull()
    expect(plan.refused[0].reason).toContain('describes no settings')
  })
})

describe('secrets the review found (2026-11-16)', () => {
  const NESTED: PluginSchemaInput = {
    configSchema: {
      type: 'object',
      properties: {
        auth: { type: 'object' },
        servers: { type: 'array', items: { type: 'object' } },
        wifi: { type: 'string', format: 'password' },
        accounts: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, login: { type: 'string', format: 'password' } } } },
        step: { type: 'integer', multipleOf: 5 },
        note: { type: 'string' },
      },
    },
  }
  const STORE = () => ({
    auth: { type: 'basic', token: 'TOK-1' },
    servers: [{ name: 'a', token: 'T1' }, { name: 'b', token: 'T2' }],
    wifi: 'hunter2-wifi',
    accounts: [{ name: 'a', login: 'login-secret-1' }],
  })

  it('never removes a secret through set: an object or a list that drops one is left to the person', () => {
    for (const set of [{ auth: { type: 'pat' } }, { servers: [{ name: 'a', token: PLUGIN_FORM_MASK }] }]) {
      const plan = planPluginSettings('acme', NESTED, STORE(), { set })
      expect(plan.next, JSON.stringify(set)).toBeNull()
      expect(plan.needsPerson, JSON.stringify(set)).toHaveLength(1)
    }
  })

  it('still edits the rest of an object that keeps its secret', () => {
    const plan = planPluginSettings('acme', NESTED, STORE(), { set: { auth: { type: 'api', token: PLUGIN_FORM_MASK } } })
    expect(plan.needsPerson).toEqual([])
    expect(plan.next?.auth).toEqual({ type: 'api', token: 'TOK-1' })
  })

  it('masks a field marked format: password, at the top and nested, and never writes one nested', () => {
    const fields = Object.fromEntries(describePluginFields(NESTED, STORE()).map((f) => [f.key, f]))
    expect(fields.wifi.value).toBe(PLUGIN_FORM_MASK)
    expect(fields.accounts.value).toEqual([{ name: 'a', login: PLUGIN_FORM_MASK }])
    const plan = planPluginSettings('acme', NESTED, STORE(), { set: { accounts: [{ name: 'a', login: 'NEW-SECRET' }] } })
    expect(plan.next).toBeNull()
    expect(plan.needsPerson).toHaveLength(1)
    expect(JSON.stringify(plan)).not.toContain('login-secret-1')
    expect(JSON.stringify(plan)).not.toContain('NEW-SECRET')
    // An entry edited with its login sent back masked keeps it, and the answer masks it.
    const edit = planPluginSettings('acme', NESTED, { ...STORE(), accounts: [{ id: 'x', name: 'a', login: 'login-secret-1' }] }, { set: { accounts: [{ id: 'x', name: 'work', login: PLUGIN_FORM_MASK }] } })
    expect(edit.next?.accounts).toEqual([{ id: 'x', name: 'work', login: 'login-secret-1' }])
    expect(JSON.stringify(edit.changes)).not.toContain('login-secret-1')
    // A rename the mask cannot follow (no id) goes to the person, never a guess.
    const rename = planPluginSettings('acme', NESTED, STORE(), { set: { accounts: [{ name: 'work', login: PLUGIN_FORM_MASK }] } })
    expect(rename.next).toBeNull()
    expect(rename.needsPerson).toHaveLength(1)
  })

  it('refuses names every object already has', () => {
    const plan = planPluginSettings('acme', { configSchema: { type: 'object', additionalProperties: { type: 'string' } } }, {}, { set: { constructor: 'x', toString: 'y', hasOwnProperty: 'z' } })
    expect(plan.next).toBeNull()
    expect(plan.refused.map((r) => r.key)).toEqual(['constructor', 'toString', 'hasOwnProperty'])
  })

  it('refuses a mask sent for a plain field with nothing stored, instead of asking the person', () => {
    const plan = planPluginSettings('acme', NESTED, STORE(), { set: { note: PLUGIN_FORM_MASK } })
    expect(plan.needsPerson).toEqual([])
    expect(plan.refused).toHaveLength(1)
  })

  it('checks multipleOf', () => {
    expect(planPluginSettings('acme', NESTED, STORE(), { set: { step: 7 } }).refused[0].reason).toContain('multiple of 5')
    expect(planPluginSettings('acme', NESTED, STORE(), { set: { step: 10 } }).next?.step).toBe(10)
  })
})

describe('describePluginFields', () => {
  it('lists declared fields with labels and masked values, then undeclared stored keys, never the switch', () => {
    const fields = describePluginFields(SCHEMA, STORED())
    expect(fields.map((f) => f.key)).toEqual(['base_url', 'poll_minutes', 'mode', 'channels', 'api_key', 'passphrase', 'auth', 'accounts', 'endpoints'])
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]))
    expect(byKey.poll_minutes).toMatchObject({ label: 'Poll interval', help: 'Minutes between polls', type: 'integer', minimum: 1, maximum: 60, value: 10, set: true })
    expect(byKey.base_url.required).toBe(true)
    expect(byKey.api_key).toMatchObject({ secret: true, value: PLUGIN_FORM_MASK })
    expect(byKey.passphrase).toMatchObject({ secret: true, set: false })
    expect(byKey.mode.enum).toEqual(['fast', 'slow'])
    expect(byKey.endpoints).toMatchObject({ declared: false, type: 'array' })
    expect(JSON.stringify(fields)).not.toContain('sk-stored')
    expect(JSON.stringify(fields)).not.toContain('tok-stored')
  })
})
