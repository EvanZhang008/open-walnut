/**
 * A send that failed only because the connection was down goes out again by itself
 * (web/src/hooks/send-auto-retry.ts), and a failed send says so once, on its bubble.
 *
 * 2026-11-21 (the user: "isn't there fucking retry?"): during a deploy restart the socket
 * was down about 17 s; a message waited its 10 s, failed, and stayed red with a tiny
 * Retry, and the same error showed again under the composer.
 *
 * The class is "an error a send can fail with". Its members are read from the source
 * (every `new Error('...')` and `rejectPending('...')` of api/ws.ts, and the deadline
 * of api/session-send.ts), so a new way to lose the connection fails here until it is
 * sorted as a connection failure or listed as a refusal.
 *
 * 2026-11-22: the quick bar follows the same rule (its HTTP send's `network` failure), and a
 * send older than AUTO_RETRY_MAX_AGE_MS no longer goes out by itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTO_RETRY_MAX, AUTO_RETRY_MAX_AGE_MS, dueForAutoRetry, expiredAutoRetry, isConnectionFailure, nextAutoRetryExpiry, pastAutoRetryAge,
  sameWaitingSend, waitsForConnectionAfter,
} from '../../web/src/hooks/send-auto-retry';
import { acceptedBubble, composerSendError } from '../../web/src/components/sessions/send-acceptance';
import { markBubblesFailed } from '../../web/src/components/sessions/parked-bubbles';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Errors of api/ws.ts that are not about the connection: the send itself was refused here. */
const NOT_CONNECTION = new Set([
  // The page is shutting down: nothing will reconnect it.
  'WebSocket disposed',
]);

