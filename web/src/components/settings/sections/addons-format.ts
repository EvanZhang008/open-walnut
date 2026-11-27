/**
 * Pure helpers for the add-on and machine panes (Calendar, Plugins, Devices,
 * Remote Hosts). No React, no fetch: unit tested in
 * tests/web/settings-addons-format.test.ts.
 */

import { lineStart, pointInTime } from '@/utils/time'

/** `Today 11:44 PM, 212 events cached` (the Calendar `Last refreshed` help). */
export function formatLastRefreshed(lastRefresh: string | undefined, eventCount: number | undefined, now?: Date): string {
  const count = eventCount ?? 0
  const events = `${count} ${count === 1 ? 'event' : 'events'} cached`
  if (!lastRefresh) return `Not refreshed yet, ${events}`
  return `${lineStart(pointInTime(lastRefresh, { now: now?.getTime() }))}, ${events}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i

/** A calendar title a person can read: empty or id-looking titles become `Untitled calendar`. */
export function calendarDisplayName(title: string | undefined | null): { name: string; untitled: boolean } {
  const t = (title ?? '').trim()
  if (!t || UUID_RE.test(t) || LONG_HEX_RE.test(t)) return { name: 'Untitled calendar', untitled: true }
  return { name: t, untitled: false }
}

/** `3 of 21 shown` for one account group. */
export function shownCount(ids: readonly string[], hidden: ReadonlySet<string>): string {
  const shown = ids.filter((id) => !hidden.has(id)).length
  return `${shown} of ${ids.length} shown`
}

/** Full hidden list after showing or hiding every calendar of one account. */
export function hiddenAfterBulk(
  allIds: readonly string[],
  hidden: ReadonlySet<string>,
  accountIds: readonly string[],
  hide: boolean,
): string[] {
  const account = new Set(accountIds)
  return allIds.filter((id) => (account.has(id) ? hide : hidden.has(id)))
}

/** Full hidden list after toggling one calendar. */
export function hiddenAfterToggle(allIds: readonly string[], hidden: ReadonlySet<string>, id: string, hide: boolean): string[] {
  return allIds.filter((c) => (c === id ? hide : hidden.has(c)))
}

export type QueueResult<T> = { ok: true; value: T } | { ok: false; value: T; error: unknown }

/**
 * At most one write in flight. A push while one is in flight only records the
 * latest target; when the flight lands, the latest target is sent once more
 * (last one wins), so two quick edits can never land out of order.
 * `onSettled` fires only when the queue drains, with the last write's result.
 */
export class LatestWriteQueue<T> {
  private inFlight = false
  private next: { value: T } | null = null

  constructor(
    private readonly send: (value: T) => Promise<unknown>,
    private readonly onSettled: (result: QueueResult<T>) => void,
  ) {}

  get busy(): boolean {
    return this.inFlight
  }

  push(value: T): void {
    if (this.inFlight) {
      this.next = { value }
      return
    }
    this.run(value)
  }

  private run(value: T): void {
    this.inFlight = true
    let p: Promise<unknown>
    try {
      p = this.send(value)
    } catch (error) {
      p = Promise.reject(error)
    }
    p.then(
      () => this.settle({ ok: true, value }),
      (error: unknown) => this.settle({ ok: false, value, error }),
    )
  }

  private settle(result: QueueResult<T>): void {
    this.inFlight = false
    const pending = this.next
    this.next = null
    if (pending) {
      this.run(pending.value)
      return
    }
    this.onSettled(result)
  }
}
