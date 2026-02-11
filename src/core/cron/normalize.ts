/**
 * Input normalization for cron job create/patch — adapted from moltbot/src/cron/normalize.ts
 *
 * Simplified for Walnut: no legacy migrations, no agentId handling,
 * no channel/to/provider delivery fields, no payload-migration compat.
 *
 * Coerces messy agent/API input into well-typed CronJobCreate or CronJobPatch.
 */

import type { CronJobCreate, CronJobPatch } from './types.js';

type UnknownRecord = Record<string, unknown>;

// ── Type guards ──

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Schedule coercion ──

function coerceSchedule(schedule: UnknownRecord): UnknownRecord {
  const next: UnknownRecord = { ...schedule };

  // Normalize kind
  const rawKind = typeof schedule.kind === 'string' ? schedule.kind.trim().toLowerCase() : '';
  const kind = rawKind === 'at' || rawKind === 'every' || rawKind === 'cron' ? rawKind : undefined;

  if (kind) {
    next.kind = kind;
  } else {
    // Infer kind from available fields
    if (typeof schedule.at === 'string' || typeof schedule.atMs === 'number') {
      next.kind = 'at';
    } else if (typeof schedule.everyMs === 'number') {
      next.kind = 'every';
    } else if (typeof schedule.expr === 'string') {
      next.kind = 'cron';
    }
  }

  // Normalize 'at' field: convert atMs (number) to ISO string
  const atMs = schedule.atMs;
  const atRaw = schedule.at;

  if (typeof atMs === 'number' && Number.isFinite(atMs)) {
    next.at = new Date(atMs).toISOString();
  } else if (typeof atRaw === 'string') {
    const trimmed = atRaw.trim();
    if (trimmed) {
      // Try parsing to validate, but keep original if it's a valid date string
      const parsed = new Date(trimmed).getTime();
      next.at = Number.isFinite(parsed) ? new Date(parsed).toISOString() : trimmed;
    }
  }

  // Clean up: remove atMs (we only store 'at' as ISO string)
  if ('atMs' in next) {
    delete next.atMs;
  }

  return next;
}

// ── Payload coercion ──

function coercePayload(payload: UnknownRecord): UnknownRecord {
  const next: UnknownRecord = { ...payload };

  // Normalize kind
  const kindRaw = typeof next.kind === 'string' ? next.kind.trim().toLowerCase() : '';
  if (kindRaw === 'agentturn') {
    next.kind = 'agentTurn';
  } else if (kindRaw === 'systemevent') {
    next.kind = 'systemEvent';
  } else if (kindRaw) {
    next.kind = kindRaw;
  }

  // Infer kind from available fields if not explicit
  if (!next.kind) {
    const hasMessage = typeof next.message === 'string' && next.message.trim().length > 0;
    const hasText = typeof next.text === 'string' && next.text.trim().length > 0;
    if (hasMessage) {
      next.kind = 'agentTurn';
    } else if (hasText) {
      next.kind = 'systemEvent';
    }
  }

  // Trim string fields
  if (typeof next.message === 'string') {
    const trimmed = next.message.trim();
    if (trimmed) next.message = trimmed;
  }
  if (typeof next.text === 'string') {
    const trimmed = next.text.trim();
    if (trimmed) next.text = trimmed;
  }

  // Validate timeoutSeconds
  if ('timeoutSeconds' in next) {
    if (typeof next.timeoutSeconds === 'number' && Number.isFinite(next.timeoutSeconds)) {
      next.timeoutSeconds = Math.max(1, Math.floor(next.timeoutSeconds));
    } else {
      delete next.timeoutSeconds;
    }
  }

  return next;
}

// ── Delivery coercion ──

function coerceDelivery(delivery: UnknownRecord): UnknownRecord {
  const next: UnknownRecord = { ...delivery };

  if (typeof delivery.mode === 'string') {
    const mode = delivery.mode.trim().toLowerCase();
    if (mode === 'announce' || mode === 'none') {
      next.mode = mode;
    } else if (mode === 'deliver') {
      // Compat: 'deliver' maps to 'announce'
      next.mode = 'announce';
    } else {
      delete next.mode;
    }
  } else if ('mode' in next) {
    delete next.mode;
  }

  if ('bestEffort' in next && typeof next.bestEffort !== 'boolean') {
    delete next.bestEffort;
  }

  return next;
}

// ── Init processor coercion ──

