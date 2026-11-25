/**
 * Every test starts with none of the host memory an earlier test left in this process:
 *   - no host outage told (src/logging/outage-repeat.ts). The logger writes a warn/error that
 *     only repeats a host's link-down at info once the first of its kind was told, and that
 *     memory is process-wide. Without this, a test that logs "Connection to devbox failed 0s ago"
 *     would quiet the same line in the next test of the worker, and a card or tap that test
 *     expects would never come;
 *   - no update gap state of a host (src/providers/daemon-update-gap.ts hostUpdateGap): a build
 *     one test asked for, or held, would be asked for or held in the next test of the same host.
 * Cleared through the same globalThis keys, so this file imports nothing of the app.
 */
import { beforeEach } from 'vitest'

beforeEach(() => {
  const g = globalThis as { [k: symbol]: Map<string, unknown> | undefined }
  g[Symbol.for('open-walnut.outageRepeats')]?.clear()
  g[Symbol.for('open-walnut.hostUpdateGaps')]?.clear()
})
