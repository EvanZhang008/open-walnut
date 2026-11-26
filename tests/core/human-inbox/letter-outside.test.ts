/**
 * Which letters an agent reads framed as outside data (src/core/human-inbox/letter-outside.ts;
 * 2026-11-26, issue #23: letters a plugin or the mail router wrote reached agents with no frame).
 *
 * The guard half fails on a NEW member nobody classified: a letter origin kind, a Walnut letter kind,
 * a send site the letter ratchet exempts, or a plugin letter writer that stops stamping its plugin.
 * The rule half pins how each kind of letter is told apart.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { LETTER_ORIGIN_KINDS } from '../../../src/core/human-inbox/letter-origin.js'
import { EXEMPT_LETTER_SENDS, WALNUT_LETTER_KINDS } from '../../../src/core/human-inbox/walnut-letters/registry.js'
import {
  LETTER_ORIGIN_WORDS, LETTER_SEND_WORDS, ROUTER_LETTER_OP_PREFIX, WALNUT_LETTER_KIND_WORDS,
  letterOutsideSource, turnOutsideSource,
} from '../../../src/core/human-inbox/letter-outside.js'
import { routerLetterOpKey } from '../../../src/core/router/letter-receipts.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(rel))
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

const sorted = (xs: Iterable<string>) => [...xs].sort()

describe('every member is classified', () => {
  it('every letter origin kind says whose words its letters are', () => {
    expect(sorted(Object.keys(LETTER_ORIGIN_WORDS)), 'a new origin kind (letter-origin.ts): classify it in LETTER_ORIGIN_WORDS').toEqual(sorted(LETTER_ORIGIN_KINDS))
  })

  it('every Walnut letter kind says whether its template quotes outside text', () => {
    expect(sorted(Object.keys(WALNUT_LETTER_KIND_WORDS)), 'a new kind in walnut-letters/registry.ts: classify it in WALNUT_LETTER_KIND_WORDS')
      .toEqual(sorted(WALNUT_LETTER_KINDS.map((k) => k.id)))
  })

  it('every send site the letter ratchet exempts is classified', () => {
    expect(sorted(Object.keys(LETTER_SEND_WORDS)), 'a new exempt send site (EXEMPT_LETTER_SENDS): classify it in LETTER_SEND_WORDS')
      .toEqual(sorted(Object.keys(EXEMPT_LETTER_SENDS)))
  })

  it('every rule gives its reason', () => {
    for (const [table, rules] of Object.entries({ LETTER_ORIGIN_WORDS, WALNUT_LETTER_KIND_WORDS, LETTER_SEND_WORDS })) {
      for (const [id, rule] of Object.entries(rules)) expect(rule.why.length, `${table}.${id}`).toBeGreaterThan(15)
    }
  })

  it('a plugin\'s letters and turns are stamped with the plugin, which frames them', () => {
    const text = read('src/core/plugins/plugin-letters.ts')
    const senders = [...text.matchAll(/sender:\s*\{[^}]*\}/g)].map((m) => m[0])
    expect(senders.length, 'plugin-letters.ts writes letters and turns').toBeGreaterThanOrEqual(2)
    for (const s of senders) expect(s, 'every letter or turn a plugin writes names it (sender.pluginId)').toMatch(/pluginId/)
    // Every plugin writer of letters goes through that API: none writes the store itself.
    const direct = sources('src/integrations').filter((f) => /(?<![\w.])(sendLetter|sendLetterOnce|agentReply)\s*\(/.test(read(f)))
    expect(direct, 'a plugin writing the letter store directly would carry no pluginId: use walnut.letters').toEqual([])
  })

  it('the router\'s letters are told by their op key', () => {
    expect(ROUTER_LETTER_OP_PREFIX).toBe('router-letter:')
    expect(routerLetterOpKey('area', 'key').startsWith(ROUTER_LETTER_OP_PREFIX)).toBe(true)
    expect(read('src/core/router/service.ts')).toMatch(/opKey:\s*routerLetterOpKey\(/)
  })
})

describe('the rule', () => {
  const task = { sessionId: 's-1', taskId: 't-1', taskTitle: 'Ship it', host: 'local' }

  it('frames a plugin\'s letter, whatever template built it', () => {
    expect(letterOutsideSource({ sender: { sessionId: 'external', host: 'local', pluginId: 'mail' } })).toBe('plugin mail')
    expect(letterOutsideSource({ sender: { sessionId: 'external', pluginId: 'mail' }, createdByOp: 'mail-digest:x', origin: { kind: 'walnut' } })).toBe('plugin mail')
    expect(letterOutsideSource({ sender: { sessionId: 'external', pluginId: 'acme-tickets' }, origin: { kind: 'plugin' } })).toBe('plugin acme-tickets')
  })

  it('frames the mail router\'s "For you" letter, sent from the router\'s session or with none', () => {
    expect(letterOutsideSource({ sender: task, createdByOp: routerLetterOpKey('a1', 'k1') })).toBe('mail router letter')
    expect(letterOutsideSource({ sender: { sessionId: 'external' }, createdByOp: routerLetterOpKey('a1', 'k2') })).toBe('mail router letter')
  })

  it('frames a Walnut template that quotes outside text, an Inbox Triage summary and a script\'s letter', () => {
    expect(letterOutsideSource({ sender: { sessionId: 'external' }, createdByOp: 'mail-approval:d1' })).toBe('mail')
    expect(letterOutsideSource({ sender: { sessionId: 'external' }, createdByOp: 'org-report:2026-11-26' })).toBe('walnut report quoting letters')
    expect(letterOutsideSource({ sender: { ...task, agentId: 'triage' } })).toBe('inbox triage letter')
    expect(letterOutsideSource({ sender: { sessionId: 'external', via: 'api' } })).toBe('script letter')
  })

  it('keeps a task\'s own letter and Walnut\'s own notice plain', () => {
    expect(letterOutsideSource({ sender: task })).toBeUndefined()
    expect(letterOutsideSource({ sender: task, origin: { kind: 'task' } })).toBeUndefined()
    expect(letterOutsideSource({ sender: { sessionId: 'external' }, createdByOp: 'host-sign-in:h1' })).toBeUndefined()
    expect(letterOutsideSource({ sender: { sessionId: 'external' } })).toBeUndefined()
  })

  it('a turn: a person\'s is theirs; a plugin\'s or a script\'s is outside in any letter', () => {
    expect(turnOutsideSource({ from: 'human' }, 'plugin mail')).toBeUndefined()
    expect(turnOutsideSource({ from: 'agent' }, 'plugin mail')).toBe('plugin mail')
    expect(turnOutsideSource({ from: 'agent' }, undefined)).toBeUndefined()
    expect(turnOutsideSource({ from: 'agent', sender: { pluginId: 'mail' } }, undefined)).toBe('plugin mail')
    expect(turnOutsideSource({ from: 'agent', sender: { via: 'api' } }, undefined)).toBe('script letter')
  })
})
