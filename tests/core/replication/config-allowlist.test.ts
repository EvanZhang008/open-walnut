/**
 * The config copy's allowlist (docs/plan/walnut-replica-servers-impl.md, WP5,
 * src/core/replication/config-allowlist.ts): every key of the Config interface is
 * either allowlisted or dropped (a ratchet on src/core/types.ts), a key in neither
 * list is not copied, a secret-shaped value in an allowlisted key refuses that row,
 * and a masked string is never a row. Real functions, no mocks.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  CONFIG_COPY_ALLOWLIST, CONFIG_COPY_DROPPED, CONFIG_COPY_DROPPED_FIELDS, allowThrough, configCopyRows, configRowAdmissible, findSecrets,
  secretKeyName, secretShapedValue, type AllowSpec,
} from '../../../src/core/replication/config-allowlist.js'
import { maskSecretTail, PLUGIN_FORM_MASK } from '../../../src/core/config-secret-shape.js'
import { fullConfigFixture, PLANTED_SECRETS } from '../../helpers/full-config-fixture.js'
import { configTypeTree, type TypeNode } from '../../helpers/config-type-fields.js'

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** What is wrong with `spec` against the type at `at`: a field in neither list, a whole copy of a record, a stale name. */
function specProblems(node: TypeNode, spec: AllowSpec, at: string, out: string[], seen: Set<string>): void {
  if (spec === true) {
    const grows = (n: TypeNode | undefined): boolean => !!n && (!!n.fields || !!n.unresolved || grows(n.each) || grows(n.elem))
    if (grows(node)) out.push(`${at}: copied whole, but a field added to it later would be copied too`)
    return
  }
  if (own(spec, '*')) {
    if (!node.each) out.push(`${at}: '*' on a value that is not a map`)
    else specProblems(node.each, spec['*']!, `${at}.*`, out, seen)
    return
  }
  if (own(spec, '[]')) {
    if (!node.elem) out.push(`${at}: '[]' on a value that is not a list`)
    else specProblems(node.elem, spec['[]']!, `${at}.[]`, out, seen)
    return
  }
  if (!node.fields) { out.push(`${at}: a record spec on a value with no fields`); return }
  seen.add(at)
  const dropped = CONFIG_COPY_DROPPED_FIELDS[at] ?? {}
  for (const f of Object.keys(node.fields)) {
    const copied = own(spec, f), gone = own(dropped, f)
    if (copied && gone) out.push(`${at}.${f}: both copied and dropped`)
    else if (!copied && !gone) out.push(`${at}.${f}: in neither the section's spec nor CONFIG_COPY_DROPPED_FIELDS`)
    else if (copied) specProblems(node.fields[f]!, spec[f]!, `${at}.${f}`, out, seen)
  }
  for (const f of Object.keys(spec)) if (!own(node.fields, f)) out.push(`${at}.${f}: named in the spec, not a field of the type`)
  for (const f of Object.keys(dropped)) if (!own(node.fields, f)) out.push(`${at}.${f}: dropped, not a field of the type`)
}

function allProblems(tree: Record<string, TypeNode>): { problems: string[]; seen: Set<string> } {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [k, spec] of Object.entries(CONFIG_COPY_ALLOWLIST)) {
    if (!tree[k]) continue // the top-level ratchet names it
    specProblems(tree[k]!, spec, k, problems, seen)
  }
  return { problems, seen }
}

/** The top-level keys of `export interface Config {` (two-space indent), read from the source. */
function configInterfaceKeys(): string[] {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/core/types.ts'), 'utf8')
  const start = src.indexOf('export interface Config {')
  expect(start).toBeGreaterThan(0)
  const keys: string[] = []
  for (const line of src.slice(start).split('\n').slice(1)) {
    if (line.startsWith('}')) break
    const m = /^ {2}([a-z_][a-z0-9_]*)\??:/.exec(line)
    if (m) keys.push(m[1]!)
  }
  return keys.sort()
}

describe('the ratchet: every config key is allowlisted or dropped', () => {
  it('each key of the Config interface is in exactly one list, and each list names only real keys', () => {
    const keys = configInterfaceKeys()
    expect(keys.length).toBeGreaterThan(40)
    const allowed = Object.keys(CONFIG_COPY_ALLOWLIST)
    const dropped = Object.keys(CONFIG_COPY_DROPPED)
    // A new key in neither list fails here: decide whether a replica may hold it.
    expect(keys.filter((k) => !allowed.includes(k) && !dropped.includes(k))).toEqual([])
    expect(allowed.filter((k) => dropped.includes(k))).toEqual([])
    expect([...allowed, ...dropped].filter((k) => !keys.includes(k))).toEqual([])
    for (const why of Object.values(CONFIG_COPY_DROPPED)) expect(why.length).toBeGreaterThan(5)
  })

  it('a key in neither list is not copied (it defaults to dropped) and is named as unknown', () => {
    const r = configCopyRows({ version: 1, brand_new_section: { mode: 'fast' }, ui: { theme: 'dark' } })
    expect(r.rows.map((x) => x.key)).toEqual(['ui', 'version'])
    expect(r.unknown).toEqual(['brand_new_section'])
  })

  it('a sub-key an allowed section does not name is dropped too', () => {
    expect(allowThrough({ name: 'Marina', email: 'marina@example.com' }, CONFIG_COPY_ALLOWLIST.user!)).toEqual({ name: 'Marina' })
    expect(allowThrough({ devbox: { label: 'Dev box', server: { build_env: { A: 'b' } } } }, CONFIG_COPY_ALLOWLIST.hosts!)).toEqual({ devbox: { label: 'Dev box' } })
    expect(allowThrough('not a record', CONFIG_COPY_ALLOWLIST.user!)).toBeUndefined()
  })
})

