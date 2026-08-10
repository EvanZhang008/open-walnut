/**
 * Mode pill "dead button" regression (2026-08-09).
 *
 * Symptom: clicking the session mode pill appeared to do nothing and the label
 * locked on "Default" — while the PATCH returned 200 and the server persisted
 * the new mode. The server was right; the CLIENT threw the truth away.
 *
 * Cause: isSessionMode() in session-status-store.ts hardcoded the OLD four
 * modes. A WS status snapshot carrying `auto`/`dontAsk` failed validation, the
 * `?? 'default'` fallbacks coerced it, and resolveSessionRecordStatus() — which
 * OVERWRITES record.mode from the store — then stomped the component's
 * optimistic state on the next status push. Every later click cycled from a
 * wrong 'default' anchor.
 *
 * Lesson: a validator that silently downgrades is worse than one that throws.
 * Derive it from the registry, never from a hand-listed union.
 */
import { describe, it, expect } from 'vitest';
import { sessionStatusStore, resolveSessionRecordStatus } from '../../web/src/stores/session-status-store';
import { SESSION_MODE_IDS } from '../../src/core/types.js';

const snap = (sessionId: string, mode: string, rev = 1) => ({
  status: {
    sessionId, taskId: 'task-1', process_status: 'running', activity: null, mode,
    planCompleted: false, archived: false, errorMessage: null,
    provider: 'cli', engine: 'claude', statusRevision: rev,
    statusUpdatedAt: '2026-08-09T00:00:00.000Z',
  },
});
const rec = (sessionId: string, mode: string) => ({
  claudeSessionId: sessionId, taskId: 'task-1', project: '', process_status: 'running',
  mode, startedAt: 'x', lastActiveAt: 'x', messageCount: 0,
}) as any;


describe('session-status-store keeps every registry mode', () => {
  for (const mode of SESSION_MODE_IDS) {
    it(`round-trips mode='${mode}'`, () => {
      sessionStatusStore.clearForTesting();
      const sid = `00000000-0000-4000-8000-00000000000${SESSION_MODE_IDS.indexOf(mode)}`;
      const res = sessionStatusStore.ingestStatusEvent(snap(sid, mode));
      expect(res).not.toBe('rejected-invalid');
      expect(resolveSessionRecordStatus(rec(sid, mode)).mode).toBe(mode);
    });
  }
});
