/**
 * Unit tests for the forensic-observability incident store + sink.
 *
 * An incident is the durable "problem case file" opened when an invariant fires.
 * Contract under test:
 *   - createIncident persists to WALNUT_HOME/incidents.json; listIncidents reads it back.
 *   - getIncident by id; updateIncidentStatus mutates status + updatedAt.
 *   - The sink (initIncidentSink → recorder) opens an incident on a violating turn
 *     and DEDUPES a second same-sid+rule violation inside the 5-min window.
 *
 * WALNUT_HOME is redirected to an isolated tmpdir via createMockConstants, so the
 * store file never touches real data. We clean incidents.json between tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
import { removeTempTree } from '../../helpers/temp-home.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, LOG_DIR } from '../../../src/constants.js';
import {
  listIncidents,
  getIncident,
  createIncident,
  updateIncidentStatus,
  initIncidentSink,
} from '../../../src/core/observability/incidents.js';
import { recordTurn, registerIncidentSink } from '../../../src/core/observability/recorder.js';
import type { TurnEvent } from '../../../src/core/observability/types.js';

// incidents.json moved to LOG_DIR (commit 958236a: bundles/index are ephemeral
// forensic state and must stay out of the git-synced WALNUT_HOME).
const INCIDENTS_FILE = path.join(LOG_DIR, 'incidents.json');

/** Poll listIncidents() until `pred` holds or we time out (the sink is async). */
async function pollIncidents(
  pred: (list: Awaited<ReturnType<typeof listIncidents>>) => boolean,
  timeoutMs = 3000,
): Promise<Awaited<ReturnType<typeof listIncidents>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await listIncidents();
    if (pred(list)) return list;
    if (Date.now() > deadline) return list;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function truncatedTurn(sessionId: string): Omit<TurnEvent, 'ts'> {
  return {
    sessionId,
    isError: false,
    subtype: 'success',
    stopReason: null, // the truncation fingerprint
    resultLen: 13,
    deliveryMs: 150,
    deliveryPath: 'stdin',
    teamActive: false,
  };
}

beforeEach(async () => {
  await removeTempTree(WALNUT_HOME);
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await fsp.rm(INCIDENTS_FILE, { force: true });
  // Reset the recorder's module-level sink so cross-test leakage can't fire incidents.
  registerIncidentSink(() => {});
});

afterEach(async () => {
  // Unregister FIRST: the sink is fire-and-forget, so a turn recorded by the
  // test body can still be mid-flight here and would write incidents.json +
  // an evidence bundle back into the tree we are deleting. That resurrection
  // is what produced `ENOTEMPTY: rmdir .../walnut-test-*` (removeTempTree's
  // retries cover the residual window). Verified: 1/6 iterations without this.
  registerIncidentSink(() => {});
  await removeTempTree(WALNUT_HOME);
  await fsp.rm(INCIDENTS_FILE, { force: true });
});

describe('incident CRUD', () => {
  it('createIncident persists and listIncidents returns it', async () => {
    const created = await createIncident({
      sessionId: 'sess-1',
      trigger: 'manual',
      label: 'manual',
      summary: 'a thing happened',
      severity: 'warn',
    });

    expect(created.id).toMatch(/^inc-/);
    expect(created.status).toBe('open'); // stamped default
    expect(created.createdAt).toBeTypeOf('number');
    expect(created.updatedAt).toBeTypeOf('number');

    // Persisted to disk under the isolated WALNUT_HOME.
    expect(fs.existsSync(INCIDENTS_FILE)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf-8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.incidents).toHaveLength(1);
    expect(onDisk.incidents[0].id).toBe(created.id);

    const list = await listIncidents();
    expect(list).toHaveLength(1);
    expect(list[0].summary).toBe('a thing happened');
  });

  it('getIncident returns the incident by id, null for unknown', async () => {
    const created = await createIncident({
      sessionId: 'sess-2',
      trigger: 'invariant',
      label: 'truncated-success',
      summary: 'truncated',
      severity: 'error',
    });

    expect((await getIncident(created.id))?.id).toBe(created.id);
    expect(await getIncident('inc-does-not-exist')).toBeNull();
  });

  it('updateIncidentStatus changes status + bumps updatedAt; null for unknown', async () => {
    const created = await createIncident({
      sessionId: 'sess-3',
      trigger: 'manual',
      label: 'manual',
      summary: 's',
      severity: 'warn',
    });
    const originalUpdatedAt = created.updatedAt;
    await new Promise((r) => setTimeout(r, 5)); // ensure clock advances

    const updated = await updateIncidentStatus(created.id, 'investigating');
    expect(updated?.status).toBe('investigating');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);

    // Persisted.
    expect((await getIncident(created.id))?.status).toBe('investigating');
    // Unknown id → null.
    expect(await updateIncidentStatus('inc-nope', 'resolved')).toBeNull();
  });

  it('listIncidents returns newest-last (insertion order)', async () => {
    await createIncident({ sessionId: 's', trigger: 'manual', label: 'a', summary: 'first', severity: 'warn' });
    await createIncident({ sessionId: 's', trigger: 'manual', label: 'b', summary: 'second', severity: 'warn' });
    const list = await listIncidents();
    expect(list.map((i) => i.summary)).toEqual(['first', 'second']);
  });
});

describe('incident sink (auto-open on violating turn)', () => {
  it('opens an incident when recordTurn sees a truncated success', async () => {
    initIncidentSink();
    recordTurn(truncatedTurn('sess-sink-1'));

    const list = await pollIncidents((l) => l.length >= 1);
    expect(list).toHaveLength(1);
    const inc = list[0];
    expect(inc.sessionId).toBe('sess-sink-1');
    expect(inc.trigger).toBe('invariant');
    expect(inc.label).toBe('truncated-success');
    expect(inc.severity).toBe('error');
    // The opening turn + its violations are snapshotted onto the incident.
    expect(inc.turn?.stopReason).toBeNull();
    expect(inc.violations?.map((v) => v.ruleId)).toContain('truncated-success');
  });

  it('does NOT open an incident for a healthy turn', async () => {
    initIncidentSink();
    recordTurn({ sessionId: 'sess-healthy', subtype: 'success', isError: false, stopReason: 'end_turn', resultLen: 20 });

    // Give the (would-be) async sink a chance, then assert nothing was opened.
    const list = await pollIncidents((l) => l.length >= 1, 400);
    expect(list).toHaveLength(0);
  });

  it('DEDUPES a second same-sid+rule violation within the 5-min window', async () => {
    initIncidentSink();

    recordTurn(truncatedTurn('sess-dedupe'));
    await pollIncidents((l) => l.length >= 1); // first incident lands

    // Second identical violation for the same sid+rule — must be suppressed.
    recordTurn(truncatedTurn('sess-dedupe'));
    // Wait out the async handler, then confirm we still have exactly one.
    await new Promise((r) => setTimeout(r, 400));

    const list = await listIncidents();
    expect(list.filter((i) => i.sessionId === 'sess-dedupe')).toHaveLength(1);
  });

  it('does NOT dedupe across different sessions', async () => {
    initIncidentSink();
    recordTurn(truncatedTurn('sess-A'));
    recordTurn(truncatedTurn('sess-B'));

    const list = await pollIncidents((l) => l.length >= 2);
    expect(list.map((i) => i.sessionId).sort()).toEqual(['sess-A', 'sess-B']);
  });
});
