import { describe, expect, it } from 'vitest';
import { isLocalDraftAsk } from '../../../src/core/org/user-kind.js';
import { LOCAL_DRAFT_ASKS, PROTECTED_DRAFT_ASKS } from '../../helpers/local-draft-asks.js';
import { answerHolds, answeredAbove, askKey, foldSameAsk } from '../../../src/core/same-ask.js';

describe('local unpublished asks mislabeled outward', () => {
  it.each(LOCAL_DRAFT_ASKS)('recognizes local preparation: %s', (ask) => {
    expect(isLocalDraftAsk(ask)).toBe(true);
  });

  it.each(PROTECTED_DRAFT_ASKS)('keeps outward or unclear steps protected: %s', (ask) => {
    expect(isLocalDraftAsk(ask)).toBe(false);
  });

  it('checks full details without truncating long text', () => {
    const ask = 'Draft a CR locally for review?';
    expect(isLocalDraftAsk(ask, 'Keep the draft local; do not publish it.')).toBe(true);
    expect(isLocalDraftAsk(ask, `${'Change description. '.repeat(400)}Then send it to the vendor.`)).toBe(false);
    expect(isLocalDraftAsk(ask, 'Then submit it after the user reviews it.')).toBe(false);
  });

  it('never carries draft approval into a send by shared words or reused decision id', () => {
    const ask = 'Draft an email to the customer about the outage locally for review?';
    const at = '2026-11-12T05:00:00.000Z';
    const answer = { key: askKey(ask), ask, text: 'Prepare only.', by: 'lead', byTitle: 'Lead', at, askId: 'ask-draft1', decisionKey: 'ask-draft1|r0' };
    const decision = { id: answer.askId, key: answer.decisionKey, said: true as const };
    for (const send of ['Email the customer about the outage?', 'Publish the CR now?', 'Submit the CR for review?']) {
      expect(answerHolds(answer, send, Date.parse(at))).toBe(false);
      expect(answerHolds(answer, send, Date.parse(at), decision)).toBe(false);
      expect(answeredAbove({ state: 'needs', source: 'session', ask: send, decision }, answer, Date.parse(at)).state).toBe('needs');
    }
    expect(answerHolds(answer, ask, Date.parse(at), decision)).toBe(true);
    expect(answerHolds(answer, ask, Date.parse(at), { ...decision, more: 'Then send it to the customer.' })).toBe(false);
    expect(answerHolds(answer, ask, Date.parse(at), { ...decision, kind: 'single', options: [{ id: 'send', label: 'Send it' }] })).toBe(false);
    expect(answeredAbove({ state: 'needs', source: 'session', ask, decision, askForm: { summary: ask, kind: 'yes_no', more: 'Then share it with the customer.' } }, answer, Date.parse(at)).state).toBe('needs');
    expect(answeredAbove({ state: 'needs', source: 'session', ask, decision, askForm: { summary: ask, kind: 'single', options: [{ id: 'send', label: 'Send it' }] } }, answer, Date.parse(at)).state).toBe('needs');
  });

  it('does not fold a protected ask under an answered teammate draft or retain an old fold', () => {
    const ask = 'Draft an email to the customer locally for review?';
    const relative = { id: 'a', title: 'Draft task', ask, answered: true as const };
    const plain = { state: 'needs' as const, source: 'session' as const, ask };
    const folded = foldSameAsk('b', plain, [], { relatives: [relative] });
    expect(folded.state).toBe('waiting');
    for (const form of [
      { summary: ask, kind: 'yes_no' as const, more: 'Then send it to the customer.' },
      { summary: ask, kind: 'single' as const, options: [{ id: 'send', label: 'Send it' }] },
    ]) {
      const derived = { ...plain, askForm: form };
      expect(foldSameAsk('b', derived, [], { relatives: [relative] }).state).toBe('needs');
      expect(foldSameAsk('b', derived, [relative], { prev: folded, answeredThere: () => true }).state).toBe('needs');
    }
  });

  it('does not treat already unpublished history as a promise not to send', () => {
    expect(isLocalDraftAsk('Draft the email and send it?', 'It has not been sent yet.')).toBe(false);
  });
});
