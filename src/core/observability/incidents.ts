/**
 * Forensic Observability — incident store + notification sink.
 *
 * An incident is a first-class "problem case file": when an invariant fires on a
 * completed turn, we open a durable Incident (the sid it concerns + the auto
 * label + an evidence bundle path + status) and notify the user. Persisting them
 * means incidents accumulate into a corpus we can later mine for triggers
 * ("7/8 truncations were opus-4-8 + remote") instead of evaporating with the logs.
 *
 * recorder.ts owns the hot path and the IncidentSink contract; this module
 * implements the sink (via initIncidentSink → registerIncidentSink) and the CRUD
 * over WALNUT_HOME/incidents.json. The sink is fire-and-forget: every async step
 * is wrapped so a slow disk / missing bundle module never affects turn completion.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from '../../constants.js';
import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import { registerIncidentSink } from './recorder.js';
import type { Incident, IncidentStatus, InvariantViolation, TurnEvent } from './types.js';

/**
 * incidents.json lives under LOG_DIR (/tmp/open-walnut), next to the evidence
 * bundles it indexes — NOT under WALNUT_HOME (git-sync commits that every 30s).
 * The index and its bundles are ephemeral forensic state; keeping them together
 * in /tmp avoids dangling bundlePath refs and keeps them out of version control.
 */
const INCIDENTS_FILE = path.join(LOG_DIR, 'incidents.json');
/** Keep the store bounded — most-recent N. Older incidents drop off the tail. */
const MAX_INCIDENTS = 200;
/** Don't open a second incident for the same sid+rule within this window. */
const DEDUPE_WINDOW_MS = 5 * 60_000;

interface IncidentsStore {
  version: 1;
  incidents: Incident[];
}

// ── In-process write lock (same pattern as frequent-dirs.ts / session-tracker) ──

let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let release: () => void;
  writeLock = new Promise<void>(r => { release = r; });
  return prev.then(fn).finally(() => release!());
}

// ── Read / Write ──

function readStore(): IncidentsStore {
  try {
    if (!fs.existsSync(INCIDENTS_FILE)) return { version: 1, incidents: [] };
    const parsed = JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf-8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed?.incidents)) return { version: 1, incidents: [] };
    return parsed as IncidentsStore;
  } catch (err) {
    log.obs.warn('incidents: failed to read store', { error: errMsg(err) });
    return { version: 1, incidents: [] };
  }
}

function writeStore(store: IncidentsStore): void {
  // Cap to most-recent MAX_INCIDENTS (incidents are appended, so the tail is newest).
  if (store.incidents.length > MAX_INCIDENTS) {
    store.incidents = store.incidents.slice(-MAX_INCIDENTS);
  }
  fs.mkdirSync(path.dirname(INCIDENTS_FILE), { recursive: true });
  fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(store, null, 2));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `inc-<epochms>-<rand>` — mirrors the qm- id style in session-message-queue.ts. */
function generateIncidentId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `inc-${ts}-${rand}`;
}

// ── Public CRUD ──

/** All incidents, newest-last (insertion order). */
export async function listIncidents(): Promise<Incident[]> {
  return withWriteLock(async () => readStore().incidents);
}

/** One incident by id, or null. */
export async function getIncident(id: string): Promise<Incident | null> {
  return withWriteLock(async () => readStore().incidents.find(i => i.id === id) ?? null);
}

/**
 * Create + persist an incident from a partial. `id`/`createdAt`/`updatedAt`/
 * `status` are stamped here unless the caller supplied them.
 */
export async function createIncident(
  partial: Omit<Incident, 'id' | 'createdAt' | 'updatedAt' | 'status'> & Partial<Pick<Incident, 'id' | 'status'>>,
): Promise<Incident> {
  return withWriteLock(async () => {
    const now = Date.now();
    const incident: Incident = {
      id: partial.id ?? generateIncidentId(),
      status: partial.status ?? 'open',
      createdAt: now,
      updatedAt: now,
      ...partial,
    } as Incident;
    const store = readStore();
    store.incidents.push(incident);
    writeStore(store);
    return incident;
  });
}

/** Update an incident's lifecycle status; returns the updated incident or null. */
export async function updateIncidentStatus(id: string, status: IncidentStatus): Promise<Incident | null> {
  return withWriteLock(async () => {
    const store = readStore();
    const incident = store.incidents.find(i => i.id === id);
    if (!incident) return null;
    incident.status = status;
    incident.updatedAt = Date.now();
    writeStore(store);
    return incident;
  });
}

