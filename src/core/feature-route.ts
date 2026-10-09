/**
 * A feature with fallbacks (docs/plan/walnut-servers-everywhere.md, "Routing"):
 * an ordered list of engines, tried in turn until one answers.
 *
 * Speech to text is the model case: the leader's engine, then this server's own,
 * then a hosted API. An engine that cannot run here says why and is skipped; one
 * that fails hands the input to the next, unless its failure is a VERDICT about
 * the input (an undecodable recording), which no other engine would answer
 * differently, so the route stops there. Every skip and failure is kept, in
 * order, so the caller can say what really happened when nothing answered.
 */

export interface FeatureEngine<I, O> {
  /** Names the engine in `via` and in the attempts. */
  id: string
  /** Why it cannot run here for this input, or null when it can. */
  unavailable(input: I): string | null | Promise<string | null>
  run(input: I): Promise<O>
}

export interface FeatureAttempt {
  id: string
  outcome: 'skipped' | 'failed'
  /** The skip reason, or the failure's message. */
  reason: string
  error?: unknown
}

export type FeatureResult<O> =
  | { ok: true; via: string; output: O; attempts: FeatureAttempt[] }
  | { ok: false; verdict?: FeatureAttempt; attempts: FeatureAttempt[] }

export async function routeFeature<I, O>(
  engines: ReadonlyArray<FeatureEngine<I, O>>,
  input: I,
  isVerdict: (error: unknown) => boolean = () => false,
): Promise<FeatureResult<O>> {
  const attempts: FeatureAttempt[] = []
  for (const engine of engines) {
    let skip: string | null
    try {
      skip = await engine.unavailable(input)
    } catch (error) {
      skip = error instanceof Error ? error.message : String(error)
    }
    if (skip !== null) {
      attempts.push({ id: engine.id, outcome: 'skipped', reason: skip })
      continue
    }
    try {
      const output = await engine.run(input)
      return { ok: true, via: engine.id, output, attempts }
    } catch (error) {
      const attempt: FeatureAttempt = {
        id: engine.id, outcome: 'failed', reason: error instanceof Error ? error.message : String(error), error,
      }
      attempts.push(attempt)
      if (isVerdict(error)) return { ok: false, verdict: attempt, attempts }
    }
  }
  return { ok: false, attempts }
}
