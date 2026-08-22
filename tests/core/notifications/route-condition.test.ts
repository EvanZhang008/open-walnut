/**
 * Route-error identity — the nine-cards bug, pinned.
 *
 * The live feed held NINE unresolved `GET/PUT /api/ui-prefs → 500` cards for ONE
 * broken endpoint, because the log message the bridge fingerprints embedded the
 * request latency and the full query string. These tests pin both halves of the
 * fix: the message is stable across occurrences, and the condition key is stable
 * across entity ids.
 *
 * The other half of the contract — collapsing must not go so far that two
 * genuinely different routes share a card — is why the id heuristic is stricter
 * than the metrics one in the same middleware, and why several route WORDS that
 * look id-ish are asserted to survive.
 */
import { describe, it, expect } from 'vitest';
import {
  isIdSegment, normalizeRoutePath, routeRecoveryKey, routeLogMessage,
} from '../../../src/core/notifications/route-condition.js';

describe('isIdSegment', () => {
  it('recognizes the id shapes that would otherwise split one card per entity', () => {
    // UUID (both cases)
    expect(isIdSegment('7cc9e8ce-1a2b-4c3d-8e9f-0123456789ab')).toBe(true);
    expect(isIdSegment('7CC9E8CE-1A2B-4C3D-8E9F-0123456789AB')).toBe(true);
    // long hex (session ids, sha-ish)
    expect(isIdSegment('0123456789abcdef')).toBe(true);       // exactly 16
    expect(isIdSegment('0123456789abcdef0123456789abcdef')).toBe(true);
    // pure numeric
    expect(isIdSegment('42')).toBe(true);
    expect(isIdSegment('1784686852150')).toBe(true);
  });

  it('leaves ROUTE WORDS intact, including the version-suffixed ones', () => {
    // Each of these would send the user a route they never called if collapsed.
    for (const word of [
      'ui-prefs', 'notes-v2', 'search-memory-v1', 'mark-read', 'dismiss',
      'tasks', 'sessions', 'api', 'v1', 'start-quick', 'browser-logs',
      'file-content', 'phase',
    ]) {
      expect(isIdSegment(word), word).toBe(false);
    }
  });

  it('does NOT collapse a short hex-looking word (too little evidence)', () => {
    // 'face', 'added', 'decade' are hex-only but far too short to be ids — and
    // are exactly the kind of word a route segment can be.
    expect(isIdSegment('face')).toBe(false);
    expect(isIdSegment('decade')).toBe(false);
    // 15 hex chars is still below the threshold; 16 is where an id starts.
    expect(isIdSegment('0123456789abcde')).toBe(false);
  });

  it('does not collapse a mixed id-ish slug that carries route meaning', () => {
    // Walnut short ids like ms4utt4g-1bc6 are NOT hex-only and NOT numeric, so
    // they stay. This is a deliberate difference from the metrics heuristic in
    // request-logger.ts: a metric label may over-collapse (cardinality is the
    // only concern there), a user-visible card title may not.
    expect(isIdSegment('ms4utt4g-1bc6')).toBe(false);
  });
});

describe('normalizeRoutePath', () => {
  it('drops the query string — the piece that made every request unique', () => {
    expect(normalizeRoutePath('/api/ui-prefs?keys=a,b,c')).toBe('/api/ui-prefs');
    expect(normalizeRoutePath('/api/sessions?id=abc&tail=400')).toBe('/api/sessions');
  });

  it('drops a fragment too', () => {
    expect(normalizeRoutePath('/api/notes#L10')).toBe('/api/notes');
    expect(normalizeRoutePath('/api/notes?x=1#L10')).toBe('/api/notes');
  });

  it('collapses id segments to :id, keeping the rest of the path', () => {
    expect(normalizeRoutePath('/api/tasks/1784686852150/phase')).toBe('/api/tasks/:id/phase');
    expect(normalizeRoutePath('/api/sessions/7cc9e8ce-1a2b-4c3d-8e9f-0123456789ab/history'))
      .toBe('/api/sessions/:id/history');
    expect(normalizeRoutePath('/api/sessions/0123456789abcdef0123/messages'))
      .toBe('/api/sessions/:id/messages');
  });

  it('does NOT truncate the path — a different sub-resource is a different condition', () => {
    // The metrics routeGroup keeps 4 segments; this must not, or `:id/phase`
    // failing and `:id/note` failing would share a card and each overwrite the
    // other's body.
    expect(normalizeRoutePath('/api/tasks/42/note/history/full'))
      .toBe('/api/tasks/:id/note/history/full');
  });

  it('normalizes a trailing slash away (same route, one condition)', () => {
    expect(normalizeRoutePath('/api/ui-prefs/')).toBe('/api/ui-prefs');
    expect(normalizeRoutePath('/api/ui-prefs')).toBe('/api/ui-prefs');
    // …but the root path is left as-is.
    expect(normalizeRoutePath('/')).toBe('/');
  });
});

describe('routeLogMessage — the dedup surface', () => {
  it('is IDENTICAL for two occurrences that differ only in latency and query', () => {
    // This is the whole bug: the old line was
    //   `GET /api/ui-prefs?keys=a → 500 (23ms)`
    //   `GET /api/ui-prefs?keys=b → 500 (1204ms)`
    // …two different strings, therefore two different cards, nine times over.
    const a = routeLogMessage('GET', '/api/ui-prefs?keys=a', 500);
    const b = routeLogMessage('GET', '/api/ui-prefs?keys=b', 500);
    expect(a).toBe(b);
    expect(a).toBe('GET /api/ui-prefs → 500');
    expect(a).not.toMatch(/ms/);
  });

  it('keeps DIFFERENT methods, paths and statuses apart', () => {
    const get500 = routeLogMessage('GET', '/api/ui-prefs', 500);
    const put500 = routeLogMessage('PUT', '/api/ui-prefs', 500);
    const get501 = routeLogMessage('GET', '/api/ui-prefs', 501);
    const other = routeLogMessage('GET', '/api/search', 501);
    expect(new Set([get500, put500, get501, other]).size).toBe(4);
  });

  it('folds every entity of one failing route into one message', () => {
    expect(routeLogMessage('PUT', '/api/tasks/11/phase', 500))
      .toBe(routeLogMessage('PUT', '/api/tasks/22/phase', 500));
  });
});

describe('routeRecoveryKey', () => {
  it('is the condition id: method + normalized path', () => {
    expect(routeRecoveryKey('GET', '/api/ui-prefs?keys=a')).toBe('route:GET /api/ui-prefs');
    expect(routeRecoveryKey('PUT', '/api/tasks/42/phase')).toBe('route:PUT /api/tasks/:id/phase');
  });

  it('is the same key a later SUCCESS on that endpoint computes', () => {
    // The recovery edge depends on this: the 500 arms `route:GET /api/x` and the
    // next 200 must look up that exact string, whatever the query/ids differ by.
    const failing = routeRecoveryKey('GET', '/api/sessions/aaaaaaaaaaaaaaaa/history?tail=400');
    const healthy = routeRecoveryKey('GET', '/api/sessions/bbbbbbbbbbbbbbbb/history');
    expect(healthy).toBe(failing);
  });

  it('separates GET from PUT on the same path (independently fixable)', () => {
    expect(routeRecoveryKey('GET', '/api/ui-prefs'))
      .not.toBe(routeRecoveryKey('PUT', '/api/ui-prefs'));
  });
});