/** Set the captured bundle path on an incident (called once capture finishes). */
async function setIncidentBundlePath(id: string, bundlePath: string): Promise<void> {
  await withWriteLock(async () => {
    const store = readStore();
    const incident = store.incidents.find(i => i.id === id);
    if (!incident) return;
    incident.bundlePath = bundlePath;
    incident.updatedAt = Date.now();
    writeStore(store);
  });
}

/**
 * Atomically: open an incident UNLESS one for the same sid+rule already opened
 * within the dedupe window — returns the new incident, or null if deduped. The
 * check + insert share a single writeLock critical section so two near-simultaneous
 * violations of the same sid+rule can't both slip past the check and double-open.
 * Guards against notification spam from a flapping session.
 */
async function createIncidentIfNotRecent(
  partial: Omit<Incident, 'id' | 'createdAt' | 'updatedAt' | 'status'>,
): Promise<Incident | null> {
  return withWriteLock(async () => {
    const now = Date.now();
    const store = readStore();
    const recent = store.incidents.some(
      i => i.sessionId === partial.sessionId && i.label === partial.label && now - i.createdAt < DEDUPE_WINDOW_MS,
    );
    if (recent) return null;
    const incident: Incident = { id: generateIncidentId(), status: 'open', createdAt: now, updatedAt: now, ...partial };
    store.incidents.push(incident);
    writeStore(store);
    return incident;
  });
}

// ── The sink (wired into recorder at startup) ──

/**
 * Register the incident sink. recorder.recordTurn() calls it synchronously on a
 * violation; we MUST NOT throw or block, so all the async work (dedupe check,
 * persist, notify, bundle capture) runs in a fire-and-forget promise chain whose
 * top level is .catch'd. A failure here never affects turn completion.
 */
export function initIncidentSink(): void {
  registerIncidentSink((turn: TurnEvent, violations: InvariantViolation[]) => {
    void handleViolation(turn, violations).catch(err => {
      log.obs.warn('incident sink handler failed', { sessionId: turn.sessionId, error: errMsg(err) });
    });
  });
  log.obs.info('incident sink initialized');
}

async function handleViolation(turn: TurnEvent, violations: InvariantViolation[]): Promise<void> {
  if (violations.length === 0) return;
  // label/summary come from the FIRST violation; severity is the worst across all.
  const primary = violations[0];
  const severity = violations.some(v => v.severity === 'error') ? 'error' : 'warn';

  // De-dupe + create atomically. null = a recent same sid+rule incident exists.
  const incident = await createIncidentIfNotRecent({
    sessionId: turn.sessionId,
    taskId: turn.taskId,
    trigger: 'invariant',
    label: primary.ruleId,
    summary: primary.reason,
    severity,
    violations,
    turn,
  });
  if (!incident) {
    log.obs.debug('incident deduped (recent same sid+rule)', { sessionId: turn.sessionId, ruleId: primary.ruleId });
    return;
  }

  log.obs.info('incident opened', {
    incidentId: incident.id,
    sessionId: turn.sessionId,
    label: incident.label,
    severity,
  });

  // Notify (push-notifications subscriber reads jobName + text; action satisfies
  // the CronJobEvent type). No-op when WS clients are connected — see push-notification.ts.
  try {
    bus.emit(
      EventNames.CRON_NOTIFICATION,
      { action: 'notification', jobName: 'forensic', text: incident.summary },
      ['push-notifications'],
    );
  } catch (err) {
    log.obs.warn('incident notification emit failed', { incidentId: incident.id, error: errMsg(err) });
  }

  // Capture an evidence bundle. Imported lazily so a missing/in-progress bundle
  // module can't break the store; the agreed signature is
  // captureBundle(sessionId, { windowMins? }): Promise<string>.
  try {
    const { captureBundle } = await import('./bundle.js');
    const bundlePath = await captureBundle(turn.sessionId);
    await setIncidentBundlePath(incident.id, bundlePath);
    log.obs.info('incident bundle captured', { incidentId: incident.id, bundlePath });
  } catch (err) {
    log.obs.warn('incident bundle capture failed', { incidentId: incident.id, error: errMsg(err) });
  }
}
