/**
 * One send from the browser (web/src/components/topics/topic-send.ts, applied by useTopics): a
 * retry of the same words reuses the clientId the failed send carried, so the server answers it
 * once; and the local copy drawn at once meets the server's by that clientId, whichever comes first
 * (the POST's answer or a read after `topic:updated`), so a message is never drawn twice.
 */
import { describe, expect, it } from 'vitest';
import { sendClientId, withAnswer, withSending, type PendingSend } from '../../web/src/components/topics/topic-send';

interface M { id: string; clientId?: string; local?: 'sending'; text?: string }

let n = 0;
const fresh = () => `c-${++n}`;

describe('the clientId of a send', () => {
  it('reuses the pending clientId when the same words are sent again (a retry after a failed or lost answer)', () => {
    const pending: PendingSend = { text: 'Friday is the launch', clientId: 'c-first' };
    expect(sendClientId(pending, 'Friday is the launch', fresh)).toBe('c-first');
  });

  it('takes a fresh one for other words, or with nothing pending', () => {
    const pending: PendingSend = { text: 'Friday is the launch', clientId: 'c-first' };
    expect(sendClientId(pending, 'Friday is the launch!', fresh)).not.toBe('c-first');
    const a = sendClientId(undefined, 'hello', fresh);
    const b = sendClientId(undefined, 'hello', fresh);
    expect(a).not.toBe(b);
  });
});

describe('the local copy and the server copy', () => {
  const local: M = { id: 'local-c1', clientId: 'c1', local: 'sending', text: 'hi' };
  const server: M = { id: 'tpm-9', clientId: 'c1', text: 'hi' };
  const other: M = { id: 'tpm-1', text: 'earlier' };

  it('a read that already holds the message (topic:updated before the POST answer) drops the local copy', () => {
    expect(withSending<M>([other, server], [other, local])).toEqual([other, server]);
  });

  it('a read without it keeps the local copy drawn after what the server has', () => {
    expect(withSending<M>([other], [other, local])).toEqual([other, local]);
  });

  it('the POST answer replaces the local copy where it stood', () => {
    const later: M = { id: 'tpm-10', text: 'reply' };
    expect(withAnswer<M>([other, local, later], server, 'local-c1')).toEqual([other, server, later]);
  });

  it('the POST answer after a read brought the message: one copy, never two', () => {
    const afterRead = withSending<M>([other, server], [other, local]);
    expect(withAnswer<M>(afterRead, server, 'local-c1')).toEqual([other, server]);
    // Even when the read kept the copy (a server that returned no clientId), the answer takes its place once.
    expect(withAnswer<M>([other, local], { id: 'tpm-9' }, 'local-c1')).toEqual([other, { id: 'tpm-9' }]);
  });
});
