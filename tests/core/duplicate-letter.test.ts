/**
 * One sender, one letter per question (2026-11-02 org review: a lead sent one decision letter
 * three times in 47 seconds, another twice one second apart, then posted one reply twice).
 * The pure rules of core/human-inbox/duplicate-letter.ts. Non-ASCII subjects are test data
 * (escaped), shaped like the review's: a CJK question with Latin names in it.
 */
import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_WINDOW_MS, SIMILAR_SUBJECT_MIN, findDuplicateLetter, findDuplicateReply, findOpenSameAsk,
  normalizeText, resendReasonOf, senderKey, textSimilarity,
} from '../../src/core/human-inbox/duplicate-letter.js';
import type { LetterRecord, LetterSender } from '../../src/core/human-inbox/types.js';

// "Scanner CVE: delete 6 idle resource groups?" and a rewording; "Alex cannot open Sam's promotion doc, grant access?" and a rewording.
const DELETE = 'Scanner CVE\uff1a\u5220\u6389 6 \u7ec4\u95f2\u7f6e\u8d44\u6e90\u5417\uff1f';
const DELETE_REWORDED = 'Scanner CVE\uff1a\u8981\u5220\u6389\u8fd9 6 \u7ec4\u95f2\u7f6e\u8d44\u6e90\u5417\uff1f';
const ACCESS = 'Alex \u6253\u4e0d\u5f00 Sam \u7684\u664b\u5347\u6587\u6863\uff0c\u8981\u7ed9\u4ed6\u5f00\u6743\u9650\u5417\uff1f';
const ACCESS_REWORDED = '要给 Alex 开 Sam 晋升文档的权限吗？';

const LEAD: LetterSender = { sessionId: 's-lead', taskId: 't-lead', host: 'local' };
const NOW = 1_800_000_000_000;
let n = 0;
const letter = (over: Partial<LetterRecord> = {}): LetterRecord => ({
  id: `lt-test-${n++}`, subject: DELETE, type: 'action_required', bodyFormat: 'markdown', textPreview: '',
  sender: LEAD, createdAt: NOW - 30_000, read: false, pinned: false, archived: false, thread: [], ...over,
});

