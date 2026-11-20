/**
 * How a config write lands per top-level section (src/core/config-section-write.ts).
 * The 2026-11-14 incident: `PUT /api/config {"session":{"skill_listing_desc_chars":200}}`
 * replaced the whole `session` section and dropped every other session setting.
 *
 * The class guard reads the Config interface from source, so a NEW top-level key
 * fails here until it is listed by hand as merged, a replaced map, or not an object.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_SECTION_WRITE, configSectionWrite, writeConfigSection } from '../../src/core/config-section-write.js'

/** Top-level keys of `export interface Config` with the start of each one's type. */
function configKeysFromSource(): Map<string, string> {
  const src = fs.readFileSync(path.join(__dirname, '../../src/core/types.ts'), 'utf8')
  const start = src.indexOf('export interface Config {')
  expect(start).toBeGreaterThan(-1)
  const body = src.slice(start, src.indexOf('\n}\n', start))
  const keys = new Map<string, string>()
  for (const m of body.matchAll(/^ {2}([a-z_]+)\??:\s*(.*)$/gm)) keys.set(m[1], m[2])
  return keys
}

/**
 * Every top-level key, listed by hand in exactly one list. A new key of Config fails
 * here until someone decides which list it belongs to (and writes it into the table
 * in src/core/config-section-write.ts): nothing is inferred from its type.
 */
const MERGED = [
  'experimental', 'user', 'org', 'approvals', 'outbound', 'passwords', 'defaults', 'provider', 'usage', 'agent',
  'private_tasks', 'calendar', 'favorites', 'ordering', 'session_server', 'net', 'hosts_warmup',
  'hosts_found', 'first_run', 'health_monitor', 'external_session_import', 'session', 'triage', 'backup',
  'keep_awake', 'time', 'search', 'session_hooks', 'hooks', 'self_repair', 'updates', 'ui',
  'pull_requests', 'workspaces', 'audio', 'stt', 'jev', 'push', 'cloud_bridge', 'expose', 'cloud', 'sync',
]
/** Maps of named entries: an entry is removed by leaving it out. */
const REPLACED_MAPS = [
  'providers', 'engines', 'plugins', 'plugin_ai', 'plugin_jobs', 'hosts', 'session_limits',
  'placement_weights', 'tag_display', 'tag_links', 'link_tags', 'stt_corrections',
]
/** Not objects at all: stored as sent whatever the mode. */
const NOT_OBJECTS = [
  'version', 'plugin_sources', 'local_capabilities', 'ssh_login_files', 'ssh_login_hint', 'ssh_cert_letter',
  'api_keys', 'push_tokens',
]

