/**
 * CronService — thin facade wrapping ops, adapted from moltbot/src/cron/service.ts
 *
 * The class holds internal state and delegates to pure-function operations.
 * Consumers interact with this class; they never touch state or ops directly.
 */

import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronServiceDeps,
  CronServiceState,
  CronStatusSummary,
} from './types.js';
import * as ops from './ops.js';
import {
  applyTriggerChecked,
  applyTriggerFired,
  type TriggerCheckedApplied,
  type TriggerFiredApplied,
} from './trigger-apply.js';
import type { TriggerCheckedEvent, TriggerFiredEvent } from '../../providers/trigger-check-core.js';

function createCronServiceState(deps: CronServiceDeps): CronServiceState {
  return {
    deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    replayGuard: new Map(),
  };
}

export class CronService {
  private readonly state: CronServiceState;

  constructor(deps: CronServiceDeps) {
    this.state = createCronServiceState(deps);
  }

  async start(): Promise<void> {
    await ops.start(this.state);
  }

  stop(): void {
    ops.stop(this.state);
  }

  async status(): Promise<CronStatusSummary> {
    return await ops.status(this.state);
  }

  async list(opts?: { includeDisabled?: boolean }): Promise<CronJob[]> {
    return await ops.list(this.state, opts);
  }

  async add(input: CronJobCreate): Promise<CronJob> {
    return await ops.add(this.state, input);
  }

  async update(id: string, patch: CronJobPatch): Promise<CronJob> {
    return await ops.update(this.state, id, patch);
  }

  async remove(id: string): Promise<{ ok: boolean; removed: boolean }> {
    return await ops.remove(this.state, id);
  }

  async toggle(id: string): Promise<CronJob> {
    return await ops.toggle(this.state, id);
  }

  async run(id: string, mode?: 'due' | 'force') {
    return await ops.run(this.state, id, mode);
  }

  /**
   * wake: add counted events to a routine's counter. The subscription that feeds
   * this lives in the routines layer (core/routines/wake-events.ts) — the engine
   * only owns the number and whether it reached the threshold.
   */
  async bumpWake(id: string, n: number): Promise<ops.WakeBumpResult | null> {
    return await ops.bumpWake(this.state, id, n);
  }

  /**
   * walnut-trigger: fold a daemon's `trigger.checked` / `trigger.fired` event
   * into this store. Only the store bookkeeping lives here; the routines layer
   * (core/routines/trigger-events.ts) owns the envelope, the executor call, the
   * notification and the ack.
   */
  async applyTriggerChecked(event: TriggerCheckedEvent): Promise<TriggerCheckedApplied> {
    return await applyTriggerChecked(this.state, event);
  }

  async applyTriggerFired(
    event: TriggerFiredEvent,
    deliver: (job: CronJob) => Promise<{ status: 'ok' | 'error'; summary?: string; error?: string }>,
  ): Promise<TriggerFiredApplied> {
    return await applyTriggerFired(this.state, event, deliver);
  }

  /**
   * Expose the injected deps so the routines executor registry can reuse the
   * same closures (notification/announce/isolated-run) without re-wiring them.
   */
  getDeps(): CronServiceState['deps'] {
    return this.state.deps;
  }
}
