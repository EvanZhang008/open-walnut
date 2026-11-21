/**
 * The weekly restore drill (restore-drill.ts), only while the experiment
 * `restore_drill` is on, on the server that makes the backups (server.ts starts it
 * beside the backup scheduler).
 *
 * With the flag off it holds no timer: the one subscription it keeps is
 * `config:changed`, read again at each one to start or stop the timer (the way
 * topics-runtime.ts follows its flag). With it on, it checks every hour and runs a
 * drill when backups are set up and the last drill is a week old (or there is none).
 * A drill is one backup job ('restore', jobs.ts), so it never overlaps a backup or a
 * restore of this server, and it waits a check when a terminal's backup holds the lock.
 * A failed drill is a Walnut Health notice (no needsYou: not a popup); the next drill
 * that passes retires it.
 */
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { getConfig } from '../config-manager.js';
import { experimentalEnabled } from '../experimental.js';
import { isBackupConfigured } from './backup-scheduler.js';
import { currentBackupJob, runBackupJob } from './jobs.js';
import { backupLockHeld } from './local-state.js';
import { readDrillRecord, runRestoreDrill, writeDrillRecord, type DrillResult } from './restore-drill.js';
import type { BackupConfig } from './types.js';

const SUBSCRIBER = 'restore-drill-runtime';
export const DRILL_EVERY_MS = 7 * 24 * 3_600_000;
const CHECK_EVERY_MS = 3_600_000;
/** The first check after a start waits this long: a drill never adds to a boot's load. */
const FIRST_CHECK_MS = 10 * 60_000;

export interface DrillRuntimeDeps {
  dataDir?: string;
  /** The flag is on (Settings, Experimental). */
  isOn?: () => Promise<boolean>;
  backupConfig?: () => Promise<BackupConfig | undefined>;
  run?: (cfg: BackupConfig, dataDir: string) => Promise<DrillResult>;
  notify: (n: { title: string; body: string; dedupScope: string; recoveryKey: string }) => Promise<boolean>;
  onRecovered?: () => void;
  now?: () => number;
  firstCheckMs?: number;
  checkEveryMs?: number;
  /** Tests: no config:changed subscription (they call reconcile). */
  subscribe?: boolean;
}

export interface DrillRuntime {
  stop(): void;
  /** Read the flag again and arm or clear the timer; resolves when settled. */
  reconcile(): Promise<void>;
  /** A timer is armed now (false whenever the flag is off). */
  armed(): boolean;
  /** One check now, as the timer would (tests). */
  check(): Promise<DrillResult | null>;
}

export const DRILL_NOTICE_SCOPE = 'backup:drill';
export const DRILL_RECOVERY_KEY = 'backup-drill';

export function failureSummary(r: DrillResult): string {
  if (r.error) return r.error;
  return r.checks.filter((c) => c.ok === false).map((c) => `${c.id}: ${c.problems?.[0] ?? c.detail}`).join('; ');
}

export function startRestoreDrillRuntime(deps: DrillRuntimeDeps): DrillRuntime {
  const dataDir = deps.dataDir ?? WALNUT_HOME;
  const now = deps.now ?? Date.now;
  const isOn = deps.isOn ?? (async () => experimentalEnabled((await getConfig()).experimental, 'restore_drill'));
  const backupConfig = deps.backupConfig ?? (async () => (await getConfig()).backup);
  const run = deps.run ?? ((cfg: BackupConfig, dir: string) => runRestoreDrill({ cfg, dataDir: dir }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();

  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void check().finally(() => { if (!stopped && armedWanted) arm(deps.checkEveryMs ?? CHECK_EVERY_MS); }); }, ms);
    timer.unref?.();
  };
  let armedWanted = false;

  const check = async (): Promise<DrillResult | null> => {
    try {
      if (!(await isOn())) return null;
      const cfg = await backupConfig();
      if (!cfg?.destination?.type || !(await isBackupConfigured(cfg, dataDir))) return null;
      const last = await readDrillRecord(dataDir);
      if (last && now() - Date.parse(last.at) < DRILL_EVERY_MS) return null;
      // A backup or restore runs (here or in a terminal): its prune must not race the drill's reads.
      if (currentBackupJob() !== null || (await backupLockHeld(dataDir))) return null;
      const result = await runBackupJob('restore', () => run(cfg, dataDir));
      await writeDrillRecord(dataDir, result);
      if (!result.ok) {
        await deps.notify({
          title: 'Restore drill failed',
          body: `The newest backup did not pass its restore drill: ${failureSummary(result)}`,
          dedupScope: DRILL_NOTICE_SCOPE,
          recoveryKey: DRILL_RECOVERY_KEY,
        });
      } else if (last && !last.ok) {
        deps.onRecovered?.();
      }
      return result;
    } catch (err) {
      log.session.warn('backup: restore drill check failed', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  const reconcile = (): Promise<void> => {
    chain = chain.then(async () => {
      if (stopped) return;
      const on = await isOn().catch(() => false);
      if (on && !armedWanted) {
        armedWanted = true;
        arm(deps.firstCheckMs ?? FIRST_CHECK_MS);
        log.session.info('backup: restore drill scheduled (experiment on)');
      } else if (!on && armedWanted) {
        armedWanted = false;
        if (timer) clearTimeout(timer);
        timer = null;
        log.session.info('backup: restore drill stopped (experiment off)');
      }
    });
    return chain;
  };

  void reconcile();
  if (deps.subscribe !== false) {
    void import('../event-bus.js').then(({ bus }) => {
      if (stopped) return;
      bus.subscribe(SUBSCRIBER, () => { void reconcile(); }, { global: true, interest: ['config:changed'] });
    });
  }

  return {
    reconcile,
    armed: () => timer !== null,
    check,
    stop() {
      stopped = true;
      armedWanted = false;
      if (timer) clearTimeout(timer);
      timer = null;
      void import('../event-bus.js').then(({ bus }) => bus.unsubscribe(SUBSCRIBER)).catch(() => {});
    },
  };
}
