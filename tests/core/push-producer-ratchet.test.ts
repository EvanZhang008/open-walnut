/**
 * No producer reaches the general push subscriber (core/push-notification.ts).
 *
 * That subscriber turns background replies, session results and errors, and
 * triage chat updates into phone notifications. Today nothing addresses it:
 * every producer of those events names other subscribers (the main AI, the
 * session runner, the web UI), so none of its branches ever sends. Wiring one
 * makes the phone buzz, with that event's text on the lock screen, so it is a
 * product decision, and this file fails the day it happens without one.
 *
 * Two halves, because either alone can be fooled:
 *  - the source: every `bus.emit` in src is read with the TypeScript parser. An
 *    event the subscriber handles must name its destinations as a literal list
 *    without `push-notifications` or `*`; a computed list is allowed only where
 *    it is listed below and checked. No emit anywhere names `push-notifications`.
 *    The letter store's `['*']` is the one broadcast the subscriber hears, and it
 *    has no case for letters (letters push through core/push/letter-push.ts).
 *  - the bus: each of those emits is replayed through the REAL bus, with the
 *    destinations its producer uses, to a subscriber registered exactly like the
 *    real one. It must hear nothing, so a bus that added `push-notifications` on
 *    its own (or delivered to a non-global subscriber it was not addressed to)
 *    fails here even though every emit in the source still looks clean.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('push-producer-ratchet'))

import { bus, EventNames } from '../../src/core/event-bus.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SUBSCRIBER = 'push-notifications'
const LETTER_STORE = 'src/core/human-inbox/store.ts'

/** Computed destination lists that may carry a handled event, each checked by a test below. */
const COMPUTED_DESTINATIONS: Record<string, string> = {
  // ACP sessions emit their normalized events, results and errors included, to acpEventDestinations(name).
  'src/providers/acp-session.ts destinations': 'acpEventDestinations',
}

interface Emit { file: string; line: number; name: string | null; nameText: string; dest: string[] | null; destText: string }

const eventValues = EventNames as unknown as Record<string, string>

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') sourceFiles(p, out) }
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** The event name an emit's first argument resolves to, or null when it is computed. */
function eventName(node: ts.Expression | undefined, sf: ts.SourceFile): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === 'EventNames') {
    return eventValues[node.name.text] ?? null
  }
  return null
}

function literalList(node: ts.Expression | undefined): string[] | null {
  if (!node || !ts.isArrayLiteralExpression(node)) return null
  const out: string[] = []
  for (const el of node.elements) {
    if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) out.push(el.text)
    else return null
  }
  return out
}

function scanBusEmits(): Emit[] {
  const emits: Emit[] = []
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('.emit(')) continue
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'emit'
        && /(^|\.)bus$/.test(n.expression.expression.getText(sf))) {
        const [nameArg, , destArg] = n.arguments
        emits.push({
          file: path.relative(ROOT, file),
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          name: eventName(nameArg, sf),
          nameText: nameArg ? nameArg.getText(sf) : '',
          dest: literalList(destArg),
          destText: destArg ? destArg.getText(sf).replace(/\s+/g, ' ') : '',
        })
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return emits
}

/** The event names the subscriber has a `case` for, read from its source. */
function handledEvents(): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/push-notification.ts'), 'utf8')
  const names = [...src.matchAll(/case\s+EventNames\.(\w+)\s*:/g)].map((m) => eventValues[m[1]])
  if (names.length === 0 || !names.every((n) => typeof n === 'string')) throw new Error('push-notification.ts: no readable `case EventNames.X`')
  return [...new Set(names)]
}

/**
 * acp-session.ts's `acpEventDestinations`, read from its source rather than
 * imported (that module builds daemon connections): the per-event table, and
 * the default for any other name.
 */
