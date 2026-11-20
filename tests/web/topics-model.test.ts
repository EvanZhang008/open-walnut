/**
 * The pure rules the topic views draw with (web/src/components/topics/topic-model.ts): the Org
 * page's selection key, "@Name" mentions (longest name first, case-insensitive, never inside an
 * email), the @ autocomplete (members first, then tasks not in the topic) and the keys its list
 * takes (never an input method's), the line under a message (mailed, or will be), the stacked
 * avatars (host first, at most four, "+N"), and the words asked before Walnut emails a person.
 */
import { describe, expect, it } from 'vitest';
import {
  authorOf, defaultHost, isEmail, mentionCandidates, parseMentions, reachLine, refKey, stackedAvatars, topicKey, topicOfKey,
  topicOfThread, topicSubtitle, personMailConfirm, personEmails, listWords, NO_MAILBOX_WORDS, mailboxConfirm, activePersonEmails,
  mentionKeyAction, mentionShortForms,
} from '../../web/src/components/topics/topic-model';
import type { TopicMember, TopicSummary } from '../../web/src/api/topics';
import { mentionShortForms as serverShortForms, parseMentions as serverParseMentions } from '../../src/core/topics/topic-mentions';

const m = (id: string, name: string, extra: Partial<TopicMember> = {}): TopicMember => ({
  id: id as TopicMember['id'], name, ref: { kind: 'task', taskId: `t-${id}` }, role: 'member', status: 'active', ...extra,
});

const DOC = m('mb-doc', 'Doc');
const DOCW = m('mb-docw', 'Doc writer');
const VP = m('mb-vp', 'Walnut VP', { role: 'host', ref: { kind: 'org', node: 'project:walnut' } });
const ANN = m('mb-ann', 'Ann', { ref: { kind: 'person', name: 'Ann', email: 'ann@example.com' } });
const GONE = m('mb-gone', 'Gone', { status: 'left' });
const MEMBERS = [DOC, DOCW, VP, ANN, GONE];

describe('topic keys', () => {
  it('round-trips a topic id through the Org page key and refuses other keys', () => {
    expect(topicOfKey(topicKey('tp-abc123'))).toBe('tp-abc123');
    expect(topicOfKey('main')).toBeNull();
    expect(topicOfKey('project:walnut')).toBeNull();
    expect(topicOfKey('topic:')).toBeNull();
    expect(topicOfKey(null)).toBeNull();
  });

  it('one key per member ref: the same address in another case is the same person', () => {
    expect(refKey({ kind: 'person', name: 'A', email: 'Ann@Example.com ' })).toBe(refKey({ kind: 'person', name: 'B', email: 'ann@example.com' }));
    expect(refKey({ kind: 'org', node: 'main' })).toBe('org:main');
    expect(refKey({ kind: 'task', taskId: 'x' })).toBe('task:x');
  });

  it('tells an email address from a name', () => {
    expect(isEmail('ann@example.com')).toBe(true);
    expect(isEmail('ann@example')).toBe(false);
    expect(isEmail('Ann Smith')).toBe(false);
  });
});