function coerceInitProcessor(raw: UnknownRecord): UnknownRecord | null {
  const actionId = typeof raw.actionId === 'string' ? raw.actionId.trim()
    : typeof raw.action_id === 'string' ? raw.action_id.trim() : '';
  if (!actionId) return null;

  const next: UnknownRecord = { actionId };

  if (isRecord(raw.params)) {
    next.params = raw.params;
  }

  // Boolean coercion for invokeAgent
  const ia = raw.invokeAgent ?? raw.invoke_agent;
  if (typeof ia === 'boolean') {
    next.invokeAgent = ia;
  } else if (typeof ia === 'string') {
    if (ia.toLowerCase() === 'true') next.invokeAgent = true;
    if (ia.toLowerCase() === 'false') next.invokeAgent = false;
  }

  const ta = raw.targetAgent ?? raw.target_agent;
  if (typeof ta === 'string' && ta.trim()) {
    next.targetAgent = ta.trim();
  }

  const tam = raw.targetAgentModel ?? raw.target_agent_model;
  if (typeof tam === 'string' && tam.trim()) {
    next.targetAgentModel = tam.trim();
  }

  const ts = raw.timeoutSeconds ?? raw.timeout_seconds;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    next.timeoutSeconds = Math.max(1, Math.floor(ts));
  }

  return next;
}

// ── Unwrap ──

function unwrapJob(raw: UnknownRecord): UnknownRecord {
  if (isRecord(raw.data)) return raw.data;
  if (isRecord(raw.job)) return raw.job;
  return raw;
}

// ── Field normalizers ──

function normalizeSessionTarget(raw: unknown): 'main' | 'isolated' | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'main' || trimmed === 'isolated') return trimmed;
  return undefined;
}

function normalizeWakeMode(raw: unknown): 'now' | 'next-cycle' | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'now' || trimmed === 'next-cycle') return trimmed;
  return undefined;
}

// ── Name inference ──

function inferName(schedule: UnknownRecord, payload: UnknownRecord): string {
  const payloadKind = typeof payload.kind === 'string' ? payload.kind : '';
  const scheduleKind = typeof schedule.kind === 'string' ? schedule.kind : '';

  // Try to derive a useful name from the payload content
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  const content = text || message;
  if (content) {
    // Use first 40 chars of the content as name
    const truncated = content.length > 40 ? content.slice(0, 40) + '...' : content;
    return truncated;
  }

  // Fallback to schedule-based name
  if (scheduleKind === 'every' && typeof schedule.everyMs === 'number') {
    const mins = Math.round(schedule.everyMs / 60_000);
    return mins >= 1 ? `every ${mins}m ${payloadKind}` : `every ${schedule.everyMs}ms ${payloadKind}`;
  }
  if (scheduleKind === 'cron' && typeof schedule.expr === 'string') {
    return `cron ${schedule.expr} ${payloadKind}`.trim();
  }
  if (scheduleKind === 'at') {
    return `one-shot ${payloadKind}`.trim();
  }

  return `cron job`;
}

// ── Main normalization ──

