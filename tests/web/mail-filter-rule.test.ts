/**
 * The rule "Filter mails like these…" writes (web/src/apps/mail/mail-filter-save.ts):
 * `folderFilterRule` and `folderProblem` (pure), plus `saveFolderFilter` against a mocked rules API.
 *
 * A class check at the end runs one table of folder names through all three gates a name passes
 * (the card's `folderProblem`, Settings' `folderProblem`, the server schema's `moveToProblem`, the
 * IMAP provider's `folderNameProblem`) and pins that they give the same answer, so a name the card takes is never
 * refused by the server or the provider later.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailRule } from '../../web/src/api/mail-groups';

const api = vi.hoisted(() => ({
  getMailRules: vi.fn(),
  putMailRules: vi.fn(),
  applyMailRule: vi.fn(),
  pushLearnedUndo: vi.fn(),
}));

vi.mock('@/api/mail-groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/src/api/mail-groups')>()),
  getMailRules: api.getMailRules,
  putMailRules: api.putMailRules,
  applyMailRule: api.applyMailRule,
}));
// The status strip lives in a React module; only its push is observed here.
vi.mock('../../web/src/apps/mail/MailCorrectPopover', () => ({ pushLearnedUndo: api.pushLearnedUndo }));

import { MAX_FOLDER } from '../../web/src/apps/mail/mail-filter-defaults';
import { MAX_FOLDER_NAME, folderFilterRule, folderProblem, saveFolderFilter } from '../../web/src/apps/mail/mail-filter-save';
import { FOLDER_FILTER_NEEDS_MATCH } from '../../web/src/apps/mail/mail-groups-copy';
import { MAX_FOLDER_NAME as SERVER_MAX_FOLDER_NAME, moveToProblem } from '../../src/integrations/mail/sort-rules-schema';
import { folderNameProblem } from '../../src/integrations/mail-imap/provider';
import { folderProblem as settingsFolderProblem } from '../../web/src/components/settings/sections/mail-rules-model';

describe('folderFilterRule', () => {
  it('neither From nor Subject is a problem, whitespace included', () => {
    expect(folderFilterRule({ fromContains: '', subject: '', folder: 'Receipts' })).toEqual({ problem: FOLDER_FILTER_NEEDS_MATCH });
    expect(folderFilterRule({ fromContains: '  ', subject: '\t', folder: 'Receipts' })).toEqual({ problem: FOLDER_FILTER_NEEDS_MATCH });
  });

  it('the match check comes before the folder check', () => {
    expect(folderFilterRule({ fromContains: '', subject: '', folder: 'INBOX' })).toEqual({ problem: FOLDER_FILTER_NEEDS_MATCH });
  });

  it('only From works, trimmed', () => {
    expect(folderFilterRule({ fromContains: '  ci-bot@ferry-ci.example.invalid ', subject: '', folder: ' CI Runs ' })).toEqual({
      when: { fromContains: 'ci-bot@ferry-ci.example.invalid' }, then: 'CI Runs', moveTo: 'CI Runs',
    });
  });

  it('only Subject works, trimmed', () => {
    expect(folderFilterRule({ fromContains: ' ', subject: '  [acme/ferry] Run failed  ', folder: 'CI Runs' })).toEqual({
      when: { subject: '[acme/ferry] Run failed' }, then: 'CI Runs', moveTo: 'CI Runs',
    });
  });

  it('both fields go into one when', () => {
    const rule = folderFilterRule({ fromContains: 'ci-bot', subject: 'Run failed', folder: 'CI Runs' });
    expect(rule).toEqual({ when: { fromContains: 'ci-bot', subject: 'Run failed' }, then: 'CI Runs', moveTo: 'CI Runs' });
  });

  it("then is the folder's last path part; moveTo keeps the whole path", () => {
    expect(folderFilterRule({ fromContains: 'x', subject: '', folder: 'Projects/Ferry/Builds' })).toEqual({
      when: { fromContains: 'x' }, then: 'Builds', moveTo: 'Projects/Ferry/Builds',
    });
  });

  it('then collapses inner whitespace', () => {
    const rule = folderFilterRule({ fromContains: 'x', subject: '', folder: 'Team/Night    Builds' });
    expect(rule).toMatchObject({ then: 'Night Builds', moveTo: 'Team/Night    Builds' });
  });

  it(`then is cut to ${MAX_FOLDER} characters; moveTo is not`, () => {
    const folder = 'Notifications from the quarterly planning committee';
    const rule = folderFilterRule({ fromContains: 'x', subject: '', folder });
    if ('problem' in rule) throw new Error(rule.problem);
    expect(rule.then.length).toBeLessThanOrEqual(MAX_FOLDER);
    expect(rule.then).toBe(folder.slice(0, MAX_FOLDER).trim());
    expect(rule.moveTo).toBe(folder);
  });

  it('a trailing slash (an empty last part) is a problem, not a rule', () => {
    expect(folderFilterRule({ fromContains: 'x', subject: '', folder: 'Projects/' })).toEqual({ problem: folderProblem('Projects/') });
    expect(folderProblem('Projects/')).toBeTruthy();
  });

  it('an account narrows the rule to that account, trimmed; blank means every account', () => {
    expect(folderFilterRule({ fromContains: 'x', subject: '', folder: 'Receipts', accountId: ' acct-7 ' })).toEqual({
      when: { fromContains: 'x', account: 'acct-7' }, then: 'Receipts', moveTo: 'Receipts',
    });
    expect(folderFilterRule({ fromContains: 'x', subject: '', folder: 'Receipts', accountId: '  ' })).toEqual({
      when: { fromContains: 'x' }, then: 'Receipts', moveTo: 'Receipts',
    });
  });

  it('a reserved group name gets " (filed)" so the rule is not a plain Not important rule', () => {
    expect(folderFilterRule({ fromContains: 'x', subject: '', folder: 'Not important' })).toMatchObject({ then: 'Not important (filed)', moveTo: 'Not important' });
    expect(folderFilterRule({ fromContains: 'x', subject: '', folder: 'Work/not important' })).toMatchObject({ then: 'not important (filed)', moveTo: 'Work/not important' });
  });

  it('"Important" is a system folder name (Gmail keeps one), so it is refused rather than renamed', () => {
    for (const folder of ['Important', 'IMPORTANT', 'Work/Important']) {
      const rule = folderFilterRule({ fromContains: 'x', subject: '', folder });
      expect(rule, folder).toEqual({ problem: folderProblem(folder) });
      expect(folderProblem(folder), folder).toMatch(/keeps for itself/);
    }
  });

  it('a bad folder name is the problem', () => {
    for (const folder of ['', '  ', 'INBOX', 'inbox', '[Gmail]/Spam', 'Builds*', 'Half%', 'Two\nLines', 'Trash', 'a//b', 'x'.repeat(MAX_FOLDER_NAME + 1)]) {
      const rule = folderFilterRule({ fromContains: 'x', subject: '', folder });
      expect(rule, JSON.stringify(folder)).toEqual({ problem: folderProblem(folder) });
      expect(folderProblem(folder)).toBeTruthy();
    }
  });
});

describe('folderProblem', () => {
  it('names each problem in its own sentence', () => {
    expect(folderProblem('')).toBe('Name the folder.');
    expect(folderProblem('   ')).toBe('Name the folder.');
    expect(folderProblem('x'.repeat(201))).toBe('A folder name is at most 200 characters.');
    expect(folderProblem('a*b')).toBe('A folder name cannot hold control characters, * or %.');
    expect(folderProblem('a\u0007b')).toBe('A folder name cannot hold control characters, * or %.');
    expect(folderProblem(' Inbox ')).toBe('Mail cannot be filed into the Inbox it leaves.');
    expect(folderProblem('[GMAIL]/Starred')).toBe('Gmail keeps its own [Gmail] folders; name a folder of your own.');
    expect(folderProblem('Projects//CI')).toBe('A folder name cannot have an empty level (two "/" in a row, or one at an end).');
    expect(folderProblem('Old/Junk')).toBe('"Junk" is a folder your mail server keeps for itself (Trash, Junk, Sent and the like). Name a folder of your own.');
  });

  it('accepts ordinary names, trimmed to their length', () => {
    for (const name of ['Receipts', 'Projects/Ferry Builds', 'Inbox copies', 'My [Gmail] notes', ` ${'x'.repeat(200)} `]) {
      expect(folderProblem(name), name).toBeNull();
    }
  });
});

/**
 * One table, four gates. All read the one rule set in src/integrations/mail/folder-name.ts, so
 * every verdict and every sentence matches, with two exceptions for a blank name: the server
 * schema's `moveToProblem` first checks the value is a non-blank text and says "moveTo must name a
 * folder.", and Settings' `folderProblem` answers null (a blank folder there means "no folder", the
 * Archive) where the card and IMAP say "Name the folder.". This table is the class guard:
 * a gate that grows a rule of its own (an earlier server schema let `*`, `%` and `[Gmail]/...`
 * through while IMAP refused them, so a saved filter failed batch after batch) fails here.
 */
