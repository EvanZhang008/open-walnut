/**
 * The correction card's rules as data: which destinations step 1 offers (Important, Not important for
 * mail in Important, the model's groups, a sender's own group), which new group names are refused, how
 * step 2 orders and pre-selects drafts, what `Save rule` writes, and what an Undo removes.
 */
import { describe, expect, it } from 'vitest';
import type { MailCatalogItem, MailProposeResponse } from '../../web/src/api/mail-groups';
import {
  COPY,
  correctChoices,
  defaultOptionKey,
  docOf,
  groupIdForName,
  groupLabelOf,
  idForTarget,
  initialFocusIndex,
  localOptions,
  matchesLine,
  modelCellSentence,
  modelOption,
  newGroupProblem,
  newRuleId,
  recipientsSentence,
  saveRefusalOf,
  savedSentence,
  shadowSentence,
  slugOf,
  todayIso,
  undoLearnedRules,
  whereSentence,
  withLearnedRule,
  withoutRules,
  type RuleOption,
} from '../../web/src/apps/mail/mail-correct-model';

// What `GET /rules` answers: the two reserved names, then the model's groups with unread mail
// (newest first, one of them renamed), then a rule's own target.
const CATALOG: MailCatalogItem[] = [
  { id: 'important', label: 'Important', source: 'reserved' },
  { id: 'not-important', label: 'Not important', source: 'reserved' },
  { id: 'u:ticket-updates', label: 'Tickets', source: 'group' },
  { id: 'u:pager-alerts', label: 'Pager alerts', source: 'group' },
  { id: 'u:on-call-tickets', label: 'On-call & tickets', source: 'rule' },
];

function draft(kind: MailProposeResponse['drafts'][number]['kind'], moves: number, extra: Partial<MailProposeResponse['drafts'][number]> = {}) {
  return {
    kind, when: { from: 'desk@ferry.example.invalid' }, then: 'Important', summary: `summary ${kind}`,
    matches: moves + 2, moves, samples: [], shadows: [], ...extra,
  };
}

describe('step 1: where', () => {
  it('offers Important, Not important and every group for mail in Important, with Keep in Important', () => {
    const choices = correctChoices(CATALOG, 'important');
    expect(choices.map((one) => one.label)).toEqual([
      'Keep in Important', 'Not important', 'Tickets', 'Pager alerts', 'On-call & tickets',
    ]);
    expect(choices.map((one) => one.value)).toEqual([
      'important', 'not-important', 'u:ticket-updates', 'u:pager-alerts', 'u:on-call-tickets',
    ]);
  });

  it('offers no Not important for mail already in a group, and keeps it where it is by its shown name', () => {
    const choices = correctChoices(CATALOG, 'u:ticket-updates');
    expect(choices.map((one) => one.label)).toEqual(['Important', 'Keep in Tickets', 'Pager alerts', 'On-call & tickets']);
    expect(choices.find((one) => one.keep)?.target).toBe('Tickets');
    expect(whereSentence(groupLabelOf(CATALOG, 'u:ticket-updates'))).toBe('This mail is in Tickets. Where should it go?');
  });

  it('gives a sender\'s own group (not in the catalog) its keep option under the row\'s name', () => {
    const choices = correctChoices(CATALOG, 's:issues@tickets.example.invalid', 'Ticket Board');
    expect(choices.map((one) => one.label)).toEqual(['Important', 'Keep in Ticket Board', 'Tickets', 'Pager alerts', 'On-call & tickets']);
    expect(groupLabelOf(CATALOG, 's:issues@tickets.example.invalid', 'Ticket Board')).toBe('Ticket Board');
    expect(groupLabelOf(CATALOG, 's:issues@tickets.example.invalid')).toBe('issues@tickets.example.invalid');
  });

  it('focuses the preset the menu named, else the first option that is not the current group', () => {
    expect(initialFocusIndex(correctChoices(CATALOG, 'important'))).toBe(1);
    expect(initialFocusIndex(correctChoices(CATALOG, 'important'), 'not-important')).toBe(1);
    expect(initialFocusIndex(correctChoices(CATALOG, 'u:pager-alerts'), 'important')).toBe(0);
    expect(initialFocusIndex(correctChoices(CATALOG, 'u:pager-alerts'))).toBe(0);
    expect(initialFocusIndex(correctChoices(CATALOG, 'u:pager-alerts'), 'u:gone')).toBe(0);
  });

  it('resolves a target by its shown (renamed) name first, then by slug', () => {
    expect(idForTarget(CATALOG, 'tickets')).toBe('u:ticket-updates');
    expect(idForTarget(CATALOG, 'Not important')).toBe('not-important');
    expect(idForTarget(CATALOG, 'Harbour club')).toBe('u:harbour-club');
  });

  it('refuses a new group name that exists, collides by id, or is too long', () => {
    expect(newGroupProblem('', CATALOG)).toBe('');
    expect(newGroupProblem('tickets', CATALOG)).toBe(COPY.groupExists);
    expect(newGroupProblem('Important', CATALOG)).toBe(COPY.groupExists);
    expect(newGroupProblem('not important', CATALOG)).toBe(COPY.groupExists);
    expect(newGroupProblem('On-call  tickets', CATALOG)).toBe('"On-call & tickets" and "On-call  tickets" are too similar. Rename one of them.');
    expect(newGroupProblem('Ticket updates', CATALOG)).toBe('"Tickets" and "Ticket updates" are too similar. Rename one of them.');
    expect(newGroupProblem('x'.repeat(41), CATALOG)).toBe('A group name is at most 40 characters.');
    expect(newGroupProblem('Harbour club', CATALOG)).toBeNull();
    // Unicode letters count as letters, the same as the server's slug (test data as escapes).
    expect(slugOf('Caf\u00e9 & Co')).toBe('caf\u00e9-co');
    expect(groupIdForName('A&B')).toBe(groupIdForName('A B'));
    expect(groupIdForName('Not Important')).toBe('not-important');
  });
});

