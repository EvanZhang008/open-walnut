/**
 * A failing plugin sync logs one warn per streak for each kind of card, not one
 * each time the card's 60 s absorber window reopens (2026-11-15: an expired work
 * sign-in logged "sync: repeating" about 60 times an hour all morning).
 *
 * The ratchet below is the class guard: a log level picked from "the card was
 * published" alone is that bug again, wherever it appears in src/.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { StreakWarnings } from '../../src/core/plugin-sync-health.js'

describe('StreakWarnings', () => {
  it('warns on the first publish of a streak and is debug for every republish after it', () => {
    const w = new StreakWarnings()
    // An hour of 30 s ticks, the card republished each minute.
    const levels = Array.from({ length: 120 }, (_, i) => w.levelFor('delta:repeating', i % 2 === 0))
    expect(levels.filter((l) => l === 'warn')).toHaveLength(1)
    expect(levels[0]).toBe('warn')
  })

  it('an absorbed repeat (not published) is debug, and does not use up the streak warn', () => {
    const w = new StreakWarnings()
    expect(w.levelFor('delta:repeating', false)).toBe('debug')
    expect(w.levelFor('delta:repeating', true)).toBe('warn')
  })

  it('each kind warns once, and a reset warns again only for its own kinds', () => {
    const w = new StreakWarnings()
    expect(w.levelFor('delta:repeating', true)).toBe('warn')
    expect(w.levelFor('delta:sign-in', true)).toBe('warn')
    expect(w.levelFor('reconcile', true)).toBe('warn')
    w.reset('delta:') // a delta sync completed; the full comparison still fails
    expect(w.levelFor('delta:repeating', true)).toBe('warn')
    expect(w.levelFor('delta:sign-in', true)).toBe('warn')
    expect(w.levelFor('reconcile', true)).toBe('debug')
    w.reset('reconcile')
    expect(w.levelFor('reconcile', true)).toBe('warn')
  })
})

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(p)
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) yield p
  }
}

describe('ratchet: no log level chosen by a publish alone', () => {
  it('src/ never logs `published ? warn : debug` (use StreakWarnings)', () => {
    const root = path.resolve(__dirname, '../../src')
    const hits: string[] = []
    for (const file of sourceFiles(root)) {
      const text = fs.readFileSync(file, 'utf8')
      text.split('\n').forEach((line, i) => {
        // Any level picked from a publish flag alone: `published ? 'warn' : ...`, `!published ? 'debug' : 'warn'`.
        if (/\bpublished\s*\?\s*['"]warn['"]|!\s*published\s*\?\s*['"]debug['"]\s*:\s*['"]warn['"]/.test(line)) hits.push(`${path.relative(root, file)}:${i + 1}`)
      })
    }
    expect(hits).toEqual([])
  })
})
