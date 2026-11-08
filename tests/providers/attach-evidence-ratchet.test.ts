/**
 * Class guard for the send.delivery alarm of 2026-11-12: a send into a live
 * session waited 37 s and 102 s because the attach in front of its write made
 * optional host reads with their own long timeouts.
 *
 *  1. attachToExisting makes no host read before its transport attaches except
 *     through readAttachEvidence (attach-evidence.ts), the one place a budget
 *     bounds them. A new read added inline fails here.
 *  2. Every caller of attachToExisting gives that budget, except the startup
 *     reconnect (no send waits on it). A new on-demand caller without one fails here.
 *     The session runner attaches through attachNativeRecord, which hands its
 *     caller's options on: there its callers are the ones held to the rule.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(import.meta.dirname, '../../src')
const FILE = path.join(SRC, 'providers/claude-code-session.ts')
const text = fs.readFileSync(FILE, 'utf8')

/** Calls that reach a host's daemon (or wait on its link). */
const HOST_READS: RegExp[] = [
  /\bDaemonFileReader\b/,
  /\bfetchStreamTailFold\b/,
  /\breadCostState\b/,
  /\breadFileRange\w*\(/,
  /\breadSessionHistory\w*\(/,
  /\.stat\(/,
  /\.send\(/,
  /\bprobeDaemon\w*\(/,
  /\blink\((?!'__local__')/,
  /\bgetConnectedDaemonConnection\(/,
]

function preAttachBody(): string {
  const start = text.indexOf('static async attachToExisting(')
  expect(start).toBeGreaterThan(0)
  const end = text.indexOf("log.session.info('attaching to existing session'", start)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}

describe('attach evidence ratchet', () => {
  it('attachToExisting reads the host only through readAttachEvidence before it attaches', () => {
    const body = preAttachBody()
    expect(body).toContain('readAttachEvidence(')
    const offenders: string[] = []
    body.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '')
      if (/^\s*\*/.test(code)) return // JSDoc
      for (const re of HOST_READS) if (re.test(code)) offenders.push(`+${i}: ${line.trim()}`)
    })
    expect(offenders, 'host reads in attachToExisting must go through readAttachEvidence (attach-evidence.ts)').toEqual([])
  })

  it('every on-demand caller gives the attach its evidence budget', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(SRC)
    const calls: { where: string; budget: boolean; startup: boolean }[] = []
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      const re = /\b(attachToExisting|attachNativeRecord)\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        const before = src.slice(Math.max(0, m.index - 40), m.index)
        if (/static async\s*$/.test(before) || /private\s*$/.test(before)) continue // a definition
        if (!/\.\s*$/.test(before)) continue // prose in a comment (`attachToExisting()`), not a call
        const close = src.indexOf(')', m.index)
        const args = src.slice(m.index, close + 1)
        const line = src.slice(0, m.index).split('\n').length
        // attachNativeRecord's own attach passes its caller's options on.
        const wrapperStart = src.lastIndexOf('private attachNativeRecord(', m.index)
        const inWrapper = m[1] === 'attachToExisting' && wrapperStart >= 0
          && !src.slice(wrapperStart, m.index).includes('\n  }\n') && /,\s*opts\)$/.test(args)
        calls.push({
          where: `${path.relative(SRC, f)}:${line}`,
          budget: /evidenceBudgetMs/.test(args) || inWrapper,
          startup: src.slice(Math.max(0, m.index - 1500), m.index).includes('Phase 1: reconnect to surviving sessions'),
        })
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(3)
    const unbounded = calls.filter((c) => !c.budget && !c.startup).map((c) => c.where)
    expect(unbounded, 'an on-demand attachToExisting or attachNativeRecord caller must pass { evidenceBudgetMs: ON_DEMAND_ATTACH_EVIDENCE_MS }').toEqual([])
    expect(calls.filter((c) => c.startup)).toHaveLength(1)
  })
})
