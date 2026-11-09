import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * An animation that runs forever moves only `transform` or `opacity`, which the compositor runs
 * without repainting. Anything else (background-position, box-shadow, stroke-dashoffset) repaints
 * its layer every frame: the working line under every running session animated background-position
 * and WebKit repainted it about 90 times a second per visible line, in a Mac app page that reached
 * 2 GB (2026-11-09). New infinite animations must be composited; the ones below predate the rule
 * and sit on rare or short-lived surfaces. Remove a name once it is converted.
 */
const KNOWN_REPAINTING: Record<string, string> = {
  'mail-skeleton-sweep': 'mail list skeleton, only while the first page loads',
  mentionShimmer: 'the @-mention picker while it searches',
  'mic-pulse': 'the mic button while recording',
  'mic-transcribe-pulse': 'the mic button while a clip is transcribed',
  'thread-live-scan': 'the thread stack page',
  'thread-review-scan': 'the thread stack page',
  'todo-group-pulse': 'a task group drop target during a drag',
  'todo-nest-pulse': 'a nest drop target during a drag',
  'wf-stage-flow': 'the workflow graph page',
  'wf-stage-slide': 'the workflow graph page',
  'wn-phone-sync': 'the phone pairing screen',
}

const COMPOSITED = new Set(['transform', 'opacity', 'offset'])
const WEB = path.resolve(__dirname, '../../web/src')

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? cssFiles(full) : e.name.endsWith('.css') ? [full] : []
  })
}

describe('infinite animations', () => {
  it('move only transform or opacity', () => {
    const css = cssFiles(WEB).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    const props = new Map<string, Set<string>>()
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) {
      const set = props.get(m[1]) ?? new Set<string>()
      for (const p of m[2].matchAll(/([a-z-]+)\s*:/g)) set.add(p[1])
      props.set(m[1], set)
    }
    const infinite = new Set<string>()
    for (const m of css.matchAll(/animation(?:-name)?\s*:\s*([^;]+);/g)) {
      if (!/\binfinite\b/.test(m[1])) continue
      for (const word of m[1].match(/[\w-]+/g) ?? []) if (props.has(word)) infinite.add(word)
    }
    expect(infinite.size).toBeGreaterThan(20)
    const repainting = [...infinite].filter((name) => [...props.get(name)!].some((p) => !COMPOSITED.has(p))).sort()
    expect(repainting, 'an infinite animation repaints every frame: animate transform or opacity instead').toEqual(Object.keys(KNOWN_REPAINTING).sort())
  })
})
