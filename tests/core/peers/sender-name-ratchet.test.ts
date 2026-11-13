/**
 * A sender is named by its task, and a fork names its source once.
 *
 * 2026-11-03: a task's messages arrived from "Fork of Fork of Fork of Fork of Fork of
 * Session: <service> — <url>": the envelope printed the SESSION title, and every fork had
 * prefixed its source's name again. Three layers here:
 *  - forkBaseTitle / forkTitleOf (src/core/fork-base-title.ts): a chain of forks, however
 *    deep and in whatever shape, carries one "Fork of" at most;
 *  - the envelope kit prints one "Fork of" even for a title from the stacking era;
 *  - the ratchet: every place in src/ that builds a peer note, a reply, a fork's hand-off
 *    notice or an onward-answer line names the sender through sender-name.ts (or the
 *    daemon's task-first callerIdentity), never from a session record's own title. A new
 *    call site fails here until it does.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { forkBaseTitle, forkTitleOf } from '../../../src/core/fork-base-title.js'
import { createEnvelopeKit } from '../../../src/core/peers/envelope-kit.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const forkCount = (title: string) => (title.match(/fork of/gi) ?? []).length

describe('fork titles never stack', () => {
  it('a chain of six forks carries one "Fork of"', () => {
    let title = 'Session: Widget Service — https://example.invalid/t/42'
    for (let i = 0; i < 6; i++) {
      title = forkTitleOf(title)
      expect(forkCount(title)).toBe(1)
    }
    expect(title).toBe('Fork of Session: Widget Service — https://example.invalid/t/42')
  })

  it('takes every layer off a source from the stacking era, in any mix of shapes', () => {
    expect(forkBaseTitle('Fork of Fork of Fork of Widget sync')).toBe('Widget sync')
    expect(forkBaseTitle('fork of FORK OF Widget sync')).toBe('Widget sync')
    expect(forkBaseTitle('Retry backoff - fork of Fork of Widget sync')).toBe('Retry backoff')
    expect(forkBaseTitle('Fork of Retry backoff - fork of Widget sync')).toBe('Retry backoff')
    expect(forkTitleOf('Fork of Fork of Widget sync')).toBe('Fork of Widget sync')
  })

  it('keeps a title that is only the decoration, and a plain title as it is', () => {
    expect(forkBaseTitle('Fork of')).toBe('Fork of')
    expect(forkBaseTitle('Widget fork of the week')).toBe('Widget fork of the week')
    expect(forkBaseTitle('  Widget sync  ')).toBe('Widget sync')
  })
})

describe('the envelope kit prints one "Fork of"', () => {
  const kit = createEnvelopeKit()
  it('collapses a stacked title in the from handle', () => {
    const env = kit.buildPeerWrapper('hi', {
      title: 'Fork of Fork of Fork of Fork of Fork of Session: Widget Service', shortId: 'abcd1234', host: 'local',
    })
    expect(env).toContain('from="Fork of Session: Widget Service [abcd1234]"')
  })
  it('leaves a single one and a plain title alone', () => {
    expect(kit.buildPeerWrapper('hi', { title: 'Fork of Widget', shortId: 'abcd1234', host: 'local' }))
      .toContain('from="Fork of Widget [abcd1234]"')
    expect(kit.buildPeerWrapper('hi', { title: 'Widget sync', shortId: 'abcd1234', host: 'local' }))
      .toContain('from="Widget sync [abcd1234]"')
  })
})

/** Every `.ts` file under src/. */
function sources(dir = path.join(ROOT, 'src')): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** The argument text of a call opened at `open` (the index of its `(`), to its matching `)`. */
function argsAt(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

/**
 * How each envelope call site may name its sender. The server reads sender-name.ts
 * (`senderTitleOf`, or a value it returned: `replierTitle`, `framingCallerOf`'s caller in
 * send-frame.ts); the daemon reads its task-first `callerIdentity` (`me.title`), or the
 * relayed caller another daemon named that way (`from.title`).
 */
const NAMED_BY_TASK = /senderTitleOf\(|\breplierTitle\b|opts\.caller\.title|\bme\.title\b|\bfrom\.title\b/
/** Definitions, type signatures and wrappers that pass a sender through untouched. */
const PASS_THROUGH = /^\s*(?:originalText|request)\s*[,:]/

describe('ratchet: every envelope names its sender by the task', () => {
  it('finds each peer-note and reply call site and checks how it names the sender', () => {
    const sites: string[] = []
    const bad: string[] = []
    for (const file of sources()) {
      const text = fs.readFileSync(file, 'utf8')
      const re = /\b(?:kit\.)?(buildPeerWrapper|buildReplyDeliveryText|buildForkHandoffNotice|wentPastLine)\(/g
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const before = text.slice(Math.max(0, m.index - 20), m.index)
        if (/function\s*$/.test(before)) continue
        const args = argsAt(text, m.index + m[0].length - 1)
        if (PASS_THROUGH.test(args)) continue
        const rel = path.relative(ROOT, file)
        const line = text.slice(0, m.index).split('\n').length
        // The daemon twin's start-up self check builds one with a literal title.
        if (rel === 'src/providers/daemon-source.ts' && /title: 't'/.test(args)) continue
        // A named automation has no task title; its shared anonymous envelope names the script.
        if (rel === 'src/core/sessions/send-frame.ts' && /anonymous: true/.test(args) && /automation: opts\.source/.test(args)) continue
        sites.push(`${rel}:${line}`)
        if (/record\.title/.test(args) || !NAMED_BY_TASK.test(args)) bad.push(`${rel}:${line}`)
      }
    }
    // The call sites known on 2026-11-03; a drop means the scan stopped seeing them.
    expect(sites.length).toBeGreaterThanOrEqual(11)
    expect(bad, `name the sender through src/core/peers/sender-name.ts: ${bad.join(', ')}`).toEqual([])
  })

  it('the task start frames its first line with the caller named by its task', () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/core/sessions/task-start.ts'), 'utf8')
    const at = text.indexOf('frameStartText(startBody')
    expect(at).toBeGreaterThan(0)
    expect(argsAt(text, text.indexOf('(', at))).toMatch(/caller: await framingCallerOf\(/)
  })

  it("the daemon's callerIdentity reads the task's title first", () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/providers/offline-host-core.ts'), 'utf8')
    // Every `me` an envelope names (`me.title` above) is the caller as callerIdentity names it.
    const mes = [...text.matchAll(/\bconst me = ([^\n]*)/g)].map((m) => m[1])
    expect(mes.length).toBeGreaterThan(0)
    for (const rhs of mes) expect(rhs).toMatch(/^callerIdentity\(/)
    const body = text.slice(text.indexOf('function callerIdentity('), text.indexOf('function asOf('))
    const titleLine = body.split('\n').find((l) => /const title =/.test(l)) ?? ''
    expect(titleLine.indexOf('tasks.find')).toBeGreaterThan(-1)
    expect(titleLine.indexOf('tasks.find')).toBeLessThan(titleLine.indexOf('row?.title'))
  })
})
