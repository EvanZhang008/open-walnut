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

describe('readErrorWords (a status read while Walnut is down)', () => {
  it('says Walnut is not reachable and keeps trying, never the browser words', async () => {
    const { UNREACHABLE_READ_MESSAGE, readErrorWords, isBrowserNetworkMessage } = await import('../../web/src/utils/operation-error-words');
    for (const m of ['Load failed', 'Failed to fetch', 'NetworkError when attempting to fetch resource.']) {
      expect(isBrowserNetworkMessage(m)).toBe(true);
      expect(readErrorWords(m)).toBe(UNREACHABLE_READ_MESSAGE);
    }
    expect(UNREACHABLE_READ_MESSAGE).toMatch(/not reachable/);
    expect(UNREACHABLE_READ_MESSAGE).toMatch(/keeps trying/);
    expect(readErrorWords('Session not found')).toBe('Session not found');
  });

  it('guard: the recovery status read puts its failure through the words, and its card says so', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const store = fs.readFileSync(path.join(__dirname, '../../web/src/stores/session-supervision-store.ts'), 'utf8');
    expect(store).toMatch(/error: entry\.actionError \?\? readErrorWords\(message\)/);
    expect(store).not.toMatch(/error: entry\.actionError \?\? \(error instanceof Error \? error\.message/);
    const bar = fs.readFileSync(path.join(__dirname, '../../web/src/components/sessions/SessionSupervisionBar.tsx'), 'utf8');
    expect(bar).toMatch(/stale && unreachable \? 'Walnut is not reachable'/);
  });
});
