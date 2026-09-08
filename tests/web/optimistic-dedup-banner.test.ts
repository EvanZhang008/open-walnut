/**
 * Duplicate-bubble risk when Walnut PREPENDS a machine banner to a lane message.
 *
 * The sequence, exactly as production runs it (src/core/sessions/lane-turn.ts):
 *   1. the human types `TYPED` and the browser renders an optimistic bubble whose
 *      text is `TYPED`;
 *   2. `runLaneTurn` prepends `[Conversation context]…[/Conversation context]` and
 *      hands the COMBINED string to sendMessageToSession;
 *   3. the delivery point registers an echo claim with the text the CLI actually
 *      received (claude-code-session.ts: `lastPreparedOutbound ?? combined`);
 *   4. the CLI writes that combined string into its transcript, so the persisted
 *      user row NO LONGER EQUALS the optimistic bubble's text;
 *   5. the panel dedups the bubble against history.
 *
 * Step 4 is what makes this worth pinning: `dedupeOptimisticMessages`'s text passes
 * can never match a banner-prefixed row, so the ONLY thing standing between the
 * user and two copies of their own message is the `walnutMessageId` id path.
 *
 * Both halves are exercised with the REAL modules — `bindEchoClaims` from
 * src/core (the stamper) and the shipped frontend deduper — because the risk lives
 * precisely in the seam between them, and a mock of either would assume away the
 * thing under test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerEchoClaims,
  bindEchoClaims,
  _resetEchoClaimsForTest,
  type EchoBindableMessage,
} from '../../src/core/echo-claims';
import {
  CATCH_UP_BANNER_OPEN,
  CATCH_UP_BANNER_CLOSE,
} from '../../src/core/chat-history';
import { dedupeOptimisticMessages } from '@/components/sessions/optimistic-dedup';

const SID = 'lane-session-banner';
const TYPED = 'so what about that?';
const RECAP = [
  '## Conversation turns you have not seen (injected by Walnut)',
  'These turns are part of THIS conversation and the user can see them.',
  '',
  '### User',
  'an earlier turn this lane never saw',
].join('\n');

/** Composed exactly as lane-turn.ts composes it before the send. */
const COMBINED = `${CATCH_UP_BANNER_OPEN}\n${RECAP}\n${CATCH_UP_BANNER_CLOSE}\n\n${TYPED}`;

/** The persisted transcript row the CLI writes for that delivery. */
function persistedRow(text: string): EchoBindableMessage {
  return {
    role: 'user',
    text,
    // After the claim, inside the bind clock slack.
    timestamp: new Date(Date.now() + 1_000).toISOString(),
    msgId: '0199cd01-0000-4aaa-8bbb-000000000001',
  };
}

/** The browser's optimistic bubble: the human's typed text, nothing else. */
function bubble(queueId?: string) {
  return { text: TYPED, status: 'delivered', ...(queueId ? { queueId } : {}) };
}

beforeEach(() => {
  _resetEchoClaimsForTest();
});