describe('step 2: drafts', () => {
  const response = {
    drafts: [
      draft('sender', 40),
      draft('message', 0, { summary: 'Only this mail', label: 'Only the mail "Window 14" from Change Desk, Sep 28' }),
      draft('sender-subject', 12),
      draft('sender-not-direct', 3),
      draft('sender-direct', 2),
    ],
    recipients: { thisMail: 'known' as const, known: 2, of: 20 },
    model: { status: 'skipped' as const },
  };

  it('orders direct and not-direct (server order kept) then subject, sender, only this mail', () => {
    expect(localOptions(response).map((one) => one.kind)).toEqual([
      'sender-not-direct', 'sender-direct', 'sender-subject', 'sender', 'message',
    ]);
  });

  it('picks the first draft by default, but never one moving more than the sender draft', () => {
    const local = localOptions(response);
    expect(defaultOptionKey(local)).toBe('sender-not-direct');
    const wide = modelOption({ status: 'ok', draft: { when: { from: '*' }, then: 'Important', summary: 'wide', matches: 900, moves: 800 } })!;
    expect(defaultOptionKey([wide, ...local])).toBe('sender-not-direct');
    const narrow = modelOption({ status: 'ok', draft: { when: { from: 'x' }, then: 'Important', summary: 'narrow', matches: 9, moves: 5 } })!;
    expect(narrow.fromNote).toBe(true);
    expect(defaultOptionKey([narrow, ...local])).toBe('model');
    expect(defaultOptionKey([])).toBeNull();
  });

  it('says the model outcome in the reserved cell, with the recipients sentence for recipients-unknown', () => {
    expect(modelCellSentence({ status: 'unavailable' })).toBe(COPY.modelFailed);
    expect(modelCellSentence({ status: 'invalid' })).toBe(COPY.modelFailed);
    expect(modelCellSentence({ status: 'timeout' })).toBe(COPY.modelFailed);
    expect(modelCellSentence({ status: 'invalid', reason: 'recipients-unknown' })).toBe(COPY.recipientsUnknown);
    expect(modelCellSentence({ status: 'skipped' })).toBeNull();
    expect(COPY.modelFailed).toBe("Walnut couldn't turn your note into a rule. Your note is saved with the rule you pick.");
  });

  it('writes the matches line with scope, moves only when fewer than matches, bold over 50, at least when partial', () => {
    expect(matchesLine({ matches: 8, moves: 8 }, false)).toEqual({ head: 'Matches 8 mails in this inbox', moves: null, bold: false });
    expect(matchesLine({ matches: 169, moves: 161 }, true)).toEqual({ head: 'Matches 169 mails in your inboxes', moves: 'moves 161', bold: true });
    expect(matchesLine({ matches: 1, moves: 1 }, false).head).toBe('Matches 1 mail in this inbox');
    expect(matchesLine({ matches: 1200, moves: 30, partial: true }, false)).toEqual({ head: 'Matches at least 1,200 mails in this inbox', moves: 'moves 30', bold: false });
  });

  it('says the coverage and the shadow sentences verbatim', () => {
    expect(recipientsSentence({ thisMail: 'known', known: 2, of: 20 })).toBe('Walnut knows the recipients of 2 of 20 mails from this sender.');
    expect(recipientsSentence({ thisMail: 'known', known: 20, of: 20 })).toBeNull();
    expect(recipientsSentence({ thisMail: 'unknown', known: 0, of: 20 })).toBe(COPY.recipientsUnknown);
    expect(shadowSentence({ ruleId: 'r-aaaaaa', summary: 'Change Desk goes to Notifications', mails: 14 }))
      .toBe('This overrides your rule "Change Desk goes to Notifications" for 14 mails.');
  });
});