function acpEventDestinations(name: string): string[] {
  const file = path.join(ROOT, 'src/providers/acp-session.ts')
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  let table: Record<string, string[]> | null = null
  let fallback: string[] | null = null
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'ACP_EVENT_DESTINATIONS' && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
      table = {}
      for (const prop of n.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) throw new Error('ACP_EVENT_DESTINATIONS: not a plain table')
        const key = ts.isStringLiteral(prop.name) ? prop.name.text : prop.name.getText(sf)
        const list = literalList(prop.initializer)
        if (!list) throw new Error(`ACP_EVENT_DESTINATIONS[${key}]: not a literal list`)
        table[key] = list
      }
    }
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'acpEventDestinations') {
      const body = n.body?.getText(sf).replace(/\s+/g, ' ') ?? ''
      const m = body.match(/^\{ return \[\.\.\.\(ACP_EVENT_DESTINATIONS\[eventName\] \?\? (\[[^\]]*\])\)\] \}$/)
      if (!m) throw new Error(`acpEventDestinations changed shape: ${body}`)
      fallback = JSON.parse(m[1].replace(/'/g, '"')) as string[]
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  if (!table || !fallback) throw new Error('acpEventDestinations not found in acp-session.ts')
  return [...((table as Record<string, string[]>)[name] ?? fallback)]
}

const emits = scanBusEmits()
const handled = handledEvents()
const at = (e: Emit) => `${e.file}:${e.line} ${e.nameText} -> ${e.destText}`

describe('the source: who addresses the general push subscriber', () => {
  it('the scan sees the producers it is about', () => {
    expect(emits.length).toBeGreaterThan(200)
    expect(handled).toEqual(expect.arrayContaining(['session:result', 'session:error', 'agent:response', 'chat:history-updated']))
    for (const name of ['session:result', 'session:error', 'chat:history-updated']) {
      expect(emits.some((e) => e.name === name), name).toBe(true)
    }
  })

  it('no emit anywhere names push-notifications', () => {
    expect(emits.filter((e) => e.dest?.includes(SUBSCRIBER) || e.destText.includes(SUBSCRIBER)).map(at)).toEqual([])
  })

  it('an event the subscriber handles names its destinations, without push-notifications or a broadcast', () => {
    const bad = emits.filter((e) => {
      if (e.name !== null && !handled.includes(e.name)) return false // not an event the subscriber acts on
      if (e.dest) return e.dest.includes('*') || e.dest.includes(SUBSCRIBER)
      return !(`${e.file} ${e.destText}` in COMPUTED_DESTINATIONS)
    })
    expect(bad.map(at)).toEqual([])
  })

  it('the one broadcast the subscriber hears is the letter, which it has no case for', () => {
    const letter = emits.filter((e) => e.name === 'human-inbox:letter')
    expect(letter.map((e) => `${e.file} ${e.destText}`)).toEqual([`${LETTER_STORE} ['*']`])
    expect(handled).not.toContain('human-inbox:letter')
  })

  it('the subscriber is registered non-global, so it hears only what names it (or `*`)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/push-notification.ts'), 'utf8')
    const calls = [...src.matchAll(/bus\.subscribe\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(calls).toEqual([SUBSCRIBER])
    expect(src).not.toMatch(/global:\s*true/)
  })

  it('every computed list a handled event may ride is checked', () => {
    const computed = emits.filter((e) => !e.dest && (e.name === null || handled.includes(e.name)))
    expect(computed.map((e) => `${e.file} ${e.destText}`).sort()).toEqual(Object.keys(COMPUTED_DESTINATIONS).sort())
    for (const name of handled) {
      const dest = acpEventDestinations(name)
      expect(dest, name).not.toContain(SUBSCRIBER)
      expect(dest, name).not.toContain('*')
    }
  })
})

describe('the bus: replaying every producer of a handled event', () => {
  it('a subscriber registered like the real one hears none of them', () => {
    const heard: string[] = []
    bus.clear()
    bus.subscribe(SUBSCRIBER, (event) => { heard.push(event.name) })
    try {
      const replays: Array<[string, string[]]> = []
      for (const e of emits) if (e.name && handled.includes(e.name) && e.dest) replays.push([e.name, e.dest])
      for (const name of handled) replays.push([name, acpEventDestinations(name)])
      expect(replays.length).toBeGreaterThan(15)
      for (const [name, dest] of replays) bus.emit(name, { sessionId: 'sess-acme-1', text: 'probe' }, [...dest], { source: 'ratchet' })
      expect(heard).toEqual([])
      // The probe itself works: an event that DOES name it is heard.
      bus.emit(EventNames.SESSION_RESULT, { sessionId: 'sess-acme-1' }, [SUBSCRIBER], { source: 'ratchet' })
      expect(heard).toEqual(['session:result'])
    } finally {
      bus.clear()
    }
  })
})
