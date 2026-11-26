/**
 * A vault refusal that reports a state only the person changes (locked, not set up, Secret Key
 * needed, agent access Off) logs one warn line per caller and route, then info for its repeats
 * (src/web/routes/vault-answer.ts). 2026-11-26: a trigger's check script asked password_list every
 * 2 minutes while the vault stayed locked overnight, one 423 warn line each, until the log-spike
 * alarm rang.
 *
 * The class guards: every vault refusal code (VaultError's, agent.ts refuse()'s, the vault routes'
 * literal ones) is classified as a state answer or not, so a new code cannot slip in unclassified; and no route under src/web answers a vault refusal by hand, so a new
 * route cannot log a warn line per poll again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { VAULT_STATE_CODES, sendVaultRefusal } from '../../src/web/routes/vault-answer.js'
import { requestLogger } from '../../src/web/middleware/request-logger.js'
import { resetFinalAnswersForTest } from '../../src/core/hosts/repeat-answers.js'
import { log } from '../../src/logging/index.js'

const ROOT = path.resolve(__dirname, '../..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(rel))
    else if (/\.tsx?$/.test(e.name)) out.push(rel)
  }
  return out
}

/** A refusal about the request itself (or one whose repeat is news, like a wrong password): a warn line each time. */
const REQUEST_CODES = new Set([
  'agent_never', 'ambiguous', 'approval_used', 'bad_ids', 'bad_import', 'bad_item', 'bad_kdf', 'bad_password_key',
  'bad_recovery_code', 'bad_request', 'bad_secret_key', 'browser_key_refused', 'browser_key_unavailable', 'denied',
  'export_person_only', 'human_only', 'insecure_link', 'join_refused', 'locked_notes_key', 'no_key_backup',
  'no_recovery', 'no_such_field', 'not_found', 'not_in_trash', 'nothing_to_hand', 'nothing_to_join',
  'purpose_required', 'recovery_stale', 'stale_item', 'sync_mass_trash', 'test_run', 'vault_exists', 'vault_newer',
  'vault_unreadable', 'withdrawn', 'wrong_password', 'wrong_recovery_code',
])

