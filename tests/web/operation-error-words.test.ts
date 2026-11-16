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

describe('a server\'s raw internals never reach the person as they are (2026-11-16)', () => {
  // The drafts card showed the raw answer: a lock timeout with its file path, and a stack.
  const INTERNALS = [
    'File lock timeout after 10000ms: /home/acme/.open-walnut/local/drafts.json.lock',
    '{"reqId":"6437bcce","detail":"boom"}',
    'FileLockTimeoutError: boom\n    at withFileLock (/x/walnut:502:717338)',
    'Internal Server Error',
  ];

  it('an action the person took says the change was not saved, in words', async () => {
    const { SERVER_FAULT_OPERATION_MESSAGE } = await import('../../web/src/utils/operation-error-words');
    for (const m of INTERNALS) expect(operationErrorWords(m)).toBe(SERVER_FAULT_OPERATION_MESSAGE);
    expect(operationErrorWords('Task not found')).toBe('Task not found');
  });

  it('a message that did not go out says it is kept and how to send it again', async () => {
    const { sendFailureWords } = await import('../../web/src/utils/operation-error-words');
    for (const m of INTERNALS) {
      const words = sendFailureWords(m);
      expect(words).toMatch(/Your message is kept: press Retry/);
      expect(words).not.toMatch(/lock|reqId|withFileLock|Internal Server Error/);
    }
    expect(sendFailureWords('Failed to fetch')).toMatch(/^Walnut did not answer/);
    expect(sendFailureWords(undefined)).toMatch(/press Retry/);
    expect(sendFailureWords('Session not found')).toBe('Session not found');
  });
});
