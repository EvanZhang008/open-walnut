/**
 * A cheap "no" before the NFA: literal text that every match must contain (one of a few
 * alternatives), looked for with a native RegExp made only of `\uXXXX` escapes and `|`. With no
 * quantifier and no group, a backtracking engine tries each alternative at most once per position:
 * O(text length x total literal length). Any match of the whole pattern consumes its required
 * literal inside the matched span, so a text without one has no match (a cut text too: the matcher
 * only reports matches inside the cut).
 */
import type { Node } from './parse.js'

/** `ci: null` when no character in it has a case, so either flag gives the same answer. */
interface Factor { alts: number[][]; ci: boolean | null }

const MAX_ALTERNATIVES = 8

const caseless = (code: number): boolean => code < 128 && !/[A-Za-z]/.test(String.fromCharCode(code))

function compatible(a: boolean | null, b: boolean | null): boolean {
  return a === null || b === null || a === b
}

function score(factor: Factor): number {
  return Math.min(...factor.alts.map((alt) => alt.length))
}

function better(a: Factor | null, b: Factor | null): Factor | null {
  if (!a) return b
  if (!b) return a
  const sa = score(a)
  const sb = score(b)
  if (sa !== sb) return sa > sb ? a : b
  return b.alts.length < a.alts.length ? b : a
}

function required(node: Node): Factor | null {
  switch (node.type) {
    case 'char': return { alts: [[node.code]], ci: caseless(node.code) ? null : node.ci }
    case 'repeat': return node.min >= 1 ? required(node.body) : null
    case 'alt': {
      const parts = node.items.map(required)
      if (parts.some((part) => !part)) return null
      let ci: boolean | null = null
      for (const part of parts as Factor[]) {
        if (!compatible(ci, part.ci)) return null
        ci = ci ?? part.ci
      }
      const alts = (parts as Factor[]).flatMap((part) => part.alts)
      return alts.length <= MAX_ALTERNATIVES ? { alts, ci } : null
    }
    case 'seq': {
      let best: Factor | null = null
      let run: number[] = []
      let runCi: boolean | null = null
      const flush = (): void => {
        if (run.length) best = better(best, { alts: [run], ci: runCi })
        run = []
        runCi = null
      }
      for (const item of node.items) {
        if (item.type === 'char') {
          const ci = caseless(item.code) ? null : item.ci
          if (!compatible(runCi, ci)) flush()
          run.push(item.code)
          runCi = runCi ?? ci
        } else {
          flush()
          best = better(best, required(item))
        }
      }
      flush()
      return best
    }
    default: return null
  }
}

/** A native RegExp every matching text matches, or null when the pattern requires no literal. */
export function buildPrefilter(tree: Node): RegExp | null {
  const factor = required(tree)
  if (!factor) return null
  const source = factor.alts
    .map((alt) => alt.map((code) => '\\u' + code.toString(16).padStart(4, '0')).join(''))
    .join('|')
  return new RegExp(source, factor.ci ? 'i' : '')
}