describe('parseMentions', () => {
  const ROBIN = m('mb-robin', 'Robin (test)', { ref: { kind: 'person', name: 'Robin (test)', email: 'robin@example.com' } });
  const HALE = m('mb-hale', 'Robin Hale', { ref: { kind: 'person', name: 'Robin Hale', email: 'hale@example.com' } });

  it('names a member by its short form: the name without its "(note)", or its first word, while unique', () => {
    expect(parseMentions('@Robin can you price it?', [DOC, VP, ROBIN])).toEqual(['mb-robin']);
    expect(parseMentions('@robin (test) and @Robin', [DOC, VP, ROBIN])).toEqual(['mb-robin']);
    // The first word: "Walnut" is the VP's alone.
    expect(parseMentions('@Walnut please', [DOC, VP])).toEqual(['mb-vp']);
    // A member still waiting for the yes counts too.
    expect(parseMentions('@Robin', [DOC, { ...ROBIN, status: 'pending' }])).toEqual(['mb-robin']);
  });

  it('a short form two members share names no one; a full name still names its member', () => {
    expect(parseMentions('@Robin are you there?', [ROBIN, HALE])).toEqual([]);
    expect(parseMentions('@Robin Hale are you there?', [ROBIN, HALE])).toEqual(['mb-hale']);
    // "Doc" is one member's full name and the other's first word: it names the full one.
    expect(parseMentions('@Doc', [DOC, DOCW])).toEqual(['mb-doc']);
    // A member who left takes no short form from the others.
    expect(parseMentions('@Robin', [ROBIN, { ...HALE, status: 'left' }])).toEqual(['mb-robin']);
    // A short form is never a prefix match: "@Rob" names no one.
    expect(parseMentions('@Rob', [ROBIN])).toEqual([]);
  });

  it('the short forms of a name', () => {
    expect(mentionShortForms('Robin (test)')).toEqual(['robin']);
    expect(mentionShortForms('Robin Hale (bot)')).toEqual(['robin hale', 'robin']);
    expect(mentionShortForms('Doc')).toEqual([]);
  });

  it('matches the longest name first, case-insensitively, in order of appearance', () => {
    expect(parseMentions('@doc writer please, then @walnut vp', MEMBERS)).toEqual(['mb-docw', 'mb-vp']);
    expect(parseMentions('@Doc, look', MEMBERS)).toEqual(['mb-doc']);
  });

  it('names no one inside an email or a word, nor a member who left, nor a name cut short', () => {
    expect(parseMentions('mail ann@example.com', MEMBERS)).toEqual([]);
    expect(parseMentions('@Gone come back', MEMBERS)).toEqual([]);
    expect(parseMentions('@Doctor', MEMBERS)).toEqual([]);
  });

  it('lists a member once, and handles non-Latin names', () => {
    // Test data: a two-character CJK name, and a CJK sentence around its mention.
    const zh = m('mb-zh', '\u6587\u6863');
    expect(parseMentions('@Ann and @ann again', MEMBERS)).toEqual(['mb-ann']);
    expect(parseMentions('\u8bf7 @\u6587\u6863 \u770b\u770b', [zh])).toEqual(['mb-zh']);
  });

  it('is the server\'s own rule, one module: the composer shows who the server wakes', () => {
    expect(parseMentions).toBe(serverParseMentions);
    expect(mentionShortForms).toBe(serverShortForms);
  });
});

describe('mentionCandidates', () => {
  const tasks = [{ id: 't-mb-doc', name: 'Doc' }, { id: 'other', name: 'Docs cleanup' }, { id: 'x', name: 'Release notes' }];

  it('a bare @ lists the live members only', () => {
    const rows = mentionCandidates('', MEMBERS, tasks);
    expect(rows.every((r) => r.kind === 'member')).toBe(true);
    expect(rows.map((r) => (r.kind === 'member' ? r.member.id : ''))).not.toContain('mb-gone');
  });

  it('members that match lead, then tasks not in the topic', () => {
    const rows = mentionCandidates('doc', MEMBERS, tasks);
    expect(rows.map((r) => (r.kind === 'member' ? r.member.name : `task:${r.name}`))).toEqual(['Doc', 'Doc writer', 'task:Docs cleanup']);
  });

  it('ranks a word start above a hit inside a word, and caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: `Notes ${i}` }));
    expect(mentionCandidates('notes', [], many)).toHaveLength(8);
    const rows = mentionCandidates('vp', MEMBERS, []);
    expect(rows[0]).toMatchObject({ kind: 'member', member: { id: 'mb-vp' } });
  });
});