describe('duplicate letters: the pure rules', () => {
  it('normalizes case, spacing and trailing punctuation, full-width too', () => {
    expect(normalizeText('  Delete   the GROUPS?!  ')).toBe('delete the groups');
    expect(normalizeText(DELETE)).toBe(normalizeText('scanner cve:\u5220\u6389 6 \u7ec4\u95f2\u7f6e\u8d44\u6e90\u5417'));
  });

  it('a sender is its task, else its session; never an external or a plugin sender', () => {
    expect(senderKey(LEAD)).toBe('task:t-lead');
    expect(senderKey({ sessionId: 's-1', host: 'local' })).toBe('session:s-1');
    expect(senderKey({ sessionId: 'external', host: 'local' })).toBeNull();
    expect(senderKey({ sessionId: 'external', host: 'local', pluginId: 'mail', taskId: 't-x' })).toBeNull();
  });

  it('the review\'s subjects: a rewording reads as the same ask, the two questions as different', () => {
    expect(textSimilarity(DELETE, DELETE_REWORDED)).toBeGreaterThanOrEqual(SIMILAR_SUBJECT_MIN);
    expect(textSimilarity(ACCESS, ACCESS_REWORDED)).toBeGreaterThanOrEqual(SIMILAR_SUBJECT_MIN);
    expect(textSimilarity(DELETE, ACCESS)).toBeLessThan(0.2);
    expect(textSimilarity('Delete 6 idle resource groups for the CVE?', 'Delete the 6 idle resource groups (CVE)?')).toBeGreaterThanOrEqual(SIMILAR_SUBJECT_MIN);
    expect(textSimilarity('Pick a name', 'Pick a color')).toBeLessThan(SIMILAR_SUBJECT_MIN);
  });

  it('the same subject from the same sender inside the window is a duplicate; outside it, or from another sender, is not', () => {
    const first = letter({ createdAt: NOW - 47_000 });
    const second = letter({ createdAt: NOW - 1_000 });
    expect(findDuplicateLetter({ subject: `${DELETE} `, sender: LEAD }, [first, second], NOW)?.id).toBe(second.id);
    // Answered or archived, it is still the same letter a minute ago.
    expect(findDuplicateLetter({ subject: DELETE, sender: LEAD }, [letter({ archived: true })], NOW)).not.toBeNull();
    expect(findDuplicateLetter({ subject: DELETE, sender: LEAD }, [letter({ createdAt: NOW - DUPLICATE_WINDOW_MS - 1 })], NOW)).toBeNull();
    expect(findDuplicateLetter({ subject: DELETE, sender: { ...LEAD, taskId: 't-main', sessionId: 's-main' } }, [first], NOW)).toBeNull();
    expect(findDuplicateLetter({ subject: ACCESS, sender: LEAD }, [first], NOW)).toBeNull();
    // Only an exact repeat is refused; a rewording is a hint (below).
    expect(findDuplicateLetter({ subject: DELETE_REWORDED, sender: LEAD }, [first], NOW)).toBeNull();
    expect(findDuplicateLetter({ subject: DELETE, sender: { sessionId: 'external', host: 'local' } }, [letter({ sender: { sessionId: 'external', host: 'local' } })], NOW)).toBeNull();
  });

  it('an open decision letter asking the same thing is found; an answered, settled or archived one is not', () => {
    const old = letter({ createdAt: NOW - 3 * 60 * 60_000 });
    expect(findOpenSameAsk({ subject: DELETE, sender: LEAD }, [old])?.letter.id).toBe(old.id);
    expect(findOpenSameAsk({ subject: DELETE_REWORDED, sender: LEAD }, [old])?.letter.id).toBe(old.id);
    expect(findOpenSameAsk({ subject: ACCESS, sender: LEAD }, [old])).toBeNull();
    expect(findOpenSameAsk({ subject: DELETE, sender: LEAD }, [letter({ answered: { actionId: 'a', label: 'A', at: NOW } })])).toBeNull();
    expect(findOpenSameAsk({ subject: DELETE, sender: LEAD }, [letter({ settled: { reason: 'done', at: NOW } as never })])).toBeNull();
    expect(findOpenSameAsk({ subject: DELETE, sender: LEAD }, [letter({ archived: true })])).toBeNull();
    expect(findOpenSameAsk({ subject: DELETE, sender: LEAD }, [letter({ type: 'info' })])).toBeNull();
  });

  it('a reply repeating the latest agent turn inside the window is a duplicate', () => {
    const l = letter({ thread: [{ from: 'agent', text: 'Deleted 6 groups. Nothing else changed.', at: NOW - 20_000 }] });
    expect(findDuplicateReply(l, 'Deleted 6 groups. Nothing else changed', NOW)).not.toBeNull();
    expect(findDuplicateReply(l, 'Deleted 6 groups; the 7th is still in use, kept.', NOW)).toBeNull();
    expect(findDuplicateReply({ thread: [...l.thread, { from: 'human', text: 'ok', at: NOW - 5_000 }] }, 'Deleted 6 groups. Nothing else changed.', NOW)).not.toBeNull();
    expect(findDuplicateReply(l, 'Deleted 6 groups. Nothing else changed.', NOW + DUPLICATE_WINDOW_MS)).toBeNull();
    expect(findDuplicateReply(letter(), 'anything', NOW)).toBeNull();
  });

  it('a resend reason counts from ten characters, either spelling', () => {
    expect(resendReasonOf({ resend_reason: 'too short' })).toBe('');
    expect(resendReasonOf({ resend_reason: '  The first one had the wrong account id  ' })).toBe('The first one had the wrong account id');
    expect(resendReasonOf({ resendReason: 'The user asked for it again' })).toBe('The user asked for it again');
  });
});
