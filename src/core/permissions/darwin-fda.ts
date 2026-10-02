/**
 * Full Disk Access in the Permission Doctor: ONE row, ONE grant, for every feature.
 *
 * Every protected read goes through src/core/protected-reader.ts, so the program to
 * grant is whichever one it runs:
 *
 *   - Walnut.app, when it knows `--reader-bridge`. Sessions run as Walnut too
 *     (`Walnut --session-host`), so the same grant also stops the "would like to
 *     access data from other apps" popups there. The session row folds into this
 *     one and System Settings shows Walnut, once.
 *   - the walnut-reader helper otherwise. It is its own program to macOS, so the
 *     session row (Walnut) stays separate: merging two different programs into one
 *     row would tell the user to grant one thing while two need it.
 *
 * What this row must never be: a probe of the server process. TCC judges whoever is
 * actually reading, and on a scripted install that is `/opt/homebrew/bin/node` out
 * of a staged temp directory, while an older row told the user to add
 * `/Applications/Walnut.app`, a different program. The row stayed red no matter how
 * many times they granted.
 *
 * Only probed when some feature needs it. With none switched on there is nothing
 * to read and nothing to check: the row is then the optional session setup step, or
 * hidden when the helper would be the program. Probing would also pay a first-run
 * swiftc compile for nothing.
 */
import { log } from '../../logging/index.js';
import {
  EXIT_NO_PERMISSION,
  readerGrantApp,
  readerStandIn,
  routeEverSucceeded,
  runProtectedReader,
  type ReaderRoute,
} from '../protected-reader.js';
import type { Config } from '../types.js';
import { fullDiskAccessUses } from './fda-uses.js';
import type { FdaProbe } from './fda-rows.js';

export { fullDiskAccessRows, type FdaProbe } from './fda-rows.js';

interface CoreConsumer {
  /** Completes "Lets Walnut …", so the row always says what the grant buys. */
  readonly reason: string;
  readonly enabled: (config: Config) => boolean;
}

/** Every core feature that reads through the reader. Adding one is a line here
 *  (plugins use walnut.macos.useFullDiskAccess); it must NOT grow a second row. */
const CORE_CONSUMERS: readonly CoreConsumer[] = [
  {
    reason:
      'read Apple Screen Time, including the numbers your iPhone syncs to this Mac, and keep '
      + 'them permanently (Apple deletes its own copy after a few weeks)',
    enabled: (config) => config.time?.screentime?.enabled === true,
  },
];

/**
 * Each use names a file it reads, and the row is judged on all of them together:
 *
 *   - one read works through the current route   → granted. A use whose file is
 *     still refused then has a wall of its own, NOT a missing grant. Measured on
 *     macOS 26: Walnut holds Full Disk Access (tccd answers SystemPolicyAllFiles
 *     "allowed") and reads ~/Library/DoNotDisturb, while the Screen Time store
 *     refuses even an MDM agent that holds the same grant. Judging by Screen Time
 *     alone sent the user to add a program that was already added.
 *   - only the stand-in can read                  → denied, working via the helper.
 *   - something was refused and nothing worked    → denied (stale if the route has
 *     worked here before).
 *   - nothing refused, nothing read (no file yet) → granted: not a grant problem,
 *     so it must not send the user to System Settings.
 */
export async function probeFullDiskAccess(): Promise<FdaProbe> {
  const app = await readerGrantApp();
  const base: FdaProbe = {
    state: 'unknown',
    target: app ?? 'walnut-reader',
    walnutReads: app !== null,
    stale: false,
    reasons: [],
    screenTime: false,
    standIn: null,
  };
  try {
    const { getConfig } = await import('../config-manager.js');
    const config = await getConfig();
    base.screenTime = CORE_CONSUMERS[0]!.enabled(config);
    base.reasons = CORE_CONSUMERS.filter((c) => c.enabled(config)).map((c) => c.reason);
  } catch {
    return base; // an unreadable config tells us nothing about the grant
  }
  const declared = fullDiskAccessUses();
  base.reasons.push(...new Set(declared.map((u) => u.reason)));
  if (base.reasons.length === 0) return { ...base, state: 'not-applicable' };

  try {
    const probes: string[] = [];
    if (base.screenTime) {
      const { screenTimeStorePath } = await import('../time-tracking/screentime-reader.js');
      probes.push(await screenTimeStorePath());
    }
    for (const use of declared) if (use.probe && !probes.includes(use.probe)) probes.push(use.probe);

    let route: ReaderRoute | null = null;
    let worked = false;
    let workedViaStandIn = false;
    let refused = false;
    let answered = false;
    for (const file of probes) {
      // preferCurrent: the fix dialog polls this, and a fresh grant to Walnut has to
      // turn the row green on the next tick, not after the stand-in's minute.
      const probe = await runProtectedReader('probe', file, { preferCurrent: true });
      if (!probe.route) return base;
      route = probe.route;
      if (probe.code === 0 && !probe.viaStandIn) {
        worked = true;
        break;
      }
      if (probe.code === 0) workedViaStandIn = true;
      else if (probe.code === EXIT_NO_PERMISSION) refused = true;
      if (probe.code !== null) answered = true;
    }
    if (!route) return base;
    const found = { ...base, target: route.grantTarget, walnutReads: route.kind === 'app' };
    if (worked) return { ...found, state: 'granted' };
    if (workedViaStandIn) return { ...found, state: 'denied', standIn: readerStandIn() };
    if (refused) return { ...found, state: 'denied', stale: await routeEverSucceeded(route.kind) };
    return answered ? { ...found, state: 'granted' } : found;
  } catch (err) {
    log.web.warn('full disk access probe inconclusive', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...base, state: 'unknown' };
  }
}