describe('which send errors wait for the connection', () => {
  it('every connection error api/ws.ts throws is one, every other error is not', () => {
    const src = read('web/src/api/ws.ts');
    const words = [...src.matchAll(/(?:new Error|rejectPending)\('([^']+)'\)/g)].map((m) => m[1]);
    expect(words.length).toBeGreaterThan(3);
    for (const w of words) {
      if (!w.startsWith('WebSocket')) continue;
      expect(isConnectionFailure(w), w).toBe(!NOT_CONNECTION.has(w));
    }
  });

  it("the send's own deadline is one (api/session-send.ts withDeadline)", () => {
    const src = read('web/src/api/session-send.ts');
    expect(src).toMatch(/`no answer in \$\{Math\.round\(opts\.timeoutMs \/ 1000\)\}s`/);
    expect(isConnectionFailure('no answer in 30s')).toBe(true);
  });

  it('a refusal the server answered never resends', () => {
    for (const w of ['Message predates the latest stop; send a new message to continue', 'session:send userUuid must be a v4 UUID string',
      'Your answer is on the letter but did not reach the task. Retry to send it again.', 'Message too large for the live connection (4MB).']) {
      expect(isConnectionFailure(w), w).toBe(false);
    }
    expect(isConnectionFailure(undefined)).toBe(false);
  });

  it('only a send with its own user line waits (the server knows its resend by it), and at most AUTO_RETRY_MAX times', () => {
    const e = 'WebSocket not connected (timeout)';
    expect(waitsForConnectionAfter(e, { userUuid: 'u1' })).toBe(true);
    expect(waitsForConnectionAfter(e, {})).toBe(false);
    expect(waitsForConnectionAfter(e, { userUuid: 'u1' }, AUTO_RETRY_MAX - 1)).toBe(true);
    expect(waitsForConnectionAfter(e, { userUuid: 'u1' }, AUTO_RETRY_MAX)).toBe(false);
  });
});

describe('which bubbles go out again now', () => {
  const b = (over: Record<string, unknown>) => ({ queueId: 'q1', status: 'failed', userUuid: 'u1', waitsForConnection: true, ...over });
  it('a waiting bubble goes once the connection is up, and not while it is down', () => {
    expect(dueForAutoRetry([b({})], false, new Set())).toHaveLength(0);
    expect(dueForAutoRetry([b({})], true, new Set())).toHaveLength(1);
  });
  it('never one on its way already, one refused, one past its tries, or one without a user line', () => {
    expect(dueForAutoRetry([b({})], true, new Set(['q1']))).toHaveLength(0);
    expect(dueForAutoRetry([b({ waitsForConnection: undefined })], true, new Set())).toHaveLength(0);
    expect(dueForAutoRetry([b({ status: 'pending' })], true, new Set())).toHaveLength(0);
    expect(dueForAutoRetry([b({ autoTries: AUTO_RETRY_MAX })], true, new Set())).toHaveLength(0);
    expect(dueForAutoRetry([b({ userUuid: undefined })], true, new Set())).toHaveLength(0);
  });
});

describe('Enter on the words that came back to the box is the waiting send, never a second copy', () => {
  const w = (over: Record<string, unknown>) => ({ queueId: 'q1', status: 'failed', text: 'jsut go', userUuid: 'u1', waitsForConnection: true, draftOrigin: { key: 'draft:session:s1' }, ...over });
  it('finds the waiting send, or the one going out by itself now', () => {
    expect(sameWaitingSend([w({})], 'jsut go', 'draft:session:s1')?.queueId).toBe('q1');
    expect(sameWaitingSend([w({ status: 'pending', waitsForConnection: undefined, autoTries: 1 })], 'jsut go', 'draft:session:s1')?.queueId).toBe('q1');
  });
  it('other words, another box, a send that failed for good, or one the person sent again are new sends', () => {
    expect(sameWaitingSend([w({})], 'jsut go now', 'draft:session:s1')).toBeUndefined();
    expect(sameWaitingSend([w({})], 'jsut go', 'draft:question:s1:q4')).toBeUndefined();
    expect(sameWaitingSend([w({ waitsForConnection: undefined })], 'jsut go', 'draft:session:s1')).toBeUndefined();
    expect(sameWaitingSend([w({ status: 'pending', waitsForConnection: undefined, autoTries: 0 })], 'jsut go', 'draft:session:s1')).toBeUndefined();
    expect(sameWaitingSend([w({})], 'jsut go', undefined)).toBeUndefined();
  });
});

describe('a failed send says so once', () => {
  const failed = { queueId: 'q1', status: 'failed' as const, userUuid: 'u1' };
  it('the composer line leaves an error its bubble shows', () => {
    expect(composerSendError({ text: 'Send failed', userUuid: 'u1', bubble: true }, [failed])).toBeNull();
    expect(composerSendError({ text: 'Batch failed', bubble: true }, [{ ...failed, failedError: 'Batch failed' }])).toBeNull();
    // ...but never an error about another send while some other bubble is failed.
    expect(composerSendError({ text: 'Batch failed', bubble: true }, [{ ...failed, failedError: 'Send failed' }])).toBe('Batch failed');
  });
  it('an error no bubble shows stays on the composer', () => {
    expect(composerSendError({ text: 'Large paste upload failed: 500' }, [failed])).toBe('Large paste upload failed: 500');
    expect(composerSendError({ text: 'Stop failed: timeout' }, [])).toBe('Stop failed: timeout');
  });
  it('the panel draws the composer line, never the bubble error again', () => {
    expect(read('web/src/components/sessions/SessionPanel.tsx')).toMatch(/composerError: sendError/);
  });
});

describe('every web send of a person\'s words either resends by itself or keeps them in its box', () => {
  /** Callers of sendSessionMessage outside the chat hook, each with what happens on a lost connection. */
  const OWN_BOX: Record<string, string> = {
    // The chat hook itself: its bubbles wait for the connection (send-auto-retry.ts).
    'web/src/hooks/useSessionSend.ts': 'auto-resend',
    // One-shot asks from a box that shows its error and keeps the words for the person to send again.
    'web/src/components/chat/AskObjectDrawer.tsx': 'box keeps the ask, its Retry sends again',
    'web/src/components/drawing/DrawingAssistant.tsx': 'the diagram box says the assistant did not get it',
    'web/src/components/org/ask-main.ts': 'its caller keeps the words in its box',
    'web/src/components/board/kanban/KanbanCardComposer.tsx': 'the card composer keeps the words and says why',
    'web/src/popout/PopoutExtTasks.tsx': 'the side panel box keeps its draft and shows the error',
  };
  it('lists exactly the files that call it', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        const rel = path.join(dir, name);
        if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name) && /\bsendSessionMessage\(/.test(read(rel))) files.push(rel);
      }
    };
    walk('web/src');
    // api/session-send.ts defines it; a new caller says here what happens to its words when the connection drops.
    expect(files.filter((f) => f !== 'web/src/api/session-send.ts').sort()).toEqual(Object.keys(OWN_BOX).sort());
  });
});