function normalizeCronJobInput(
  raw: unknown,
  applyDefaults: boolean,
): UnknownRecord | null {
  if (!isRecord(raw)) return null;

  const base = unwrapJob(raw);
  const next: UnknownRecord = { ...base };

  // Boolean coercion for 'enabled'
  if ('enabled' in base) {
    const enabled = base.enabled;
    if (typeof enabled === 'boolean') {
      next.enabled = enabled;
    } else if (typeof enabled === 'string') {
      const trimmed = enabled.trim().toLowerCase();
      if (trimmed === 'true') next.enabled = true;
      if (trimmed === 'false') next.enabled = false;
    }
  }

  // Normalize sessionTarget
  if ('sessionTarget' in base) {
    const normalized = normalizeSessionTarget(base.sessionTarget);
    if (normalized) {
      next.sessionTarget = normalized;
    } else {
      delete next.sessionTarget;
    }
  }

  // Normalize wakeMode
  if ('wakeMode' in base) {
    const normalized = normalizeWakeMode(base.wakeMode);
    if (normalized) {
      next.wakeMode = normalized;
    } else {
      delete next.wakeMode;
    }
  }

  // Coerce schedule
  if (isRecord(base.schedule)) {
    next.schedule = coerceSchedule(base.schedule);
  }

  // Build payload from top-level message/text if no payload object
  if (!('payload' in next) || !isRecord(next.payload)) {
    const message = typeof next.message === 'string' ? next.message.trim() : '';
    const text = typeof next.text === 'string' ? next.text.trim() : '';
    if (message) {
      next.payload = { kind: 'agentTurn', message };
    } else if (text) {
      next.payload = { kind: 'systemEvent', text };
    }
  }

  // Coerce payload if it's a record
  if (isRecord(base.payload)) {
    next.payload = coercePayload(base.payload);
  }

  // Backward compat: lift action payload → initProcessor
  if (isRecord(next.payload) && next.payload.kind === 'action' && !next.initProcessor) {
    const ap = next.payload as UnknownRecord;
    next.initProcessor = coerceInitProcessor({
      actionId: ap.actionId,
      params: ap.params,
      targetAgent: ap.targetAgent,
      targetAgentModel: ap.targetAgentModel,
      timeoutSeconds: ap.timeoutSeconds,
    } as UnknownRecord);
    next.payload = { kind: 'agentTurn', message: '(init processor output)' };
    next.sessionTarget = 'isolated';
  }

  // Coerce initProcessor (also accept snake_case init_processor)
  const rawInitProcessor = base.initProcessor ?? base.init_processor;
  if (isRecord(rawInitProcessor)) {
    const coerced = coerceInitProcessor(rawInitProcessor as UnknownRecord);
    if (coerced) next.initProcessor = coerced;
  } else if (rawInitProcessor === null) {
    next.initProcessor = null;
  }

  // Coerce delivery
  if (isRecord(base.delivery)) {
    next.delivery = coerceDelivery(base.delivery);
  }

  // Copy top-level timeoutSeconds into payload if applicable
  if (isRecord(next.payload) && next.payload.kind === 'agentTurn') {
    if (typeof next.payload.timeoutSeconds !== 'number' && typeof next.timeoutSeconds === 'number') {
      next.payload.timeoutSeconds = next.timeoutSeconds;
    }
  }

  // Clean up top-level shorthand fields that have been absorbed into payload
  delete next.message;
  delete next.text;
  delete next.timeoutSeconds;
  delete next.init_processor;

  // ── Apply defaults (create mode only) ──
  if (applyDefaults) {
    // Default wakeMode
    if (!next.wakeMode) {
      next.wakeMode = 'now';
    }

    // Default enabled
    if (typeof next.enabled !== 'boolean') {
      next.enabled = true;
    }

    // Infer name if missing
    if (
      (typeof next.name !== 'string' || !next.name.trim()) &&
      isRecord(next.schedule) &&
      isRecord(next.payload)
    ) {
      next.name = inferName(
        next.schedule as UnknownRecord,
        next.payload as UnknownRecord,
      );
    } else if (typeof next.name === 'string') {
      const trimmed = next.name.trim();
      if (trimmed) next.name = trimmed;
    }

    // Infer sessionTarget from payload kind
    if (!next.sessionTarget && isRecord(next.payload)) {
      const kind = typeof next.payload.kind === 'string' ? next.payload.kind : '';
      if (kind === 'systemEvent') next.sessionTarget = 'main';
      if (kind === 'agentTurn') next.sessionTarget = 'isolated';
    }

    // Default deleteAfterRun for one-shot jobs
    if (
      isRecord(next.schedule) &&
      next.schedule.kind === 'at' &&
      !('deleteAfterRun' in next)
    ) {
      next.deleteAfterRun = true;
    }

    // Default delivery for isolated agentTurn jobs
    const payload = isRecord(next.payload) ? next.payload : null;
    const payloadKind = payload && typeof payload.kind === 'string' ? payload.kind : '';
    const sessionTarget = typeof next.sessionTarget === 'string' ? next.sessionTarget : '';
    const isIsolatedAgentTurn =
      sessionTarget === 'isolated' || (sessionTarget === '' && payloadKind === 'agentTurn');
    const hasDelivery = 'delivery' in next && next.delivery !== undefined;

    if (!hasDelivery && isIsolatedAgentTurn && payloadKind === 'agentTurn') {
      next.delivery = { mode: 'announce' };
    }
  }

  return next;
}

/**
 * Normalize raw input into a CronJobCreate. Applies defaults (enabled=true,
 * inferred sessionTarget, name, delivery). Returns null if the input is not
 * a valid object.
 */
export function normalizeCronJobCreate(raw: unknown): CronJobCreate | null {
  return normalizeCronJobInput(raw, true) as CronJobCreate | null;
}

/**
 * Normalize raw input into a CronJobPatch. No defaults applied — only coercion
 * of field values. Returns null if the input is not a valid object.
 */
export function normalizeCronJobPatch(raw: unknown): CronJobPatch | null {
  return normalizeCronJobInput(raw, false) as CronJobPatch | null;
}
