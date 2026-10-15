/**
 * N25: "Action failed: Load failed" on a phone. A network failure's browser
 * wording becomes one plain sentence; every other message is kept.
 */
import { describe, expect, it } from 'vitest';
import { UNREACHABLE_OPERATION_MESSAGE, operationErrorWords } from '../../web/src/utils/operation-error-words';

describe('operationErrorWords', () => {
  it('each engine\'s network failure reads as words', () => {
    for (const m of ['Load failed', 'Failed to fetch', 'NetworkError when attempting to fetch resource.', 'The network connection was lost.', ' load failed ']) {
      expect(operationErrorWords(m)).toBe(UNREACHABLE_OPERATION_MESSAGE);
    }
  });
  it('a server\'s own reason passes through', () => {
    expect(operationErrorWords('Task not found')).toBe('Task not found');
    expect(operationErrorWords('3 of 5 tasks could not be updated.')).toBe('3 of 5 tasks could not be updated.');
    expect(operationErrorWords('Load failed for task x')).toBe('Load failed for task x');
  });
});