describe('the ratchet goes into every copied section', () => {
  it('each field of an allowlisted section is named in its spec or dropped with why, and nothing is copied whole that can grow', () => {
    const tree = configTypeTree()
    expect(Object.keys(tree).sort()).toEqual(configInterfaceKeys())
    expect(Object.keys(tree.session!.fields ?? {})).toContain('turn_retry')
    const { problems, seen } = allProblems(tree)
    expect(problems).toEqual([])
    // Every dropped list names a section the walk reached (no stale path).
    expect(Object.keys(CONFIG_COPY_DROPPED_FIELDS).filter((p) => !seen.has(p))).toEqual([])
    for (const fields of Object.values(CONFIG_COPY_DROPPED_FIELDS)) for (const why of Object.values(fields)) expect(why.length).toBeGreaterThan(5)
  })

  it('a field added to a copied section fails the walk until someone names it', () => {
    const tree = configTypeTree()
    const grown = { ...tree, session: { fields: { ...tree.session!.fields, relay_pin: {} } }, time: { fields: { ...tree.time!.fields, feeds: { fields: { private_url: {} } } } } }
    expect(allProblems(grown).problems.sort()).toEqual([
      "session.relay_pin: in neither the section's spec nor CONFIG_COPY_DROPPED_FIELDS",
      "time.feeds: in neither the section's spec nor CONFIG_COPY_DROPPED_FIELDS",
    ])
  })

  it('a sub-key the section does not name is not copied (it defaults to dropped)', () => {
    const feed = 'https://calendar.example.com/private-9f8e7d6c5b4a39281706/basic.ics'
    const r = configCopyRows({ version: 1, time: { private_feed_url: feed, work_hours: { start: '09:00', secret_room: '4411' } }, session: { relay_pin: '483920', max_idle: 3 } })
    expect(r.refused).toEqual([])
    const byKey = Object.fromEntries(r.rows.map((x) => [x.key, x.value])) as Record<string, unknown>
    expect(byKey.time).toEqual({ work_hours: { start: '09:00' } })
    expect(byKey.session).toEqual({ max_idle: 3 })
    expect(JSON.stringify(r.rows)).not.toContain('9f8e7d6c')
    expect(JSON.stringify(r.rows)).not.toContain('483920')
  })

  it('a list of records keeps only the named fields of each, and its scalars', () => {
    const v = allowThrough({ available_models: ['acme-small', { id: 'm1', provider: 'p1', label: 'M1', compat: { header: 'x' }, cost: { input: 1, output: 2 } }] }, CONFIG_COPY_ALLOWLIST.agent!)
    expect(v).toEqual({ available_models: ['acme-small', { id: 'm1', provider: 'p1', label: 'M1' }] })
    expect(allowThrough({ separators: 'not a list' }, CONFIG_COPY_ALLOWLIST.ordering!)).toEqual({})
  })
})

describe('the full fixture config', () => {
  it('covers every key of the Config interface', () => {
    expect(Object.keys(fullConfigFixture()).sort()).toEqual(configInterfaceKeys())
  })

  it('every key is copied or dropped, and none of the planted secrets is in what is copied', () => {
    const fixture = fullConfigFixture()
    const r = configCopyRows(fixture)
    expect(r.unknown).toEqual([])
    expect(r.refused).toEqual([])
    const copied = r.rows.map((x) => x.key)
    for (const k of Object.keys(fixture)) expect([k, copied.includes(k) || k in CONFIG_COPY_DROPPED]).toEqual([k, true])
    expect(copied.sort()).toEqual(Object.keys(CONFIG_COPY_ALLOWLIST).sort())
    const text = JSON.stringify(r.rows)
    for (const s of PLANTED_SECRETS) expect([s, text.includes(s)]).toEqual([s, false])
    // What the views need is there.
    const byKey = Object.fromEntries(r.rows.map((x) => [x.key, x.value])) as Record<string, any>
    expect(byKey.provider).toEqual({ type: 'bedrock', model: 'acme-model-large', bedrock_region: 'us-west-2' })
    expect(byKey.hosts.devbox).toEqual({ hostname: 'devbox.example.com', user: 'marina', port: 22, label: 'Dev box', enabled: true })
    expect(byKey.stt).toEqual({ engine: 'openai', language: 'en' })
    expect(byKey.agent.agents).toBeUndefined()
    for (const r2 of r.rows) expect(configRowAdmissible(r2)).toBe(true)
  })
})

