/**
 * Every key the extension keeps in storage.session is classified in
 * packages/browser-extension/src/session-keys.ts: kept across an extension reload (agent-keep.ts
 * mirrors it into storage.local and puts it back, checked), or lost on purpose with its reason.
 * 2026-11-10: a self-update reload cleared the agent window and every holding while Chrome kept
 * the windows and tabs, so the next open made a second agent window and a task's own tab read as
 * the person's. A new storage.session key fails here until it is listed there.
 *
 * Keys are read from the source: tabStore('k'), and the keys of every storage.session get, set and
 * remove (literals, arrays, `[CONST]` named in the same file, and object literals' top-level keys,
 * spreads included). A call whose keys cannot be read (a variable) must be one of GENERIC below.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SESSION_KEYS } from '../../../packages/browser-extension/src/session-keys'

const DIR = path.join(process.cwd(), 'packages/browser-extension/src')
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'))

/** Calls whose keys come from elsewhere (each call by its text), and where the guard reads them instead. */
const GENERIC: Record<string, string> = {
  'tab-store.ts: get(key)': 'its key is the tabStore(\'k\') argument, read at each caller',
  'tab-store.ts: set({ [key]: a })': 'the same',
  'background.ts: get(key)': 'takeOnce: its key is the type of its parameter, read below',
  'background.ts: remove(key)': 'the same',
  'agent-keep.ts: get([...KEPT_KEYS])': 'KEPT_KEYS: session-keys.ts itself',
  'agent-keep.ts: get(Object.keys(back))': 'the kept keys it restores, out of KEPT_KEYS',
  'agent-keep.ts: set(write)': 'the same',
  'agent-keep.ts: remove?.(same)': 'the same',
}
/** Uses of storage.session that are not a get, set or remove, each by its text. */
const ALIASES: Record<string, string> = {
  'agent-groups-person.ts: api.storage.session': 'placeStore: storage.local, storage.session only in a browser without storage.local',
  'background.ts: ext.storage.session.setAccessLevel': 'setAccessLevel, no key',
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1')

/** The text from `open` (an opening bracket at i) to its match. */
function balanced(s: string, i: number): string {
  const open = s[i]
  const close = open === '(' ? ')' : open === '{' ? '}' : ']'
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === open) depth++
    else if (s[j] === close && --depth === 0) return s.slice(i + 1, j)
  }
  return s.slice(i + 1)
}

