/**
 * Executor ↔ legacy-field compatibility.
 *
 * v2 jobs carry an `executor` ref (routines layer); v1 jobs only have
 * sessionTarget/payload. Both directions must stay derivable so:
 *   - old stores migrate losslessly (legacy → executor),
 *   - executor-shaped input still produces valid legacy fields (old binaries,
 *     assertSupportedJobSpec, and the announce path keep working),
 *   - legacy-shaped input (Personal AI tools, old REST clients) gains an executor.
 *
 * Lives in the cron layer (not ../routines/) so store/jobs/normalize can use it
 * without a circular import. Executor types are plain strings here by design.
 */

import type {
  CronJob,
  CronDelivery,
  CronPayload,
  CronSessionTarget,
  RoutineExecutorRef,
} from './types.js';

type LegacyFields = {
  sessionTarget: CronSessionTarget;
  payload: CronPayload;
  delivery?: CronDelivery;
};

/** Extract the instructions text an executor should run. */
export function executorInstructions(executor: RoutineExecutorRef): string {
  const raw = executor.config?.instructions;
  return typeof raw === 'string' ? raw : '';
}

/**
 * Legacy → executor. Used by the store migration and by normalize when input
 * arrives in the old sessionTarget/payload shape.
 */
export function deriveExecutorFromLegacy(
  job: Pick<CronJob, 'sessionTarget' | 'payload' | 'delivery'>,
): RoutineExecutorRef {
  if (job.sessionTarget === 'main') {
    return {
      type: 'main-agent',
      config: {
        instructions: job.payload.kind === 'systemEvent' ? job.payload.text : (job.payload as { message?: string }).message ?? '',
      },
    };
  }
  const config: Record<string, unknown> = {
    instructions: job.payload.kind === 'agentTurn' ? job.payload.message : (job.payload as { text?: string }).text ?? '',
  };
  if (job.payload.kind === 'agentTurn' && typeof job.payload.timeoutSeconds === 'number') {
    config.timeoutSeconds = job.payload.timeoutSeconds;
  }
  return { type: 'walnut-agent', config };
}

/**
 * Executor → legacy. main-agent maps to main/systemEvent; everything else
 * (walnut-agent, claude-code, future types) maps to isolated/agentTurn — a
 * safe degradation: an old binary would run the instructions as an isolated
 * agent turn instead of failing.
 */
export function deriveLegacyFromExecutor(executor: RoutineExecutorRef): LegacyFields {
  const instructions = executorInstructions(executor);
  if (executor.type === 'main-agent') {
    return {
      sessionTarget: 'main',
      payload: { kind: 'systemEvent', text: instructions },
    };
  }
  const payload: CronPayload = { kind: 'agentTurn', message: instructions };
  const timeout = executor.config?.timeoutSeconds;
  if (typeof timeout === 'number' && Number.isFinite(timeout)) {
    payload.timeoutSeconds = Math.max(1, Math.floor(timeout));
  }
  return { sessionTarget: 'isolated', payload };
}

/**
 * Ensure a job carries a consistent executor + legacy pair. Executor wins when
 * both are present (it's the canonical v2 field); legacy fields are rewritten
 * to match. Jobs without an executor get one derived from legacy fields.
 * Returns true if the job was mutated (caller decides whether to persist).
 */
export function syncExecutorFields(job: CronJob): boolean {
  if (job.executor && typeof job.executor.type === 'string' && job.executor.config) {
    const legacy = deriveLegacyFromExecutor(job.executor);
    const changed =
      job.sessionTarget !== legacy.sessionTarget ||
      JSON.stringify(job.payload) !== JSON.stringify(legacy.payload);
    if (changed) {
      job.sessionTarget = legacy.sessionTarget;
      job.payload = legacy.payload;
    }
    // main-agent jobs never carry delivery (mirrors applyJobPatch's rule)
    if (job.executor.type === 'main-agent' && job.delivery) {
      job.delivery = undefined;
      return true;
    }
    return changed;
  }
  job.executor = deriveExecutorFromLegacy(job);
  return true;
}