/** The text of a call's arguments, from its "(" at `open` to the balanced ")", skipping strings and template literals. */
function callArgs(text: string, open: number): string | null {
  const stack: string[] = []
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    const top = stack[stack.length - 1]
    if (top === "'" || top === '"') { if (c === '\\') i++; else if (c === top) stack.pop(); continue }
    if (top === '`') {
      if (c === '\\') i++
      else if (c === '`') stack.pop()
      else if (c === '$' && text[i + 1] === '{') { stack.push('{'); i++ }
      continue
    }
    if (c === "'" || c === '"' || c === '`') { stack.push(c); continue }
    if (top === '{') { if (c === '{') stack.push('{'); else if (c === '}') stack.pop(); continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return null
}

/** Calls that pass a code through rather than name one: each is the only one of its kind. */
const PASS_THROUGH = [
  'src/core/vault/agent.ts: new VaultError(message, status, code)', // refuse(), whose calls are read below
  'src/core/vault/agent.ts: refuse(decision.status, decision.code', // the item's own access rule: agent_never
]

/** Every vault refusal code: VaultError's, agent.ts refuse()'s, and the literal ones of the vault routes. */
function vaultCodes(): { codes: Map<string, string>; passThrough: string[] } {
  const codes = new Map<string, string>()
  const passThrough: string[] = []
  for (const f of sources('src')) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
    for (const m of text.matchAll(/new VaultError\(/g)) {
      const args = callArgs(text, m.index! + m[0].length - 1)
      expect(args, `${f}: an unclosed new VaultError(`).not.toBeNull()
      const code = /,\s*\d{3}\s*,\s*'([a-z_]+)'\s*$/.exec(args!.trim())?.[1]
      if (code) codes.set(code, f)
      else passThrough.push(`${f}: new VaultError(${args!.trim().slice(0, 40)})`)
    }
    if (f.endsWith('core/vault/agent.ts')) {
      for (const m of text.matchAll(/\brefuse\(\s*([\w.]+)\s*,\s*(?:'([a-z_]+)'|([\w.]+))/g)) {
        if (m[1] === 'status') continue // its own declaration
        if (m[2]) codes.set(m[2], f)
        else passThrough.push(`${f}: refuse(${m[1]}, ${m[3]}`)
      }
    }
    if (/^src\/web\/routes\/vault[^/]*\.ts$/.test(f)) for (const m of text.matchAll(/code: '([a-z_]+)'/g)) codes.set(m[1], f)
  }
  return { codes, passThrough }
}

afterEach(() => { vi.restoreAllMocks(); resetFinalAnswersForTest() })

describe('every vault refusal code is classified', () => {
  it('as a state answer (quiet when repeated) or a request answer (a warn each time)', () => {
    const { codes, passThrough } = vaultCodes()
    expect(codes.size).toBeGreaterThan(30)
    for (const c of ['vault_locked', 'agents_off', 'agent_paused', 'vault_session_needed']) expect(codes.has(c)).toBe(true)
    expect(passThrough, 'a VaultError or refuse() whose code this guard cannot read: name the code literally').toEqual(PASS_THROUGH)
    const unclassified = [...codes.keys()].filter((c) => !VAULT_STATE_CODES.has(c) && !REQUEST_CODES.has(c)).map((c) => `${c} (${codes.get(c)})`)
    expect(unclassified, 'a new vault code: add it to VAULT_STATE_CODES (vault-answer.ts) when asking again unchanged gets the same answer until the person acts, else to REQUEST_CODES here').toEqual([])
    for (const c of VAULT_STATE_CODES) expect(REQUEST_CODES.has(c), c).toBe(false)
  })
})

describe('no route answers a vault refusal by hand', () => {
  it('every VaultError, locked-note error, browser refusal and literal state answer goes through sendVaultRefusal', () => {
    const offenders: string[] = []
    const stateLiteral = new RegExp(`res\\.status\\([^)]*\\)\\.json\\([^\\n]*code: '(${[...VAULT_STATE_CODES].join('|')})'`)
    for (const f of sources('src/web')) {
      const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        const vaultCatch = /instanceof (VaultError|BrowserError)\b/.test(line) && /res\.status\(/.test(line)
        const noteCatch = /if \(known\)/.test(line) && /res\.status\(/.test(line) && lines.slice(Math.max(0, i - 3), i).some((l) => l.includes('lockedNoteErrorBody('))
        if (vaultCatch || noteCatch || stateLiteral.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, 'answer it with sendVaultRefusal (src/web/routes/vault-answer.ts) so a repeated state answer logs at info').toEqual([])
  })
})

describe('request log: a repeated vault state answer', () => {
  function fire(status: number, code: string, headers: Record<string, string> = {}, url = '/api/v1/vault/agent/items'): { warn: number; info: number; repeat: boolean } {
    const warn = vi.spyOn(log.web, 'warn')
    const info = vi.spyOn(log.web, 'info')
    const res = new EventEmitter() as unknown as Response & EventEmitter
    const sent: Record<string, string> = {}
    const req = { method: 'GET', originalUrl: url, url, path: url.split('?')[0], query: {}, headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request
    Object.assign(res, {
      req,
      statusCode: 200,
      setHeader: (name: string, value: string) => { sent[name.toLowerCase()] = value; return res },
      getHeader: (name: string) => sent[name.toLowerCase()],
      status: (s: number) => { (res as unknown as { statusCode: number }).statusCode = s; return res },
      json: () => { res.emit('finish'); return res },
    })
    requestLogger(req, res, () => {})
    sendVaultRefusal(res, status, { error: 'x', code })
    const mine = (calls: unknown[][]) => calls.filter(([m]) => String(m).startsWith(`GET ${url.split('?')[0]}`)).length
    return { warn: mine(warn.mock.calls), info: mine(info.mock.calls), repeat: sent['x-walnut-repeat-answer'] === '1' }
  }

  it('the first locked answer is a warn line, its repeats are info, with or without a query', () => {
    expect(fire(423, 'vault_locked')).toEqual({ warn: 1, info: 0, repeat: false })
    expect(fire(423, 'vault_locked')).toEqual({ warn: 0, info: 1, repeat: true })
    expect(fire(423, 'vault_locked', {}, '/api/v1/vault/agent/items?q=git')).toEqual({ warn: 0, info: 1, repeat: true })
  })

  it('another caller, another route or another state starts with its own warn line', () => {
    expect(fire(423, 'vault_locked', { 'x-walnut-caller-sid': 'sess-a' })).toMatchObject({ warn: 1, repeat: false })
    expect(fire(423, 'vault_locked', { 'x-walnut-caller-sid': 'sess-b' })).toMatchObject({ warn: 1, repeat: false })
    expect(fire(423, 'vault_locked', { 'x-walnut-caller-sid': 'sess-a' }, '/api/v1/vault/items')).toMatchObject({ warn: 1, repeat: false })
    expect(fire(403, 'agents_off', { 'x-walnut-caller-sid': 'sess-a' })).toMatchObject({ warn: 1, repeat: false })
  })

  it('a refusal whose repeat is news keeps a warn line each time', () => {
    expect(fire(401, 'wrong_password')).toMatchObject({ warn: 1, repeat: false })
    expect(fire(401, 'wrong_password')).toMatchObject({ warn: 1, repeat: false })
  })
})