describe('reachLine', () => {
  it('says who it woke, who reads it next time and who it was mailed to', () => {
    expect(reachLine({ woke: ['mb-doc', 'mb-vp'], folded: ['mb-docw'], mailed: ['mb-ann'] }, MEMBERS))
      .toBe('woke Doc, Walnut VP · Doc writer read it next time · mailed Ann');
  });

  it('says a refused wake once, with its reason, not also as read next time', () => {
    expect(reachLine({ folded: ['mb-doc', 'mb-docw'], refused: [{ member: 'mb-doc', why: 'round budget used up' }] }, MEMBERS))
      .toBe('Doc writer read it next time · Doc not woken: round budget used up');
  });

  it('says "mailed" only for mail that went out, and "will be mailed" for the rest it is to go to', () => {
    expect(reachLine({ toMail: ['mb-ann'] }, MEMBERS)).toBe('Ann will be mailed');
    expect(reachLine({ toMail: ['mb-ann'], mailed: ['mb-ann'] }, MEMBERS)).toBe('mailed Ann');
    const BOB = m('mb-bob', 'Bob', { ref: { kind: 'person', name: 'Bob', email: 'bob@example.com' } });
    expect(reachLine({ woke: ['mb-doc'], toMail: ['mb-ann', 'mb-bob'], mailed: ['mb-ann'] }, [...MEMBERS, BOB]))
      .toBe('woke Doc · mailed Ann · Bob will be mailed');
  });

  it('is empty when the message reached no one', () => {
    expect(reachLine({}, MEMBERS)).toBe('');
    expect(reachLine({ woke: ['mb-unknown'] }, MEMBERS)).toBe('');
  });
});

describe('stackedAvatars and the header', () => {
  it('shows the host first, leaves out who left, at most four, and counts the rest', () => {
    const extra = [m('mb-a', 'A'), m('mb-b', 'B')];
    const { shown, more } = stackedAvatars([...MEMBERS, ...extra], 4);
    expect(shown[0]!.id).toBe('mb-vp');
    expect(shown.map((x) => x.id)).not.toContain('mb-gone');
    expect(shown).toHaveLength(4);
    expect(more).toBe(2);
    expect(stackedAvatars([DOC]).more).toBe(0);
  });

  it('reads "topic · N members · host X"', () => {
    expect(topicSubtitle({ members: MEMBERS })).toBe('topic · 4 members · host Walnut VP');
    expect(topicSubtitle({ members: [DOC] })).toBe('topic · 1 member');
  });

  it('names the author of a line', () => {
    expect(authorOf({ author: 'human' }, MEMBERS)).toEqual({ kind: 'human' });
    expect(authorOf({ author: 'walnut' }, MEMBERS)).toEqual({ kind: 'walnut' });
    expect(authorOf({ author: 'mb-doc' }, MEMBERS)).toMatchObject({ kind: 'member', name: 'Doc' });
    expect(authorOf({ author: 'mb-none' }, MEMBERS)).toMatchObject({ kind: 'member', name: 'A former member' });
  });

  it('hosts the first org node, else the first task, never a person', () => {
    const person = { ref: { kind: 'person' as const, name: 'Ann', email: 'ann@example.com' } };
    const task = { ref: { kind: 'task' as const, taskId: 'a' } };
    const org = { ref: { kind: 'org' as const, node: 'main' } };
    expect(defaultHost([person, task, org])).toBe(2);
    expect(defaultHost([person, task])).toBe(1);
    expect(defaultHost([person])).toBeUndefined();
  });

  it('finds the topic a thread belongs to', () => {
    const list = [{ id: 'tp-1', title: 'A', members: [], updatedAt: '', thread: { node: 'n', threadId: 'th-1' } }] as TopicSummary[];
    expect(topicOfThread(list, 'th-1')?.id).toBe('tp-1');
    expect(topicOfThread(list, 'th-2')).toBeUndefined();
  });
});

