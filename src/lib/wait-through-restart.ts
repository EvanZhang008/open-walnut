/**
 * A command that waits on a person through repeated calls to Walnut (`walnut approve`, `walnut
 * pass`, `walnut browser` on a needs_ok, `open-walnut wait`) keeps waiting while Walnut is away
 * for a moment (2026-11-20: a deploy restarted the server during `walnut browser
 * request-sign-in`, and the first refused call ended the command with "Walnut server not running";
 * production restarts about 60 times a day). It says so once per outage on stderr, pauses with a
 * growing backoff (1 s, 2 s, ... at most 10 s, never past its deadline, cut short by Ctrl-C), and
 * calls again with the same request id; the server keeps the ask across the restart
 * (core/kept-asks.ts, approvals.json). A definite answer (a 4xx: unknown id, used, denied, a bad
 * token) still ends the wait at once: only a call that got no answer is waited out.
 *
 * Every such loop goes through here (guard: tests/core/wait-through-restart-guard.test.ts).
 */

/** What a poll answered, as the CLI loops see it. */
export interface PollAnswer { ok: boolean; status?: number }

/** Walnut answered and refused for certain (4xx): never waited out. */
export function definiteRefusal(r: PollAnswer): boolean {
  return !r.ok && r.status !== undefined && r.status >= 400 && r.status < 500
}

export interface WaitThroughRestart {
  /** A poll got no answer (Walnut away): said once per outage, then a pause before the next call. */
  lost(message: string | undefined): Promise<void>
  /** A poll answered: the next outage is said again. */
  answered(): void
}

export function waitThroughRestart(o: {
  /** The command's name, the start of its line ("walnut approve"). */
  who: string
  say: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** The pause never runs past it. */
  deadline?: number
  /** Resolves on Ctrl-C: the pause ends at once. */
  stop?: Promise<unknown>
}): WaitThroughRestart {
  // Never unref'd: the pause is what keeps a waiting command alive.
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms) }))
  const now = o.now ?? Date.now
  let failures = 0
  return {
    async lost(message) {
      failures++
      if (failures === 1) o.say(`${o.who}: lost Walnut for a moment (${message ?? 'no answer'}); still waiting.`)
      const left = o.deadline === undefined ? Infinity : Math.max(0, o.deadline - now())
      const pause = Math.min(10_000, 1_000 * failures, left)
      await (o.stop ? Promise.race([sleep(pause), o.stop]) : sleep(pause))
    },
    answered() { failures = 0 },
  }
}
