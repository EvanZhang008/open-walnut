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

function createCronServiceState(deps: CronServiceDeps): CronServiceState {
  return {
    deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
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
}