describe('a send stops waiting for the connection once the server answered it', () => {
  const w = { queueId: 'temp-1', status: 'failed' as const, userUuid: 'u1', failedError: 'WebSocket not connected (timeout)', waitsForConnection: true, autoTries: 1 };
  it('accepted (its answer, or a late proof it was kept)', () => {
    const a = acceptedBubble(w, { messageId: 'qm-1' }) as Record<string, unknown>;
    expect(a.waitsForConnection).toBeUndefined();
    expect(a.autoTries).toBeUndefined();
  });
  it('refused by the server (a batch failed, a park): an ordinary failed send, never resent by itself', () => {
    const [f] = markBubblesFailed([w], ['temp-1'], 'Session stopped', { parked: true }) as Array<Record<string, unknown>>;
    expect(f.waitsForConnection).toBeUndefined();
    expect(f.autoTries).toBeUndefined();
  });
});

describe('only a surface that draws the waiting bubble resends by itself', () => {
  it('the opted-in surfaces are exactly the ones that draw it with its Send now and Dismiss', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        const rel = path.join(dir, name);
        if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(name) && /useSessionSend\([^)]*autoResend: true/.test(read(rel))) files.push(rel);
      }
    };
    walk('web/src');
    // A surface added here must pass onRetryFailed and onDismissFailed to SessionChatHistory.
    expect(files.sort()).toEqual(['web/src/components/notes/NotesSessionChat.tsx', 'web/src/components/sessions/SessionPanel.tsx']);
    for (const f of files) expect(read(f), f).toMatch(/onRetryFailed=/);
  });
});

