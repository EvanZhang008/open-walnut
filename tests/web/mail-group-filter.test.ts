/**
 * The rule a group's `Keep out of Inbox…` writes (mail-group-filter.ts `filterRuleFor`), and the
 * card's sentences. Pure: the save itself is covered by the Playwright flow.
 *
 * - A group the model named matches on the GROUP, so every mail the model files there is moved,
 *   whoever sent it; `then` keeps the same name, so a move that fails leaves the mail in the group.
 * - A sender's group matches on the address (or the display name when there is none) and becomes a
 *   named group.
 * - Nothing to match on (no sender, no name): no rule, so the menu leaves the item out.
 */
import { describe, expect, it } from 'vitest';
import { filterRuleFor } from '../../web/src/apps/mail/mail-group-filter';
import {
  FILTER_MENU, filterCannotMoveText, filterCardBody, filterCardTitle, filterMoveNowLabel, filterSavedText,
} from '../../web/src/apps/mail/mail-groups-copy';

describe('filterRuleFor', () => {
  it('a model group matches on its name', () => {
    expect(filterRuleFor('u:build-results', 'Build results')).toEqual({ when: { group: 'Build results' }, then: 'Build results' });
    // A rename is what the person sees, so the rule follows the shown name.
    expect(filterRuleFor('u:ticket-updates', '  Tickets ')).toEqual({ when: { group: 'Tickets' }, then: 'Tickets' });
  });

  it('a sender group matches on the address, or on the name when the sender has none', () => {
    expect(filterRuleFor('s:news@shop.example.invalid', 'Shop news')).toEqual({
      when: { from: 'news@shop.example.invalid' }, then: 'Shop news', newGroup: 'Shop news',
    });
    expect(filterRuleFor('s:name:brand tide to shore', 'Brand Tide to Shore')).toEqual({
      when: { from: 'Brand Tide to Shore' }, then: 'Brand Tide to Shore', newGroup: 'Brand Tide to Shore',
    });
  });

  it('nothing to match on: no rule', () => {
    expect(filterRuleFor('s:unknown', 'Unknown sender')).toBeNull();
    expect(filterRuleFor('s:', 'Nobody')).toBeNull();
    expect(filterRuleFor('u:x', '   ')).toBeNull();
    expect(filterRuleFor('important', 'Important')).toBeNull();
  });
});

describe('the card copy', () => {
  it('says what happens, what does not, and what was saved', () => {
    expect(FILTER_MENU).toBe('Keep out of Inbox…');
    expect(filterCardTitle('Shop news')).toBe('Keep Shop news out of the Inbox?');
    expect(filterCardBody('Shop news')).toMatch(/moved to Archive as it arrives, and stays unread/);
    expect(filterMoveNowLabel(1)).toBe('Also move the 1 unread mail in it now');
    expect(filterMoveNowLabel(12)).toBe('Also move the 12 unread in it now');
    expect(filterCannotMoveText(['Ferry'])).toBe("Mail in Ferry can't be moved from Walnut; it stays in this group.");
    expect(filterSavedText('Shop news', 0)).toBe('New mail in Shop news now skips the Inbox.');
    expect(filterSavedText('Shop news', 3)).toBe('New mail in Shop news now skips the Inbox. Moving 3 to Archive.');
  });
});