describe('a secret-shaped value in an allowlisted key refuses the row', () => {
  const planted: Array<[string, Record<string, unknown>, string]> = [
    ['ui', { session_panels: 'Bearer acmeUiPlanted0123456789XYZ' }, 'secret_value'],
    ['session', { cron_policy: 'sk-acmeSessionPlanted0123456789abcdefgh' }, 'secret_value'],
    // A record where the type says a scalar (a hand-edited yaml): a field named like a secret in it.
    ['tag_links', { 'ticket:*': { password: 'hunter2-planted' } }, 'secret_key'],
    ['session_limits', { devbox: { api_key: 'whatever-it-holds' } }, 'secret_key'],
    ['time', { work_hours: { start: 'sk-acmeTimePlanted0123456789abcdefgh' } }, 'secret_value'],
    ['tag_links', { 'ticket:*': 'https://marina:hunter2pass@tickets.example.com/{value}' }, 'secret_value'],
    ['ordering', { projects: ['Acme', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'] }, 'secret_value'],
    ['ui', { session_panels: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXJpbmEifQ.c2lnbmF0dXJlLXBsYW50ZWQ' }, 'secret_value'],
    ['audio', { exclude_apps: ['Q2xpZW50U2VjcmV0UGxhbnRlZDAxMjM0NTY3ODlBYmNkZWZn'] }, 'secret_value'],
    ['user', { name: maskSecretTail('a-real-secret-value') }, 'masked'],
    ['ui', { session_panels: PLUGIN_FORM_MASK }, 'masked'],
    ['ui', { session_panels: `${maskSecretTail('another-secret')}, plus` }, 'masked'],
  ]
  for (const [key, value, reason] of planted) {
    it(`${key}: ${reason}`, () => {
      const r = configCopyRows({ version: 1, [key]: value })
      expect(r.rows.map((x) => x.key)).toEqual(['version'])
      expect(r.refused.map((x) => x.key)).toEqual([key])
      expect(r.refused[0]!.findings.map((f) => f.reason)).toContain(reason)
      // The refusal names paths, never a value.
      expect(JSON.stringify(r.refused)).not.toContain(JSON.stringify(value).slice(2, 20))
      // The host refuses the same row if it ever arrives.
      expect(configRowAdmissible({ key, value: allowThrough(value, CONFIG_COPY_ALLOWLIST[key]!) })).toBe(false)
    })
  }

  it('a field named like a secret that the section does not name is dropped, not refused', () => {
    const r = configCopyRows({ version: 1, session: { cron_policy: 'session-only', api_key: 'whatever-it-holds' } })
    expect(r.refused).toEqual([])
    expect(r.rows.find((x) => x.key === 'session')?.value).toEqual({ cron_policy: 'session-only' })
  })

  it('the host refuses a row with a key the allowlist does not name, or a value that is not through the spec', () => {
    expect(configRowAdmissible({ key: 'providers', value: { acme: { type: 'openai' } } })).toBe(false)
    expect(configRowAdmissible({ key: 'user', value: { name: 'Marina', email: 'marina@example.com' } })).toBe(false)
    expect(configRowAdmissible({ key: 'user', value: { name: 'Marina' } })).toBe(true)
  })
})

describe('ordinary values are not secrets', () => {
  it('model ids, paths, uuids, hashes, plain URLs, dates, words and \\u text pass', () => {
    for (const v of [
      'global.acme.model-large-20261001-v1:0', '/Users/marina/workplace/acme/src', '550e8400-e29b-41d4-a716-446655440000',
      'a3f5c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2', 'https://tickets.example.com/{value}', '2026-10-16T08:00:00.000Z',
      'session-only', 'America/Los_Angeles', 'Bearer of good news', '\u4f60\u597d marina', 'open-walnut-sidebar-width',
    ]) expect([v, secretShapedValue(v)]).toEqual([v, null])
  })

  it('no sub-key an allowed section names is itself judged a secret', () => {
    const names: string[] = []
    const walk = (spec: AllowSpec): void => {
      if (spec === true) return
      for (const [k, sub] of Object.entries(spec)) { if (k !== '*' && k !== '[]') names.push(k); walk(sub) }
    }
    for (const [k, spec] of Object.entries(CONFIG_COPY_ALLOWLIST)) { names.push(k); walk(spec) }
    expect(names.filter(secretKeyName)).toEqual([])
    expect(findSecrets({ maxTokens: 8192, main_model: 'acme' }, 'agent')).toEqual([])
  })

  it('a name-keyed map keeps an entry named like a secret; what is inside it is still judged', () => {
    expect(findSecrets({ 'secret-box': { label: 'Secret box' } }, 'hosts')).toEqual([])
    expect(findSecrets({ 'secret-box': { password: 'p' } }, 'hosts').map((f) => f.path)).toEqual(['hosts.secret-box.password'])
  })
})
