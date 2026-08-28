/**
 * Echo claims must hold the transport's PREPARED outbound text — the exact
 * bytes the CLI echoes into the canonical JSONL (inc-1787704938224).
 *
 * The incident: sending an image to a REMOTE session pinned the user's bubble
 * at the bottom of the timeline forever (cleared only by remount). Chain:
 * the route enqueues the message with LOCAL image paths; delivery runs
 * prepareOutbound(), which uploads the images and rewrites the paths to the
 * remote host (/tmp/open-walnut-images/…); the CLI echoes the REWRITTEN text.
 * Claims were registered with the pre-rewrite queue text, so bindEchoClaims'
 * exact-match compare never bound them → no walnutMessageId on the history
 * row → the bubble's id pass failed AND its text pass failed (dedupText holds
 * local paths, history holds mirror paths) → no absorption evidence at all.
 * Live proof: in the incident session every image message had
 * walnutMessageId=null while every text-only message was bound.
 *
 * Would-fail-if-reverted: point the registration back at the queue text and
 * the "binds the rewritten echo" tests go red (walnutMessageId stays unset).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-echo-prepared'));

import { SessionRunner } from '../../src/providers/claude-code-session.js';
import {
  registerEchoClaims, bindEchoClaims, _resetEchoClaimsForTest, type EchoBindableMessage,
} from '../../src/core/echo-claims.js';
import { enqueueMessage, markProcessing, resetCache } from '../../src/core/session-message-queue.js';
import fsp from 'node:fs/promises';
import { WALNUT_HOME } from '../../src/constants.js';

const SID = 'echo-prep-sid';
const LOCAL_TEXT = '[Images attached — use the Read tool to view them]\n- /Users/me/.open-walnut/images/img-1.png\n\nlook at this screenshot';
const PREPARED_TEXT = '[Images attached — use the Read tool to view them]\n- /tmp/open-walnut-images/img-1.png\n\nlook at this screenshot';

function echoLine(text: string, msgId: string): EchoBindableMessage {
  return { role: 'user', text, timestamp: new Date().toISOString(), msgId };
}

beforeEach(async () => {
  // maxRetries: a SessionRunner from the previous test can still be flushing
  // into WALNUT_HOME when this rm runs (observed as ENOTEMPTY on rmdir).
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  _resetEchoClaimsForTest();
});

describe('echo-claim text vs prepareOutbound rewrite', () => {
  it('documents the failure: a claim holding the pre-rewrite text never binds the rewritten echo', async () => {
    // Exact-match binding is deliberate (no fuzz) — which is precisely why the
    // claim must be registered with the rewritten text, not the queue text.
    registerEchoClaims(SID, ['qm-img-1'], LOCAL_TEXT);
    const echo = echoLine(PREPARED_TEXT, 'uuid-echo-1');
    bindEchoClaims(SID, [echo]);
    expect(echo.walnutMessageId).toBeUndefined();
  });

  it('settleResumeSuccess registers the claim with the transport prepared text, and it binds', async () => {
    const msg = await enqueueMessage(SID, LOCAL_TEXT);
    const batch = await markProcessing(SID);
    expect(batch).toHaveLength(1);

    const runner = new SessionRunner('/bin/true');
    // Minimal stand-in for the ClaudeCodeSession the settle callback receives:
    // the transport rewrote the payload inside start() and tracked it.
    const fakeSession = {
      writeSyntheticUserEvent: vi.fn(),
      lastPreparedOutbound: PREPARED_TEXT,
    };
    (runner as unknown as {
      settleResumeSuccess: (sid: string, session: typeof fakeSession, msgs: typeof batch) => void;
    }).settleResumeSuccess(SID, fakeSession, batch);

    const echo = echoLine(PREPARED_TEXT, 'uuid-echo-2');
    bindEchoClaims(SID, [echo]);
    expect(echo.walnutMessageId).toBe(msg.id);

    // And the raw queue text must NOT be what got claimed — an echo shaped
    // like the local-path text stays unbound (there is no such echo on disk).
    const ghost = echoLine(LOCAL_TEXT, 'uuid-echo-3');
    bindEchoClaims(SID, [ghost]);
    expect(ghost.walnutMessageId).toBeUndefined();
  });

  it('falls back to the queue text when the transport does not track prepared output (local sessions)', async () => {
    const msg = await enqueueMessage(SID, 'plain text send');
    const batch = await markProcessing(SID);

    const runner = new SessionRunner('/bin/true');
    const fakeSession = {
      writeSyntheticUserEvent: vi.fn(),
      lastPreparedOutbound: undefined,
    };
    (runner as unknown as {
      settleResumeSuccess: (sid: string, session: typeof fakeSession, msgs: typeof batch) => void;
    }).settleResumeSuccess(SID, fakeSession, batch);

    const echo = echoLine('plain text send', 'uuid-echo-4');
    bindEchoClaims(SID, [echo]);
    expect(echo.walnutMessageId).toBe(msg.id);
  });
});