/** Top-level keys of an object literal body; spreads give their object literals' keys. */
function objectKeys(body: string, consts: Map<string, string>): { keys: string[]; unread: boolean } {
  const keys: string[] = []
  let unread = false
  let depth = 0
  let start = 0
  const parts: string[] = []
  for (let j = 0; j <= body.length; j++) {
    const c = body[j]
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    else if ((c === ',' && depth === 0) || j === body.length) { parts.push(body.slice(start, j).trim()); start = j + 1 }
  }
  for (const p of parts.filter(Boolean)) {
    if (p.startsWith('...')) {
      const lits = [...p.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).filter((x) => x.trim())
      // A spread of a variable (`...x`) names keys the guard cannot read.
      if (!lits.length) unread = true
      for (const l of lits) { const r = objectKeys(l, consts); keys.push(...r.keys); unread ||= r.unread }
      continue
    }
    const m = /^(?:\[(\w+)\]|['"]?(\w+)['"]?)\s*:/.exec(p) ?? /^(\w+)$/.exec(p)
    if (!m) { unread = true; continue }
    if (m[1]) { const v = consts.get(m[1]); if (v) keys.push(v); else unread = true } else keys.push(m[2] ?? m[1])
  }
  return { keys, unread }
}

/** The keys one get/remove argument names, or null when it is not literal. */
function argKeys(arg: string, consts: Map<string, string>): string[] | null {
  const a = arg.trim()
  const lit = /^['"](\w+)['"]$/.exec(a)
  if (lit) return [lit[1]]
  if (/^\w+$/.test(a)) return consts.has(a) ? [consts.get(a)!] : null
  if (a.startsWith('[')) {
    const out: string[] = []
    for (const x of balanced(a, 0).split(',').map((y) => y.trim()).filter(Boolean)) {
      const k = argKeys(x, consts)
      if (!k) return null
      out.push(...k)
    }
    return out
  }
  return null
}

function scan(): { found: Map<string, string[]>; unread: string[]; aliases: string[]; seen: Set<string> } {
  const found = new Map<string, string[]>()
  const unread: string[] = []
  const aliases: string[] = []
  /** The GENERIC and ALIASES entries met, so a stale one fails. */
  const seen = new Set<string>()
  const add = (k: string, f: string) => found.set(k, [...(found.get(k) ?? []), f])
  for (const f of files) {
    const src = strip(fs.readFileSync(path.join(DIR, f), 'utf8'))
    const consts = new Map([...src.matchAll(/\bconst (\w+)\s*=\s*['"](\w+)['"]/g)].map((m) => [m[1], m[2]] as [string, string]))
    for (const m of src.matchAll(/\btabStore\s*(?:<[^(]*?>)?\(\s*([^,)]+)/g)) {
      const k = argKeys(m[1], consts)
      if (k) k.forEach((x) => add(x, f))
      else if (f !== 'tab-store.ts') unread.push(`${f}: tabStore(${m[1].trim()})`)
    }
    // A destructured or passed-on storage.session (`const { session } = ext.storage`) is not read here.
    if (/\{\s*[^}]*\bsession\b[^}]*\}\s*=\s*\w+\.storage\b/.test(src)) aliases.push(`${f}: destructured storage.session`)
    for (const m of src.matchAll(/\b(\w+)\.storage\.session\b(\??\.(\w+))?/g)) {
      const op = m[3]
      const head = `${m[1]}.storage.session${op && !['get', 'set', 'remove'].includes(op) ? `.${op}` : ''}`
      if (!op || !['get', 'set', 'remove'].includes(op)) { if (ALIASES[`${f}: ${head}`]) seen.add(`${f}: ${head}`); else aliases.push(`${f}: ${head}`); continue }
      const at = src.indexOf('(', m.index! + m[0].length)
      const arg = balanced(src, at).trim()
      const call = `${f}: ${src.slice(m.index! + m[0].length - op.length, at).replace(/^\./, '')}(${arg})`
      if (op === 'set' && arg.startsWith('{')) {
        const r = objectKeys(balanced(arg, 0), consts)
        r.keys.forEach((k) => add(k, f))
        if (r.unread) { if (GENERIC[call]) seen.add(call); else unread.push(call) }
        continue
      }
      const k = argKeys(arg, consts)
      if (k) k.forEach((x) => add(x, f))
      else if (GENERIC[call]) seen.add(call)
      else unread.push(call)
    }
  }
  // takeOnce(key: 'a' | 'b', ...) in background.ts.
  const bg = fs.readFileSync(path.join(DIR, 'background.ts'), 'utf8')
  const take = /function takeOnce<\w+>\(key: ([^,]+),/.exec(bg)
  for (const m of (take?.[1] ?? '').matchAll(/'(\w+)'/g)) add(m[1], 'background.ts')
  return { found, unread, aliases, seen }
}

describe('every storage.session key is classified for an extension reload', () => {
  const { found, unread, aliases, seen } = scan()

  it('the scan reads keys where they are known to be (it reads the source it guards)', () => {
    for (const k of ['agentWindow', 'agentPage', 'agentTabs', 'agentMade', 'agentGroups', 'agentPersonGroups', 'debuggerCancelledAt', 'vaultSession', 'panelHand', 'pendingSave']) {
      expect(found.has(k), k).toBe(true)
    }
  })

  it('each key found in the source is in session-keys.ts', () => {
    const missing = [...found.keys()].filter((k) => !(k in SESSION_KEYS)).map((k) => `${k} (${found.get(k)!.join(', ')})`)
    expect(missing, 'classify it in packages/browser-extension/src/session-keys.ts: kept (agent-keep.ts) or lost with a reason').toEqual([])
  })

  it('each listed key is still used (no stale entry); agentAlive is agent-keep.ts\'s own', () => {
    const stale = Object.keys(SESSION_KEYS).filter((k) => !found.has(k) && k !== 'agentAlive')
    expect(stale).toEqual([])
    expect(fs.readFileSync(path.join(DIR, 'agent-keep.ts'), 'utf8')).toMatch(/export const ALIVE = 'agentAlive'/)
  })

  it('every call names its keys, or is one of the generic sites', () => {
    expect(unread).toEqual([])
    expect(aliases).toEqual([])
    expect([...Object.keys(GENERIC), ...Object.keys(ALIASES)].filter((x) => !seen.has(x)), 'a listed call no longer in the source').toEqual([])
  })

  it('every entry says why: kept or lost, in words', () => {
    for (const [k, v] of Object.entries(SESSION_KEYS)) {
      const why = 'kept' in v ? v.kept : v.lost
      expect(why.length, k).toBeGreaterThan(15)
    }
  })
})
