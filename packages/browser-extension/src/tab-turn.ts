/**
 * One command at a time per tab: two at once (a full screenshot and a click, two debugger attaches)
 * would trip each other. A turn holds the tab's queue at most `limitMs`: Chrome leaves some calls
 * unanswered for good (a picture of a covered window, an attach), and a turn waiting on one would
 * hold every later command of that tab with it (2026-11-16: after one upload, every read of the tab
 * went unanswered for 15 minutes until the extension reloaded). Past the limit the next command goes;
 * the late work's answer is no one's (the server gave up on it long before: its longest wait is 50 s).
 */
export const TURN_MS = 60_000
/** A command still queued this long is past the server's wait for it (its longest, a full-page screenshot, is 50 s): never run late. */
export const STALE_MS = 52_000

const perTab = new Map<number, Promise<unknown>>()

export function inTurn<T>(tab: unknown, work: () => Promise<T>, limitMs = TURN_MS): Promise<T> {
  if (typeof tab !== 'number') return work()
  const before = perTab.get(tab) ?? Promise.resolve()
  const mine = before.catch(() => undefined).then(work)
  // The limit runs from the turn's own start (once the one before let go), never from its queueing.
  const tail = before.catch(() => undefined).then(() => new Promise<void>((done) => {
    const timer = setTimeout(done, limitMs)
    void mine.then(() => undefined, () => undefined).then(() => { clearTimeout(timer); done() })
  }))
  perTab.set(tab, tail)
  void tail.then(() => { if (perTab.get(tab) === tail) perTab.delete(tab) })
  return mine
}

/** Tests: no tab has a turn. */
export function _resetTurnsForTesting(): void { perTab.clear() }
