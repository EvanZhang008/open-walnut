/**
 * The "@" session palette must not show a stale title.
 *
 * The mention index is a module-wide snapshot with a 30s TTL, and a rename had
 * no invalidation path at all: after the session header (or a PATCH response)
 * changed a title, the palette kept offering the OLD one for up to half a
 * minute. Every fetched session record now patches the cached row in place.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
vi.mock('@/api/client', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
}));

import {
  __resetSessionMentionIndex,
  ensureSessionMentionIndex,
  getSessionMentionIndex,
  patchSessionMentionTitle,
  subscribeSessionMentionIndex,
} from '../../web/src/stores/session-mention-index';

const candidate = (id: string, title: string) => ({
  id, title, host: null, status: 'stopped', lastActiveAt: '2026-09-03T00:00:00.000Z',
});

beforeEach(async () => {
  __resetSessionMentionIndex();
  apiGet.mockReset();
  apiGet.mockResolvedValue({
    sessions: [candidate('sess-a', 'Old title'), candidate('sess-b', 'Other session')],
  });
  await ensureSessionMentionIndex();
});

describe('patchSessionMentionTitle', () => {
  it('replaces the cached title and notifies subscribers', () => {
    let notifications = 0;
    const unsubscribe = subscribeSessionMentionIndex(() => { notifications++; });
    try {
      patchSessionMentionTitle('sess-a', 'Renamed in the header');
      expect(getSessionMentionIndex().find((c) => c.id === 'sess-a')?.title)
        .toBe('Renamed in the header');
      expect(notifications).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it('hands out a NEW array and row so a store snapshot re-renders', () => {
    const before = getSessionMentionIndex();
    const beforeRow = before.find((c) => c.id === 'sess-a');
    patchSessionMentionTitle('sess-a', 'Renamed');
    const after = getSessionMentionIndex();
    expect(after).not.toBe(before);
    expect(after.find((c) => c.id === 'sess-a')).not.toBe(beforeRow);
    // Untouched rows keep their identity — no needless re-render work.
    expect(after.find((c) => c.id === 'sess-b')).toBe(before.find((c) => c.id === 'sess-b'));
  });

  it('is a no-op for an unchanged title, an unknown id, or an empty title', () => {
    const before = getSessionMentionIndex();
    let notifications = 0;
    const unsubscribe = subscribeSessionMentionIndex(() => { notifications++; });
    try {
      patchSessionMentionTitle('sess-a', 'Old title');
      patchSessionMentionTitle('sess-missing', 'Whatever');
      patchSessionMentionTitle('sess-a', '');
      expect(getSessionMentionIndex()).toBe(before);
      expect(notifications).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it('does not re-request the index just because a title changed', () => {
    const callsBefore = apiGet.mock.calls.length;
    patchSessionMentionTitle('sess-a', 'Renamed');
    expect(apiGet.mock.calls.length).toBe(callsBefore);
  });
});