describe('folderProblem agrees with the Settings, server and IMAP gates', () => {
  const NAMES = [
    'Receipts', 'Projects/Ferry Builds', 'Inbox copies', 'INBOXES', 'My [Gmail] notes', 'Not important', 'x'.repeat(200),
    '', '   ', 'INBOX', 'inbox', ' Inbox ', 'Line\nBreak', 'Tab\there', 'Bell\u0007', 'Del\u007f', 'x'.repeat(201),
    'Builds*', 'Half%', '[Gmail]/Spam', '[gmail]/All Mail', '[Google Mail]/Sent Mail',
    'a//b', '/Receipts', 'Receipts/', 'v1..2', 'Acme Inc.',
    'Trash', 'Projects/Spam', 'Old.Junk', 'Sent Items', 'Drafts', 'Important', 'Starred', 'Work/INBOX',
  ];

  it('the two limits are the same number', () => {
    expect(MAX_FOLDER_NAME).toBe(SERVER_MAX_FOLDER_NAME);
  });

  for (const name of NAMES) {
    const label = name.length > 24 ? `${name.slice(0, 6)}... (${name.length} chars)` : JSON.stringify(name);
    it(`${label}: card, Settings, server and IMAP give the same answer`, () => {
      const card = folderProblem(name);
      expect(folderNameProblem(name)).toBe(card);
      if (name.trim()) {
        expect(moveToProblem(name)).toBe(card);
        expect(settingsFolderProblem(name)).toBe(card);
      } else {
        expect(card).toBe('Name the folder.');
        expect(moveToProblem(name)).toBe('moveTo must name a folder.');
        expect(settingsFolderProblem(name)).toBeNull();
      }
    });
  }

  it('the table holds names the gates take and names they refuse', () => {
    const taken = NAMES.filter((name) => folderProblem(name) === null);
    expect(taken).toEqual(['Receipts', 'Projects/Ferry Builds', 'Inbox copies', 'INBOXES', 'My [Gmail] notes', 'Not important', 'x'.repeat(200)]);
  });

  it('the server refuses a value that is not a text; the card never sees one', () => {
    for (const value of [undefined, null, 42, ['Receipts']]) expect(moveToProblem(value)).toBe('moveTo must name a folder.');
  });
});