describe('a banner-prefixed lane echo still consumes its optimistic bubble', () => {
  it('the id path covers the normal delivery: ONE bubble, not two', () => {
    // lane-turn prepends BEFORE sendMessageToSession, so the claim text is the
    // combined string — the same bytes the transcript will hold.
    registerEchoClaims(SID, ['qm-lane-1'], COMBINED);
    const messages = [persistedRow(COMBINED)];
    bindEchoClaims(SID, messages);

    // The stamp is what makes identity beat text here.
    expect(messages[0].walnutMessageId).toBe('qm-lane-1');

    const out = dedupeOptimisticMessages([bubble('qm-lane-1')], messages, 0);
    expect(out).toHaveLength(0); // the grey bubble is gone; only history renders
  });

  it('the text of the persisted row genuinely differs from the bubble', () => {
    // Guards the premise: if these ever became equal the tests below would pass
    // for the wrong reason.
    expect(COMBINED).not.toBe(TYPED);
    expect(COMBINED.includes(TYPED)).toBe(true);
  });

  it('a LOST claim (server restart) must still not duplicate the bubble', () => {
    // Documented fallback in echo-claims.ts: "The registry is in-memory: a server
    // restart loses unbound claims and the frontend falls back to text dedup."
    // With a banner in front of the row, that fallback has no text to match on —
    // this is the case that put two copies of the message on screen.
    const messages = [persistedRow(COMBINED)];
    bindEchoClaims(SID, messages); // no claims registered → no stamp
    expect(messages[0].walnutMessageId).toBeUndefined();

    const out = dedupeOptimisticMessages([bubble('qm-lane-1')], messages, 0);
    expect(out).toHaveLength(0);
  });

  it('a claim registered BEFORE the prepend never binds, and still must not duplicate', () => {
    // Defence in depth: any delivery path that registers the pre-banner text
    // cannot bind (bindEchoClaims compares text EXACTLY), so the id path is gone
    // and only the text path is left.
    registerEchoClaims(SID, ['qm-lane-1'], TYPED);
    const messages = [persistedRow(COMBINED)];
    bindEchoClaims(SID, messages);
    expect(messages[0].walnutMessageId).toBeUndefined();

    const out = dedupeOptimisticMessages([bubble('qm-lane-1')], messages, 0);
    expect(out).toHaveLength(0);
  });

  it('a bubble with no queueId at all is consumed by the peeled text', () => {
    const messages = [persistedRow(COMBINED)];
    const out = dedupeOptimisticMessages([bubble()], messages, 0);
    expect(out).toHaveLength(0);
  });

  it('two stacked banners in front of the row still consume the bubble', () => {
    const stacked = `[Task Context]\nid: task-1\n[/Task Context]\n\n${COMBINED}`;
    const messages = [persistedRow(stacked)];
    const out = dedupeOptimisticMessages([bubble()], messages, 0);
    expect(out).toHaveLength(0);
  });
});

describe('peeling must not weaken dedup for turns with no banner', () => {
  it('still refuses to consume a bubble history does not account for', () => {
    const messages = [persistedRow('a completely different message')];
    const out = dedupeOptimisticMessages([bubble()], messages, 0);
    expect(out).toHaveLength(1); // stays rendered — nothing proved it landed
  });

  it('keeps the window rule: an identical OLD message does not consume a new bubble', () => {
    const messages = [
      persistedRow(TYPED),                                  // old turn, outside window
      { role: 'assistant', text: 'yo', timestamp: '', msgId: 'a1' },
      persistedRow('something else'),                       // the new window
    ];
    const out = dedupeOptimisticMessages([bubble()], messages, 2);
    expect(out).toHaveLength(1);
  });

  it('keeps multiset semantics: two bubbles need two persisted rows', () => {
    const messages = [persistedRow(TYPED)];
    const out = dedupeOptimisticMessages([bubble(), bubble()], messages, 0);
    expect(out).toHaveLength(1); // exactly one is consumed
  });

  it('never consumes a FAILED bubble, banner or not', () => {
    const messages = [persistedRow(COMBINED)];
    const out = dedupeOptimisticMessages(
      [{ text: TYPED, status: 'failed', queueId: 'qm-lane-1' }],
      messages,
      0,
    );
    expect(out).toHaveLength(1); // the backend never got it — must stay
  });

  it('a banner-ONLY row (no typed text) consumes nothing', () => {
    // Nothing a human typed is in that row, so it must not silently eat a bubble.
    const bannerOnly = `${CATCH_UP_BANNER_OPEN}\n${RECAP}\n${CATCH_UP_BANNER_CLOSE}`;
    const messages = [persistedRow(bannerOnly)];
    const out = dedupeOptimisticMessages([bubble()], messages, 0);
    expect(out).toHaveLength(1);
  });
});
