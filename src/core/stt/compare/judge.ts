/**
 * The AI-guessed reference of a take and the scores against it. The judge
 * reads every hearing engine's text (never a post-processing engine's: its
 * text is the in-use text edited, and would pull the reference toward itself),
 * and is asked again when an engine's text arrives that it has not read.
 */
import type { Config } from '../../types.js'
import { COMPARE_ENGINES, JUDGE } from './engines.js'
import { scoreText } from './score.js'
import { compareStore } from './store.js'
import type { CompareTake, TakeScore } from './types.js'

/** The engine texts the judge reads for this take. */
export function judgeTexts(take: CompareTake, config: Config): Array<{ engine: string; label: string; text: string }> {
  return COMPARE_ENGINES.filter((e) => !e.after).flatMap((e) => {
    const text = take.results[e.id]?.text
    return text ? [{ engine: e.id, label: e.labelFor?.(config) ?? e.label, text }] : []
  })
}

/** True when the take has engine texts its reference has not read. */
export function needsJudge(take: CompareTake, config: Config): boolean {
  const texts = judgeTexts(take, config)
  if (!texts.length) return false
  if (!take.reference) return true
  const read = new Set(take.reference.engines ?? [])
  return texts.some((t) => !read.has(t.engine))
}

/** Every engine text scored against the reference (none without one). */
export async function scoresOf(take: CompareTake): Promise<Record<string, TakeScore> | undefined> {
  const ref = take.reference
  if (!ref) return undefined
  const out: Record<string, TakeScore> = {}
  for (const [engine, result] of Object.entries(take.results)) {
    if (result.text !== undefined) out[engine] = await scoreText(result.text, ref.text, ref.terms ?? [])
  }
  return out
}

/** Score the take again against its reference and store the scores. */
export async function rescore(take: CompareTake): Promise<CompareTake> {
  const scores = await scoresOf(take)
  return scores ? compareStore.upsert(take.id, { scores }) : take
}

/**
 * Ask the judge for this take's reference (when it needs one, or `force`),
 * then score it. Throws what the judge throws (no consent, a model failure).
 */
export async function judgeTake(take: CompareTake, config: Config, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<CompareTake> {
  if (!opts.force && !needsJudge(take, config)) return take.reference && !take.scores ? rescore(take) : take
  const texts = judgeTexts(take, config)
  if (!texts.length) throw new Error('no engine text to judge yet')
  const out = await JUDGE.run({ texts }, { config, signal: opts.signal })
  const stored = await compareStore.upsert(take.id, {
    reference: {
      text: out.text, judge: out.model ?? 'unknown', at: new Date().toISOString(),
      terms: out.terms ?? [], engines: texts.map((t) => t.engine),
    },
  })
  return rescore(stored)
}
