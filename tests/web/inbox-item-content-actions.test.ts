/**
 * An Inbox letter's email item offers Talk to CEO and New task, never a task button of its own
 * (2026-11-02, the user: a mail became a task with the raw mail pasted in). An older letter still
 * carries create/find/attach actions; the row shows none of them, whichever it holds.
 */
import { describe, expect, it } from 'vitest';
import type { InboxItemAction, InboxLetterItem } from '../../web/src/api/human-inbox-items';
import { LEGACY_TASK_INTENTS, itemContent, shownItemActions } from '../../web/src/components/inbox/item-receipt-model';
import { LEGACY_TASK_INTENTS as SERVER_LEGACY } from '../../src/core/human-inbox/item-schema';
import { contentDraftText } from '../../web/src/utils/content-actions';
import { EMAIL_SUMMARY_UNAVAILABLE } from '../../src/integrations/mail/digest-items';

const source = { kind: 'mail' as const, account: 'account-a', message: 'message-a' };

function letterItem(actions: InboxItemAction[], extra: Partial<InboxLetterItem> = {}): InboxLetterItem {
  return {
    id: 'item-a', subject: 'Benefits enrollment closes Nov 15', summary: 'Pick a plan by Friday.', source, actions,
    display: { sender: { name: 'HR Benefits', address: 'benefits@example.com' }, sentAt: '2026-11-02T17:14:00Z', accountLabel: 'Work' },
    ...extra,
  };
}

describe('inbox item content actions', () => {
  it('names the same retired intents as the server', () => {
    expect([...LEGACY_TASK_INTENTS].sort()).toEqual([...SERVER_LEGACY].sort());
  });

  it('shows no stored task intent, whatever an older letter carries', () => {
    const all: InboxItemAction[] = [
      { id: 'a:read', kind: 'op', intent: 'mark_read' },
      { id: 'a:find', kind: 'op', intent: 'find_task' },
      { id: 'a:create', kind: 'op', intent: 'create_task' },
      { id: 'a:ai', kind: 'reply_ai', label: 'Draft a reply', question: 'Draft a reply?' },
    ];
    const shown = shownItemActions(letterItem(all));
    expect(shown.map((a) => a.id)).toEqual(['a:read', 'a:ai']);
    expect(shownItemActions(letterItem([{ id: 'b:attach', kind: 'op', intent: 'attach_task' }]))).toEqual([]);
  });

  it('hands the email over with its sender, date, account, summary and Walnut link', () => {
    const content = itemContent(letterItem([]));
    expect(content).toEqual({
      source: 'Mail',
      title: 'Benefits enrollment closes Nov 15',
      summary: 'Pick a plan by Friday.',
      from: 'HR Benefits <benefits@example.com>',
      at: '2026-11-02T17:14:00Z',
      where: 'Work',
      open: '/mail?account=account-a&message=message-a',
    });
    const draft = contentDraftText(content);
    expect(draft.split('\n')[0]).toBe('Benefits enrollment closes Nov 15');
    expect(draft).toContain('Summary: Pick a plan by Friday.');
  });

  it('leaves out a summary the digest could not make', () => {
    // The server's own placeholder: a rename there fails here instead of quoting it to the CEO.
    expect(itemContent(letterItem([], { summary: EMAIL_SUMMARY_UNAVAILABLE })).summary).toBeUndefined();
  });
});
