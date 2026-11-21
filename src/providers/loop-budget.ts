/**
 * One budget per turn of the event loop for work that can wait a turn: the daemon runtime's output
 * tailers (session-tailer.ts) and its in-process client's frame hand-over (daemon-in-process-client.ts).
 * Inside a server's process (experiment in_process_daemon) ten busy sessions then share a few
 * milliseconds a turn between them, instead of each taking its own slice back to back, and the
 * server's timers and requests run between the turns.
 *
 * The turn starts with the first work that asks; the check phase of the same loop iteration ends it
 * (setImmediate), so work that yields resumes in a fresh turn.
 */
export interface LoopBudget {
  /** This turn's budget is spent: yield before the next piece. */
  over(): boolean
  /** Resolves in a later turn of the loop. */
  yieldTurn(): Promise<void>
}

export const LOOP_BUDGET_MS = 4

export function createLoopBudget(budgetMs = LOOP_BUDGET_MS, now: () => number = () => performance.now()): LoopBudget {
  let turnStartedAt = 0
  const endTurn = () => { turnStartedAt = 0 }
  return {
    over() {
      if (!turnStartedAt) {
        turnStartedAt = now() || 1
        setImmediate(endTurn)
        return false
      }
      return now() - turnStartedAt >= budgetMs
    },
    yieldTurn: () => new Promise<void>((resolve) => setImmediate(resolve)),
  }
}

/** The process's one budget (every runtime and client in it shares the one loop). */
export const sharedLoopBudget: LoopBudget = createLoopBudget()