describe('saveFolderFilter', () => {
  const EXISTING: MailRule = { id: 'r-000001', when: { from: 'wren@ferry-ci.example.invalid' }, then: 'Important', source: 'user' };

  beforeEach(() => {
    api.getMailRules.mockReset();
    api.putMailRules.mockReset();
    api.applyMailRule.mockReset();
    api.pushLearnedUndo.mockReset();
    api.getMailRules.mockResolvedValue({ groups: ['Newsletters'], rules: [EXISTING], fileRev: 'rev-1' });
    api.putMailRules.mockResolvedValue({ fileRev: 'rev-2' });
  });

  it("writes the person's own rule first in the file, with moveTo and a new group", async () => {
    const out = await saveFolderFilter({ fromContains: 'ci-bot', subject: '', folder: 'Projects/CI Runs', moveNow: false, viewKey: 'inbox' });
    expect(out).toEqual({ queued: 0 });
    expect(api.putMailRules).toHaveBeenCalledTimes(1);
    const body = api.putMailRules.mock.calls[0]![0];
    expect(body.baseRev).toBe('rev-1');
    expect(body.groups).toEqual(['Newsletters', 'CI Runs']);
    expect(body.rules).toHaveLength(2);
    expect(body.rules[0]).toMatchObject({ when: { fromContains: 'ci-bot' }, then: 'CI Runs', moveTo: 'Projects/CI Runs', source: 'user' });
    expect(body.rules[1]).toEqual(EXISTING);
    expect(api.applyMailRule).not.toHaveBeenCalled();
    expect(api.pushLearnedUndo).toHaveBeenCalledWith(expect.objectContaining({
      viewKey: 'inbox', fileRev: 'rev-2', createdGroup: 'CI Runs', text: 'Filter saved: new mail like this goes to Projects/CI Runs.',
    }));
  });

  it('a group the file already lists is not new (case-insensitive), so Undo will not drop it', async () => {
    await saveFolderFilter({ fromContains: 'x', subject: '', folder: 'newsletters', moveNow: false, viewKey: 'inbox' });
    const body = api.putMailRules.mock.calls[0]![0];
    expect(body.groups).toEqual(['Newsletters']);
    expect(api.pushLearnedUndo.mock.calls[0]![0].createdGroup).toBeUndefined();
  });

  it('a problem throws before any request', async () => {
    await expect(saveFolderFilter({ fromContains: '', subject: '', folder: 'Receipts', moveNow: true, viewKey: 'inbox' }))
      .rejects.toThrow(FOLDER_FILTER_NEEDS_MATCH);
    expect(api.getMailRules).not.toHaveBeenCalled();
    expect(api.putMailRules).not.toHaveBeenCalled();
  });

  it('a file that changed on disk is re-read and the save retried once', async () => {
    api.getMailRules
      .mockResolvedValueOnce({ groups: [], rules: [], fileRev: 'rev-1' })
      .mockResolvedValueOnce({ groups: [], rules: [EXISTING], fileRev: 'rev-9' });
    api.putMailRules
      .mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409, body: { error: 'changed' } }))
      .mockResolvedValueOnce({ fileRev: 'rev-10' });
    await saveFolderFilter({ fromContains: 'x', subject: '', folder: 'Receipts', moveNow: false, viewKey: 'inbox' });
    expect(api.putMailRules).toHaveBeenCalledTimes(2);
    const second = api.putMailRules.mock.calls[1]![0];
    expect(second.baseRev).toBe('rev-9');
    expect(second.rules[1]).toEqual(EXISTING);
    // The same rule id both times.
    expect(second.rules[0].id).toBe(api.putMailRules.mock.calls[0]![0].rules[0].id);
  });

  it('moveNow applies the saved rule and says how many move', async () => {
    api.applyMailRule.mockResolvedValue({ found: 4, queued: 3, skipped: 1 });
    const out = await saveFolderFilter({ fromContains: 'x', subject: '', folder: 'Receipts', moveNow: true, viewKey: 'inbox' });
    expect(out).toEqual({ queued: 3 });
    const id = api.putMailRules.mock.calls[0]![0].rules[0].id;
    expect(api.applyMailRule).toHaveBeenCalledWith(id);
    expect(api.pushLearnedUndo.mock.calls[0]![0].text).toBe('Filter saved: mail like this goes to Receipts. Moving 3 now.');
  });

  it('a failed apply keeps the saved rule and says why', async () => {
    api.applyMailRule.mockRejectedValue(Object.assign(new Error('x'), { body: { message: 'The account is offline.' } }));
    const out = await saveFolderFilter({ fromContains: 'x', subject: '', folder: 'Receipts', moveNow: true, viewKey: 'inbox' });
    expect(out).toEqual({ queued: 0 });
    expect(api.pushLearnedUndo.mock.calls[0]![0].text)
      .toBe("Filter saved: new mail like this goes to Receipts. Walnut couldn't move the mail already there: The account is offline.");
  });
});