describe('the yes before Walnut emails a person', () => {
  it('names the address and the mailbox, or says mail waits for a mailbox and nothing is sent until then', () => {
    expect(personMailConfirm(['ann@example.com'], 'robin@example.com'))
      .toBe("Walnut will email ann@example.com from robin@example.com with this topic's new messages. Add?");
    expect(personMailConfirm(['ann@example.com'], null))
      .toBe('Walnut will email ann@example.com once you choose a mailbox for this topic (nothing is sent until then). Add?');
    expect(personMailConfirm(['ann@example.com'], null, 'Confirm?'))
      .toBe('Walnut will email ann@example.com once you choose a mailbox for this topic (nothing is sent until then). Confirm?');
    expect(NO_MAILBOX_WORDS).toBe('once you choose a mailbox for this topic (nothing is sent until then)');
    expect(personMailConfirm(['a@example.com', 'b@example.com', 'c@example.com'], 'r@example.com', 'Confirm?'))
      .toBe("Walnut will email a@example.com, b@example.com and c@example.com from r@example.com with this topic's new messages. Confirm?");
    expect(listWords(['a', 'b'])).toBe('a and b');
  });

  it('asks before a mailbox is chosen while people are in the topic, naming them and the mailbox', () => {
    expect(mailboxConfirm(['ann@example.com', 'bob@example.com'], 'team@example.com'))
      .toBe("Walnut will email ann@example.com and bob@example.com from team@example.com with this topic's new messages. Use it?");
    const pending = m('mb-p', 'Pat', { status: 'pending', ref: { kind: 'person', name: 'Pat', email: 'pat@example.com' } });
    const left = m('mb-l', 'Lee', { status: 'left', ref: { kind: 'person', name: 'Lee', email: 'lee@example.com' } });
    // Only the active people: one waiting for the yes, or one who left, gets no mail.
    expect(activePersonEmails([...MEMBERS, pending, left])).toEqual(['ann@example.com']);
  });

  it('finds the people among the picked members', () => {
    expect(personEmails([{ kind: 'task', taskId: 't1' }, { kind: 'person', name: 'Ann', email: ' ann@example.com ' }, { kind: 'org', node: 'main' }]))
      .toEqual(['ann@example.com']);
  });
});

describe('the keys of the open @ list', () => {
  it('moves, picks, closes, and leaves other keys to the box', () => {
    expect(mentionKeyAction({ key: 'ArrowDown' })).toBe('next');
    expect(mentionKeyAction({ key: 'ArrowUp' })).toBe('prev');
    expect(mentionKeyAction({ key: 'Enter' })).toBe('pick');
    expect(mentionKeyAction({ key: 'Tab' })).toBe('pick');
    expect(mentionKeyAction({ key: 'Enter', shiftKey: true })).toBeNull();
    expect(mentionKeyAction({ key: 'Escape' })).toBe('close');
    expect(mentionKeyAction({ key: 'a' })).toBeNull();
  });

  it('never takes a key of an input method: the Enter that commits a composed word picks no row', () => {
    expect(mentionKeyAction({ key: 'Enter', isComposing: true })).toBeNull();
    // WebKit reports the key that ends a composition with isComposing false and keyCode 229.
    expect(mentionKeyAction({ key: 'Enter', isComposing: false, keyCode: 229 })).toBeNull();
    expect(mentionKeyAction({ key: 'ArrowDown', isComposing: true })).toBeNull();
    expect(mentionKeyAction({ key: 'Escape', keyCode: 229 })).toBeNull();
  });
});

describe('a topic member\'s avatar task', () => {
  it('is the task itself, the CEO\'s or the VP\'s task now, and none for a person', async () => {
    const { memberTaskId } = await import('../../web/src/components/topics/TopicAvatars.js')
    const tasks = [
      { id: 't-ceo', title: 'Main', org_role: 'main', project: '', phase: 'IN_PROGRESS' },
      { id: 't-vp', title: 'Lead', org_role: 'lead', org_name: 'Acme', project: 'Acme', phase: 'IN_PROGRESS' },
      { id: 't-work', title: 'Pricing copy', project: 'Acme', phase: 'IN_PROGRESS' },
    ] as never[]
    expect(memberTaskId({ kind: 'task', taskId: 't-work' }, tasks)).toBe('t-work')
    expect(memberTaskId({ kind: 'org', node: 'main' }, tasks)).toBe('t-ceo')
    expect(memberTaskId({ kind: 'org', node: 'project:Acme' }, tasks)).toBe('t-vp')
    expect(memberTaskId({ kind: 'org', node: 'project:Nowhere' }, tasks)).toBeUndefined()
    expect(memberTaskId({ kind: 'person', name: 'Robin', email: 'robin@example.org' }, tasks)).toBeUndefined()
  })
})