describe('a send that waited too long goes out by itself no more (AUTO_RETRY_MAX_AGE_MS)', () => {
  const T0 = Date.parse('2026-11-22T10:00:00.000Z');
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const b = (over: Record<string, unknown>) => ({ queueId: 'q1', status: 'failed', userUuid: 'u1', waitsForConnection: true, timestamp: at(0), ...over });
  it('ten minutes from the first try, one rule for both surfaces', () => {
    expect(AUTO_RETRY_MAX_AGE_MS).toBe(10 * 60_000);
    expect(pastAutoRetryAge(at(0), T0 + AUTO_RETRY_MAX_AGE_MS - 1)).toBe(false);
    expect(pastAutoRetryAge(at(0), T0 + AUTO_RETRY_MAX_AGE_MS)).toBe(true);
    // Epoch ms (a quick bar receipt) counts the same as an ISO time (a bubble).
    expect(pastAutoRetryAge(T0, T0 + AUTO_RETRY_MAX_AGE_MS)).toBe(true);
    // No known time: never too old (an older bubble kept in a draft).
    expect(pastAutoRetryAge(undefined, T0 + 99 * AUTO_RETRY_MAX_AGE_MS)).toBe(false);
    expect(pastAutoRetryAge('not a time', T0)).toBe(false);
  });
  it('an old send never waits, never goes out by itself, and turns into an ordinary failure, shown', () => {
    const late = T0 + AUTO_RETRY_MAX_AGE_MS + 1;
    expect(waitsForConnectionAfter('WebSocket not connected (timeout)', { userUuid: 'u1', timestamp: at(0) }, 0, late)).toBe(false);
    expect(waitsForConnectionAfter('WebSocket not connected (timeout)', { userUuid: 'u1', timestamp: at(0) }, 0, T0 + 1000)).toBe(true);
    expect(dueForAutoRetry([b({})], true, new Set(), late)).toHaveLength(0);
    expect(dueForAutoRetry([b({})], true, new Set(), T0 + 1000)).toHaveLength(1);
    // Never silently: the hook turns each of these into a red line with its Retry.
    expect(expiredAutoRetry([b({})], late).map((m) => m.queueId)).toEqual(['q1']);
    expect(expiredAutoRetry([b({})], T0 + 1000)).toHaveLength(0);
    expect(expiredAutoRetry([b({ waitsForConnection: undefined })], late)).toHaveLength(0);
    expect(expiredAutoRetry([b({ status: 'pending' })], late)).toHaveLength(0);
  });
  it('one timer: the earliest moment a waiting bubble grows too old', () => {
    expect(nextAutoRetryExpiry([b({ queueId: 'a', timestamp: at(5_000) }), b({ queueId: 'b', timestamp: at(1_000) })])).toBe(T0 + 1_000 + AUTO_RETRY_MAX_AGE_MS);
    expect(nextAutoRetryExpiry([b({ waitsForConnection: undefined })])).toBeUndefined();
    expect(nextAutoRetryExpiry([])).toBeUndefined();
  });
  it('Enter on the words of an old waiting send is a new send', () => {
    const w = b({ text: 'jsut go', draftOrigin: { key: 'draft:session:s1' } });
    expect(sameWaitingSend([w], 'jsut go', 'draft:session:s1', T0 + 1000)?.queueId).toBe('q1');
    expect(sameWaitingSend([w], 'jsut go', 'draft:session:s1', T0 + AUTO_RETRY_MAX_AGE_MS)).toBeUndefined();
  });
});

describe("the quick bar's HTTP send: a fetch that never reached Walnut is a connection failure", () => {
  it('by its code (api/quick.ts postNdjson), never by a refusal the server answered', () => {
    const src = read('web/src/api/quick.ts');
    // The one code postNdjson gives a fetch that threw.
    expect(src).toMatch(/fail\('network', opts\.unreachable\)/);
    expect(isConnectionFailure({ code: 'network', message: 'Walnut could not be reached. Nothing was sent.' })).toBe(true);
    for (const code of ['http_400', 'http_404', 'http_409', 'http_500', 'send_failed', 'follow_lost']) {
      expect(isConnectionFailure({ code, message: 'Not sent (500).' }), code).toBe(false);
    }
    expect(waitsForConnectionAfter({ code: 'network', message: 'x' }, { userUuid: 'u1', timestamp: Date.now() })).toBe(true);
    expect(waitsForConnectionAfter({ code: 'network', message: 'x' }, {})).toBe(false);
  });
});

describe('every surface that resends by itself follows this one rule', () => {
  it('the chat hook and the quick bar, and nothing else imports it', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        const rel = path.join(dir, name);
        if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(name) && /from '(?:\.\/|@\/hooks\/)send-auto-retry'/.test(read(rel))) files.push(rel);
      }
    };
    walk('web/src');
    expect(files.sort()).toEqual(['web/src/components/quickbar/useQuickReceipts.ts', 'web/src/hooks/useSessionSend.ts']);
  });
  it("the quick bar's one send carries its own user line, so its resend is the same send on the server", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        const rel = path.join(dir, name);
        if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(name) && /\bquickSendFollow\(/.test(read(rel))) callers.push(rel);
      }
    };
    walk('web/src');
    expect(callers.filter((f) => f !== 'web/src/api/quick.ts')).toEqual(['web/src/components/quickbar/useQuickReceipts.ts']);
    expect(read('web/src/components/quickbar/useQuickReceipts.ts')).toMatch(/userUuid: r\.userUuid/);
  });
});