describe('every top-level config section is classified', () => {
  const keys = configKeysFromSource()

  it('reads a plausible number of keys from the Config interface', () => {
    expect(keys.size).toBeGreaterThan(40)
    expect(keys.has('session')).toBe(true)
    expect(keys.has('hosts')).toBe(true)
  })

  it('each key of Config is in exactly one hand-written list', () => {
    const listed = [...MERGED, ...REPLACED_MAPS, ...NOT_OBJECTS]
    expect(new Set(listed).size, 'a key listed twice').toBe(listed.length)
    expect(listed.sort()).toEqual([...keys.keys()].sort())
  })

  it('the table says what the lists say', () => {
    for (const key of MERGED) expect({ key, mode: CONFIG_SECTION_WRITE[key as keyof typeof CONFIG_SECTION_WRITE] }).toEqual({ key, mode: 'merge' })
    for (const key of [...REPLACED_MAPS, ...NOT_OBJECTS]) expect({ key, mode: CONFIG_SECTION_WRITE[key as keyof typeof CONFIG_SECTION_WRITE] }).toEqual({ key, mode: 'replace' })
    expect(Object.keys(CONFIG_SECTION_WRITE).sort()).toEqual([...keys.keys()].sort())
  })

  it('a key listed as not an object is typed as an array or a scalar', () => {
    for (const key of NOT_OBJECTS) expect({ key, head: keys.get(key) }).toEqual({ key, head: expect.not.stringMatching(/^\{|^Record<|^import\(/) })
  })

  it('an unknown section merges', () => {
    expect(configSectionWrite('some_future_section')).toBe('merge')
  })
})

describe('writeConfigSection', () => {
  const stored = { reply_language: 'en', cron_policy: 'session-only', turn_retry: { max: 3, delay_s: 5 } }

  it('a partial section keeps the keys it leaves out', () => {
    expect(writeConfigSection('session', stored, { skill_listing_desc_chars: 200 }))
      .toEqual({ ...stored, skill_listing_desc_chars: 200 })
  })

  it('null (or undefined, in process) removes one key', () => {
    expect(writeConfigSection('session', stored, { reply_language: null, cron_policy: undefined }))
      .toEqual({ turn_retry: { max: 3, delay_s: 5 } })
  })

  it('an object one level down is replaced whole', () => {
    expect(writeConfigSection('session', stored, { turn_retry: { max: 1 } }))
      .toEqual({ reply_language: 'en', cron_policy: 'session-only', turn_retry: { max: 1 } })
  })

  it('a map section is the map sent, its null entries left out', () => {
    expect(writeConfigSection('hosts', { a: { hostname: 'a' }, b: { hostname: 'b' } }, { a: { hostname: 'a' }, c: null }))
      .toEqual({ a: { hostname: 'a' } })
  })

  it('arrays, scalars and a top-level null are stored as sent', () => {
    expect(writeConfigSection('api_keys', [{ id: 'x' }], [])).toEqual([])
    expect(writeConfigSection('session', stored, null)).toBeNull()
    expect(writeConfigSection('ssh_login_hint', 'a', 'b')).toBe('b')
    // An object sent over a stored non-object: nothing to merge into.
    expect(writeConfigSection('session', 'broken', { a: 1 })).toEqual({ a: 1 })
  })

  it('a `__proto__` key stays an own key and never touches the prototype', () => {
    const sent = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as Record<string, unknown>
    const out = writeConfigSection('session', {}, sent) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    expect(out.ok).toBe(1)
  })
})

describe('writeConfigSection for an older web client (wholeSections)', () => {
  it('the section sent is the new section, exactly as before the merge', () => {
    const stored = { reply_language: 'en', cron_policy: 'session-only' }
    expect(writeConfigSection('session', stored, { reply_language: 'de' }, { wholeSections: true })).toEqual({ reply_language: 'de' })
    expect(writeConfigSection('session', stored, { reply_language: null }, { wholeSections: true })).toEqual({ reply_language: null })
  })
})

/**
 * A writer that does not hold the whole map (an agent's script, the CLI): `mergeEntries`.
 * 2026-11-18: `{ plugins: { wechat: { send_host, send_enabled } } }` from a script replaced the
 * whole plugins map and dropped both mail accounts, Slack and the calendar settings.
 * Enumerated from the table, so a NEW map section is covered the moment it is listed.
 */
describe('writeConfigSection for a writer that does not hold whole maps (mergeEntries)', () => {
  const maps = Object.entries(CONFIG_SECTION_WRITE).filter(([, m]) => m === 'replace').map(([k]) => k)
    .filter((k) => !NOT_OBJECTS.includes(k))

  it('covers every map section', () => {
    expect(maps.sort()).toEqual([...REPLACED_MAPS].sort())
  })

  it('every map section keeps the entries it leaves out, and the keys an entry leaves out', () => {
    for (const key of maps) {
      const stored = { a: { x: 1, y: { deep: 1 } }, b: { x: 2 }, c: 'scalar' }
      const out = writeConfigSection(key, stored, { a: { z: 3, y: { other: 1 } }, d: { x: 4 } }, { mergeEntries: true })
      expect({ key, out }).toEqual({ key, out: { a: { x: 1, z: 3, y: { other: 1 } }, b: { x: 2 }, c: 'scalar', d: { x: 4 } } })
    }
  })

  it('null removes a key of an entry, or a whole entry, and nothing else', () => {
    const stored = { wechat: { enabled: true, send_host: 'h' }, slack: { enabled: true }, mail: { enabled: true } }
    expect(writeConfigSection('plugins', stored, { wechat: { send_host: null }, slack: null }, { mergeEntries: true }))
      .toEqual({ wechat: { enabled: true }, mail: { enabled: true } })
  })

  it('an entry that is not an object, sent or stored, is replaced as sent', () => {
    expect(writeConfigSection('stt_corrections', { x: ['a'], y: ['b'] }, { x: ['c'] }, { mergeEntries: true })).toEqual({ x: ['c'], y: ['b'] })
    expect(writeConfigSection('plugins', { x: 'broken' }, { x: { enabled: true } }, { mergeEntries: true })).toEqual({ x: { enabled: true } })
  })

  it('without it (a page editor, an in-process read-modify-write) a map is still the map sent', () => {
    expect(writeConfigSection('plugins', { a: { x: 1 }, b: { x: 2 } }, { a: { x: 1 } })).toEqual({ a: { x: 1 } })
    expect(writeConfigSection('plugins', { a: { x: 1 } }, { a: { y: 1 } }, { wholeSections: true, mergeEntries: true })).toEqual({ a: { y: 1 } })
  })

  it('a merge section and a non-object section are unchanged by it', () => {
    expect(writeConfigSection('session', { a: 1, b: { c: 1 } }, { b: { d: 1 } }, { mergeEntries: true })).toEqual({ a: 1, b: { d: 1 } })
    expect(writeConfigSection('api_keys', [{ id: 'x' }], [], { mergeEntries: true })).toEqual([])
  })

  it('a `__proto__` entry stays an own key', () => {
    const sent = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>
    const out = writeConfigSection('plugins', { a: { x: 1 } }, sent, { mergeEntries: true }) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
  })
})
