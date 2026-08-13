/**
 * Column-id predicates — the single definition of "this id is not a real session".
 *
 * Load-bearing because these predicates gate URL persistence, sessionStorage
 * persistence, status hydration and the status store's id validator. A predicate
 * that accidentally matched a REAL id would silently stop a live session from
 * being persisted/hydrated (looks like "the session vanished on reload"), and one
 * that failed to match a placeholder would fire HTTP for an id no server knows.
 */
import { describe, it, expect } from 'vitest';
import {
  DRAFT_COL_PREFIX,
  PENDING_COL_PREFIX,
  isDraftColumnId,
  isPendingColumnId,
  isPlaceholderColumnId,
} from '../../web/src/utils/column-ids';

// A real provider session id, as the CLI mints them.
const REAL_UUID = '3f7a1c2e-9b4d-4e88-8a01-5c6d7e8f9012';
// A Walnut ACP process identity — NOT a placeholder, and must not be treated as
// one (the status store rejects it separately, via its own regex).
const ACP_ID = 'acp-0123456789abcdef';

describe('column-ids: prefixes', () => {
  it('are the exact tokens the rest of the app string-matched before', () => {
    expect(DRAFT_COL_PREFIX).toBe('draft:');
    expect(PENDING_COL_PREFIX).toBe('pending:');
  });
});

describe('column-ids: isDraftColumnId', () => {
  it('matches draft ids only', () => {
    expect(isDraftColumnId('draft:1754870000000-1')).toBe(true);
    expect(isDraftColumnId(`${DRAFT_COL_PREFIX}new`)).toBe(true);
    expect(isDraftColumnId('pending:abc')).toBe(false);
    expect(isDraftColumnId(REAL_UUID)).toBe(false);
    expect(isDraftColumnId(ACP_ID)).toBe(false);
    expect(isDraftColumnId('')).toBe(false);
  });

  it('is prefix-anchored — "draft:" mid-string does not count', () => {
    expect(isDraftColumnId('session-draft:1')).toBe(false);
  });
});

describe('column-ids: isPendingColumnId', () => {
  it('matches pending ids only', () => {
    expect(isPendingColumnId('pending:temp-123')).toBe(true);
    expect(isPendingColumnId('pending:fork-1754870000000')).toBe(true);
    expect(isPendingColumnId('draft:1754870000000-1')).toBe(false);
    expect(isPendingColumnId(REAL_UUID)).toBe(false);
    expect(isPendingColumnId(ACP_ID)).toBe(false);
    expect(isPendingColumnId('')).toBe(false);
  });
});

describe('column-ids: isPlaceholderColumnId', () => {
  it('covers both placeholder families', () => {
    expect(isPlaceholderColumnId('draft:1754870000000-2')).toBe(true);
    expect(isPlaceholderColumnId('pending:temp-123')).toBe(true);
  });

  it('does NOT claim a real session id', () => {
    expect(isPlaceholderColumnId(REAL_UUID)).toBe(false);
  });

  it('does NOT claim an ACP runtime id', () => {
    // It is not a *column placeholder*: an acp- id belongs to a live column and
    // must keep being persisted to the URL/sessionStorage. Only the status store
    // rejects it, for the unrelated reason that it is not a PROVIDER id.
    expect(isPlaceholderColumnId(ACP_ID)).toBe(false);
    expect(isDraftColumnId(ACP_ID)).toBe(false);
    expect(isPendingColumnId(ACP_ID)).toBe(false);
  });
});
