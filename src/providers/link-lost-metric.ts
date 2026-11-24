/**
 * The one place a host link's loss is counted for the health monitor's "Host link keeps
 * dropping" alarm (`host.link.lost`, core/health-monitor/alarms.ts).
 *
 * A link this server closes on its own way out is not lost: a deploy or an update stops the
 * server, and on the Mac the server's in-process daemon holds the host network (walnut-net), so
 * every host it reaches went down with it, each recorded as a loss while the old server still ran.
 * 2026-11-24: about one loss an hour per host from deploys alone, on a day with six deploys an
 * hour; with a flaky home link on top, home-pc read as broken. Such a close is logged and left
 * out of the count; the next server's links start fresh.
 */
import { count } from '../core/observability/metrics.js'
import { isServerStopping } from '../core/server-stopping.js'

export const LINK_LOST_METRIC = 'host.link.lost'

/** Why a loss is not counted ('server-stopping'), or null when it was counted. */
export function countLinkLost(host: string): 'server-stopping' | null {
  if (isServerStopping()) return 'server-stopping'
  count(LINK_LOST_METRIC, 1, { host })
  return null
}