describe('step 4: what Save rule writes, and Undo', () => {
  const current = docOf({
    groups: ['On-call & tickets'],
    rules: [
      { id: 'r-111111', when: { from: 'issues@*' }, then: 'On-call & tickets', source: 'learned', summary: 'x' },
      { id: 'r-222222', when: { from: 'payroll', account: 'ferry' }, then: 'Notifications', source: 'user', summary: 'y' },
    ],
  });
  const option: Pick<RuleOption, 'when' | 'then' | 'label'> = { when: { from: 'Change Desk', addressedToMe: true, account: 'ferry' }, then: 'Important' };

  it('puts the learned rule first with the note verbatim, and strips view-only summaries', () => {
    const next = withLearnedRule(current, { rule: option, note: '  sent to me directly  ', id: 'r-abcdef', created: '2026-09-28' });
    expect(next.rules[0]).toEqual({
      id: 'r-abcdef', when: option.when, then: 'Important', source: 'learned', note: '  sent to me directly  ', created: '2026-09-28',
    });
    expect(next.rules.slice(1).every((one) => !('summary' in one))).toBe(true);
    expect(next.groups).toEqual(['On-call & tickets']);
    const bare = withLearnedRule(current, { rule: option, note: '   ', id: 'r-abcdef', created: '2026-09-28' });
    expect('note' in bare.rules[0]!).toBe(false);
  });

  it('inserts under an earlier rule kept first, and appends a new group once', () => {
    const next = withLearnedRule(current, { rule: { ...option, then: 'Harbour club' }, note: '', id: 'r-abcdef', created: '2026-09-28', insertAt: 1, newGroup: 'Harbour club' });
    expect(next.rules.map((one) => one.id)).toEqual(['r-111111', 'r-abcdef', 'r-222222']);
    expect(next.groups).toEqual(['On-call & tickets', 'Harbour club']);
  });

  it('undo removes exactly the saved rules, and the created group only when nothing else uses it', () => {
    const saved = withLearnedRule(current, { rule: { ...option, then: 'Harbour club' }, note: '', id: 'r-abcdef', created: '2026-09-28', newGroup: 'Harbour club' });
    const undone = withoutRules(saved, ['r-abcdef'], 'Harbour club');
    expect(undone).toEqual(current);
    const stillUsed = withoutRules(saved, ['r-111111'], 'Harbour club');
    expect(stillUsed.groups).toContain('Harbour club');
  });

  it('undo chains on the save fileRev, and re-reads the file once when it moved (409 changed)', async () => {
    const puts: Array<{ baseRev: string; ids: string[] }> = [];
    let refuse = true;
    const api = {
      get: async () => ({ groups: [], rules: [{ id: 'r-999999', when: { from: 'x' }, then: 'Important', source: 'user' as const }, { id: 'r-abcdef', when: { from: 'y' }, then: 'Important', source: 'learned' as const }], fileRev: 'disk2' }),
      put: async (body: { baseRev: string; rules: Array<{ id?: string }> }) => {
        puts.push({ baseRev: body.baseRev, ids: body.rules.map((one) => one.id!) });
        if (refuse) { refuse = false; throw Object.assign(new Error('changed'), { status: 409, body: { error: 'changed' } }); }
        return { fileRev: 'disk3' };
      },
    };
    const saved = withLearnedRule(current, { rule: option, note: '', id: 'r-abcdef', created: '2026-09-28' });
    const outcome = await undoLearnedRules(api, { doc: saved, fileRev: 'disk1', ruleIds: ['r-abcdef'] });
    expect(outcome).toEqual({ ok: true, fileRev: 'disk3' });
    expect(puts).toEqual([
      { baseRev: 'disk1', ids: ['r-111111', 'r-222222'] },
      { baseRev: 'disk2', ids: ['r-999999'] },
    ]);
  });

  it('reads refusals into the three drawn cases', () => {
    expect(saveRefusalOf({ status: 409, body: { error: 'changed' } })).toEqual({ kind: 'changed', message: COPY.changedOnDisk });
    expect(saveRefusalOf({ status: 400, body: { error: 'invalid', errors: [{ index: 0, field: 'then', message: 'then: Notifcations is not a group. Did you mean Notifications?' }] } }))
      .toEqual({ kind: 'invalid', message: 'then: Notifcations is not a group. Did you mean Notifications?', field: 'then', index: 0 });
    expect(saveRefusalOf(new Error('Failed to fetch'))).toEqual({ kind: 'network', message: "Couldn't save the rule: Failed to fetch." });
    expect(savedSentence(14, 'Important')).toBe('Saved. 14 mails moved to Important.');
    expect(savedSentence(1, 'Group mail')).toBe('Saved. 1 mail moved to Group mail.');
    expect(savedSentence(3, 'Not important')).toBe('Saved. 3 mails moved out of Important.');
  });

  it('makes r- + 6 hex ids and local dates', () => {
    expect(newRuleId(() => 0.5)).toBe('r-888888');
    expect(newRuleId()).toMatch(/^r-[0-9a-f]{6}$/);
    expect(todayIso(new Date(2026, 8, 28, 23, 59))).toBe('2026-09-28');
  });
});
