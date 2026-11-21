/**
 * The memory ledger's burst line sums the last two minutes of answered requests by
 * route (request-logger.ts noteDone): a route with ids in its path must read as one row.
 */
import { describe, it, expect } from 'vitest';
import { routeShape } from '../../../src/web/middleware/request-logger.js';

describe('routeShape', () => {
  it('folds session, task and job ids, keeps the words', () => {
    expect(routeShape('/api/sessions/3ccf06d9-dbdd-49a1-ab98-1537944f64d4/history')).toBe('/api/sessions/:id/history');
    expect(routeShape('/api/v1/tasks/mwpp7ix4-49ce/threads/th-f62097dc5a4c')).toBe('/api/v1/tasks/:id/threads/:id');
    expect(routeShape('/api/v1/hosts/clouddev/exec/hx-link-1795297071-6342-81029207')).toBe('/api/v1/hosts/clouddev/exec/:id');
    expect(routeShape('/api/stt/draft')).toBe('/api/stt/draft');
    expect(routeShape('/api/v1')).toBe('/api/v1');
  });
});
