/**
 * Edge-case tests for ms-todo's side of the identity contract (2026-08-21).
 *
 * Two surfaces:
 *   1. Plugin hooks — extractRemoteId/extractRemoteIdAliases shape tolerance,
 *      confirmRemoteDeleted's success/404/failure classification.
 *   2. reconcilePulledTasks (delta pull) — [Moved] marker parsing corners and
 *      the deletedMsIds/ledger gate interplay. All Graph I/O mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestPluginApi } from '../core/plugin-test-utils.js';
import type { Task } from '../../src/core/types.js';

// ── microsoft-todo.ts module mock (plugin hooks import it lazily) ──

const mockDeleteMsTodoTask = vi.fn();
vi.mock('../../src/integrations/microsoft-todo.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/integrations/microsoft-todo.js')>();
  return {
    ...original,
    autoPushTask: vi.fn(),
    deltaPull: vi.fn(),
    deleteMsTodoTask: (...args: unknown[]) => mockDeleteMsTodoTask(...args),
    registerDeletedMsIds: vi.fn().mockResolvedValue(undefined),
  };
});

import register from '../../src/integrations/ms-todo/index.js';
import { parseMovedMarker } from '../../src/integrations/microsoft-todo.js';

function registeredSync() {
  const { api, collected } = createTestPluginApi(
    { id: 'ms-todo', name: 'Microsoft To-Do' },
    { client_id: 'test-client-id' },
  );
  register(api);
  return collected.sync!;
}

function taskWithExt(ext: Record<string, unknown> | undefined): Task {
  return { id: 't1', title: 'T', source: 'ms-todo', ext } as unknown as Task;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Plugin identity hooks
// ═══════════════════════════════════════════════════════════════════════════

describe('extractRemoteId / extractRemoteIdAliases shape tolerance', () => {
  it('H1: extracts the current id and the previous_ids aliases', () => {
    const sync = registeredSync();
    const task = taskWithExt({ 'ms-todo': { id: 'cur', previous_ids: ['old1', 'old2'] } });
    expect(sync.extractRemoteId!(task)).toBe('cur');
    expect(sync.extractRemoteIdAliases!(task)).toEqual(['old1', 'old2']);
  });

  it('H2: missing ext / missing plugin key / missing previous_ids → empty, never throws', () => {
    const sync = registeredSync();
    expect(sync.extractRemoteIdAliases!(taskWithExt(undefined))).toEqual([]);
    expect(sync.extractRemoteIdAliases!(taskWithExt({}))).toEqual([]);
    expect(sync.extractRemoteIdAliases!(taskWithExt({ 'ms-todo': {} }))).toEqual([]);
  });

  it('H3: previous_ids polluted with non-strings is filtered, not crashed on', () => {
    const sync = registeredSync();
    const task = taskWithExt({ 'ms-todo': { id: 'cur', previous_ids: ['ok', 42, null, undefined, { junk: 1 }] } });
    expect(sync.extractRemoteIdAliases!(task)).toEqual(['ok']);
  });

  it('H4: previous_ids as a non-array (legacy corruption) yields []', () => {
    const sync = registeredSync();
    const task = taskWithExt({ 'ms-todo': { id: 'cur', previous_ids: 'old1' } });
    expect(sync.extractRemoteIdAliases!(task)).toEqual([]);
  });
});

describe('confirmRemoteDeleted classification', () => {
  it('H5: a clean DELETE confirms', async () => {
    const sync = registeredSync();
    mockDeleteMsTodoTask.mockResolvedValueOnce(undefined);
    await expect(sync.confirmRemoteDeleted!('rid', 'list-1')).resolves.toBe(true);
    expect(mockDeleteMsTodoTask).toHaveBeenCalledWith('list-1', 'rid');
  });

  it('H6: a 404 (already gone) confirms', async () => {
    const sync = registeredSync();
    mockDeleteMsTodoTask.mockRejectedValueOnce(
      new Error('Graph API DELETE /todo/lists/L/tasks/rid returned 404: itemNotFound'),
    );
    await expect(sync.confirmRemoteDeleted!('rid', 'list-1')).resolves.toBe(true);
  });

  it('H7: 5xx / network / 429 failures do NOT confirm (retry next tick)', async () => {
    const sync = registeredSync();
    for (const msg of [
      'Graph API DELETE /todo/lists/L/tasks/rid returned 503: serviceUnavailable',
      'Graph API DELETE /todo/lists/L/tasks/rid returned 429: tooManyRequests',
      'fetch failed: ECONNRESET',
    ]) {
      mockDeleteMsTodoTask.mockRejectedValueOnce(new Error(msg));
      await expect(sync.confirmRemoteDeleted!('rid', 'list-1')).resolves.toBe(false);
    }
  });

  it('H8: a 404 embedded in the error BODY (not the status clause) does not false-confirm', async () => {
    // The classifier keys on "returned 404" — a 500 whose body happens to
    // mention 404 must stay unconfirmed.
    const sync = registeredSync();
    mockDeleteMsTodoTask.mockRejectedValueOnce(
      new Error('Graph API DELETE … returned 500: upstream said {"code":404}'),
    );
    await expect(sync.confirmRemoteDeleted!('rid', 'list-1')).resolves.toBe(false);
  });

  it('H9: no recorded list → confirmed vacuously (nothing more we can do), no API call', async () => {
    const sync = registeredSync();
    await expect(sync.confirmRemoteDeleted!('rid', null)).resolves.toBe(true);
    await expect(sync.confirmRemoteDeleted!('rid', undefined)).resolves.toBe(true);
    expect(mockDeleteMsTodoTask).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. [Moved]-marker parsing corners
// ═══════════════════════════════════════════════════════════════════════════

describe('parseMovedMarker corners', () => {
  it('P1: canonical marker parses id', () => {
    expect(parseMovedMarker('[Moved] Fix the thing [open-walnut:mabc1234-ffff]'))
      .toEqual({ taskId: 'mabc1234-ffff' });
  });

  it('P2: marker with truncated id suffix still gates (taskId null)', () => {
    expect(parseMovedMarker('[Moved] Long title that lost its suffix')).toEqual({ taskId: null });
  });

  it('P3: leading whitespace tolerated; mid-title "[Moved]" is NOT a marker', () => {
    expect(parseMovedMarker('  [Moved] padded')).toEqual({ taskId: null });
    expect(parseMovedMarker('Discussing the [Moved] label behavior')).toBeNull();
  });

  it('P4: a user task that merely STARTS with the word Moved is not a marker', () => {
    expect(parseMovedMarker('Moved apartments — update address everywhere')).toBeNull();
  });

  it('P5: empty / whitespace titles are not markers', () => {
    expect(parseMovedMarker('')).toBeNull();
    expect(parseMovedMarker('   ')).toBeNull();
  });
});
