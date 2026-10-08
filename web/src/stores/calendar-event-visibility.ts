/**
 * Per-event "hidden in Walnut" writes: one request at a time per id, the latest
 * local intent shown at once, and a failure rolled back only when no newer
 * intent replaced it. Holds no events itself; the calendar store wires it in.
 */
import type { CalendarEvent } from '@/api/calendar';

export interface EventVisibilityFailure {
  id: string;
  /** The value the failed request asked for. */
  hidden: boolean;
  error: unknown;
}

export interface EventVisibilityDeps {
  send: (id: string, hidden: boolean) => Promise<{ hidden: boolean }>;
  /** Set `hidden` on every cached copy of the event. */
  apply: (id: string, hidden: boolean) => void;
  onFailure: (failure: EventVisibilityFailure) => void;
  begin: () => void;
  end: () => void;
}

interface Intent {
  /** What the server holds, as far as this browser knows. */
  confirmed: boolean;
  desired: boolean;
  gen: number;
  sending: boolean;
  /** Clock at which the queue went idle; 0 while a request is sent or due. */
  settledAt: number;
  waiters: Array<() => void>;
}

export function createEventVisibility(deps: EventVisibilityDeps) {
  const intents = new Map<string, Intent>();
  const fetchesInFlight = new Set<number>();
  let clock = 0;

  function prune(): void {
    let oldest = Infinity;
    for (const t of fetchesInFlight) oldest = Math.min(oldest, t);
    for (const [id, st] of intents) {
      if (st.settledAt && st.settledAt < oldest) intents.delete(id);
    }
  }

  function settle(st: Intent): void {
    st.settledAt = ++clock;
    const waiters = st.waiters.splice(0);
    for (const fn of waiters) fn();
    prune();
  }

  function send(id: string, st: Intent): void {
    const target = st.desired;
    const gen = st.gen;
    let resend = false;
    st.sending = true;
    deps.begin();
    deps.send(id, target)
      .then(
        (res) => {
          st.confirmed = !!res.hidden;
          if (st.gen === gen && st.confirmed !== target) {
            st.desired = st.confirmed;
            deps.apply(id, st.confirmed);
          }
        },
        (error) => {
          if (st.gen !== gen) { resend = true; return; }
          st.desired = st.confirmed;
          deps.apply(id, st.confirmed);
          deps.onFailure({ id, hidden: target, error });
        },
      )
      .finally(() => {
        st.sending = false;
        if (resend || st.desired !== st.confirmed) send(id, st);
        else settle(st);
        deps.end();
      });
  }

  return {
    /** `current` is the local record's value, used when this id has no history. */
    set(id: string, hidden: boolean, current: boolean): Promise<void> {
      const st: Intent = intents.get(id)
        ?? { confirmed: current, desired: hidden, gen: 0, sending: false, settledAt: 0, waiters: [] };
      intents.set(id, st);
      st.desired = hidden;
      st.gen += 1;
      st.settledAt = 0;
      const done = new Promise<void>((resolve) => { st.waiters.push(resolve); });
      deps.apply(id, hidden);
      if (!st.sending) send(id, st);
      return done;
    },

    /** Value a write response must not override, if any. */
    pending(id: string): boolean | undefined {
      const st = intents.get(id);
      return st && !st.settledAt ? st.desired : undefined;
    },

    fetchStarted(): number {
      const t = ++clock;
      fetchesInFlight.add(t);
      return t;
    },

    fetchEnded(t: number): void {
      fetchesInFlight.delete(t);
      prune();
    },

    /**
     * A GET started at `t` keeps a pending intent, and a value settled after the
     * GET left (its answer may predate the write).
     */
    overlay(events: CalendarEvent[], t: number): CalendarEvent[] {
      if (!intents.size) return events;
      let changed = false;
      const next = events.map((e) => {
        const st = intents.get(e.id);
        if (!st || (st.settledAt && st.settledAt < t)) return e;
        if (!!e.hidden === st.desired) return e;
        changed = true;
        return { ...e, hidden: st.desired };
      });
      return changed ? next : events;
    },

    reset(): void {
      intents.clear();
      fetchesInFlight.clear();
      clock = 0;
    },
  };
}
