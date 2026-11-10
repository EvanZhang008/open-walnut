/**
 * The starting values of "Filter mails like these…" (web/src/apps/mail/mail-filter-defaults.ts):
 * the sender most rows come from, the subject head that sender's rows share, and the folder name.
 * Pure functions, no DOM.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_FOLDER, MIN_SUBJECT, filterDefaultsFor, sharedSubjectHead,
} from '../../web/src/apps/mail/mail-filter-defaults';

type Row = { from: { address: string; name?: string }; subject: string };
const row = (address: string, subject: string, name?: string): Row => ({ from: { address, ...(name ? { name } : {}) }, subject });

const CI = 'ci-bot@ferry-ci.example.invalid';
const PEER = 'wren@ferry-ci.example.invalid';

describe('sharedSubjectHead', () => {
  it('keeps a head that ends where a longer subject goes on with a separator', () => {
    expect(sharedSubjectHead(['[acme/ferry] Run failed', '[acme/ferry] Run failed: Lint - main'])).toBe('[acme/ferry] Run failed');
    expect(sharedSubjectHead(['[acme/ferry] Run failed (1)', '[acme/ferry] Run failed (2)'])).toBe('[acme/ferry] Run failed');
  });

  it('cuts a head over 120 characters at a whole word', () => {
    const words = Array.from({ length: 30 }, (_, n) => `word${n}`).join(' ');
    const head = sharedSubjectHead([`${words} one`, `${words} two`]);
    expect(head.length).toBeLessThanOrEqual(120);
    expect(words.startsWith(head)).toBe(true);
    expect(words[head.length]).toBe(' ');
  });

  it('CI subjects share their run head, without the trailing colon', () => {
    expect(sharedSubjectHead([
      '[acme/ferry] Run failed: Build - main (1a2b3c)',
      '[acme/ferry] Run failed: Lint - main (9f8e7d)',
    ])).toBe('[acme/ferry] Run failed');
  });

  it('more rows narrow the head to what every one shares', () => {
    expect(sharedSubjectHead([
      '[acme/ferry] Run failed: Build - main (1a2b3c)',
      '[acme/ferry] Run failed: Lint - main (9f8e7d)',
      '[acme/ferry] Run cancelled: Lint - main (4d5e6f)',
    ])).toBe('[acme/ferry] Run');
  });

  it('one row (or none) says nothing about a series', () => {
    expect(sharedSubjectHead(['[acme/ferry] Run failed: Build - main (1a2b3c)'])).toBe('');
    expect(sharedSubjectHead([])).toBe('');
  });

  it(`a head shorter than MIN_SUBJECT (${MIN_SUBJECT}) characters is empty`, () => {
    expect(sharedSubjectHead(['Hi Bob, lunch?', 'Hi Ann, lunch?'])).toBe('');
    // Exactly MIN_SUBJECT characters is kept.
    expect('Alerts'.length).toBe(MIN_SUBJECT);
    expect(sharedSubjectHead(['Alerts for disk', 'Alerts for memory'])).toBe('Alerts for');
    expect(sharedSubjectHead(['Alerts: disk', 'Alerts: memory'])).toBe('Alerts');
  });

  it('subjects with nothing in common give empty', () => {
    expect(sharedSubjectHead(['Weekly digest', 'Your receipt'])).toBe('');
  });

  it('a cut in the middle of a word goes back to the last word end', () => {
    expect(sharedSubjectHead(['Weekly report for June', 'Weekly report for July'])).toBe('Weekly report for');
    expect(sharedSubjectHead(['Deploy to staging-east done', 'Deploy to staging-west done'])).toBe('Deploy to');
  });

  it('a mid-word cut with no earlier word end gives empty', () => {
    expect(sharedSubjectHead(['Alphabetical order', 'Alphanumeric order'])).toBe('');
  });

  it('identical subjects keep the whole subject', () => {
    expect(sharedSubjectHead(['Daily standup notes', 'Daily standup notes'])).toBe('Daily standup notes');
  });

  it('trailing punctuation and brackets are dropped', () => {
    expect(sharedSubjectHead(['Invoice ready - (#1043)', 'Invoice ready - (#2210)'])).toBe('Invoice ready');
    expect(sharedSubjectHead(['Build status | main', 'Build status | dev'])).toBe('Build status');
  });

  it('the head is at most 120 characters', () => {
    const long = 'word '.repeat(40);
    const head = sharedSubjectHead([`${long}alpha`, `${long}beta`]);
    expect(head.length).toBeLessThanOrEqual(120);
    expect(head.startsWith('word word')).toBe(true);
  });
});

describe('filterDefaultsFor', () => {
  it('the most common sender wins, and the subject is that sender\'s shared head', () => {
    const rows = [
      row(CI, '[acme/ferry] Run failed: Build - main (1a2b3c)', 'Ferry CI'),
      row(PEER, 'Re: [acme/ferry] Review comment on pull 12', 'Wren Ash'),
      row(CI, '[acme/ferry] Run failed: Lint - main (9f8e7d)', 'Ferry CI'),
    ];
    expect(filterDefaultsFor(rows)).toEqual({
      fromContains: CI,
      subject: '[acme/ferry] Run failed',
      folder: 'Ferry CI',
    });
  });

  it('addresses are compared lowercased and trimmed', () => {
    const rows = [
      row(' CI-Bot@Ferry-CI.example.invalid ', '[acme/ferry] Run failed: Build'),
      row('ci-bot@ferry-ci.example.invalid', '[acme/ferry] Run failed: Lint'),
      row(PEER, 'Something else'),
    ];
    const out = filterDefaultsFor(rows);
    expect(out.fromContains).toBe(CI);
    expect(out.subject).toBe('[acme/ferry] Run failed');
  });

  it('a tie in counts goes to the alphabetically first address', () => {
    const rows = [
      row('zed@post.example.invalid', 'One'),
      row('amber@post.example.invalid', 'Two'),
      row('zed@post.example.invalid', 'Three'),
      row('amber@post.example.invalid', 'Four'),
    ];
    expect(filterDefaultsFor(rows).fromContains).toBe('amber@post.example.invalid');
    expect(filterDefaultsFor([...rows].reverse()).fromContains).toBe('amber@post.example.invalid');
  });

  it('the sender option wins over the count, trimmed and lowercased', () => {
    const rows = [
      row(CI, '[acme/ferry] Run failed: Build'),
      row(CI, '[acme/ferry] Run failed: Lint'),
      row(PEER, 'Notes from the review meeting', 'Wren Ash'),
      row(PEER, 'Notes from the planning meeting', 'Wren Ash'),
    ];
    expect(filterDefaultsFor(rows, { sender: '  WREN@ferry-ci.example.invalid ' })).toEqual({
      fromContains: PEER,
      subject: 'Notes from the',
      folder: 'Wren Ash',
    });
  });

  it('the label option names the folder over the sender\'s name', () => {
    const rows = [row(CI, 'A run', 'Ferry CI'), row(CI, 'B run', 'Ferry CI')];
    expect(filterDefaultsFor(rows, { label: '  CI Builds ' }).folder).toBe('CI Builds');
    // A blank label falls through to the name.
    expect(filterDefaultsFor(rows, { label: '   ' }).folder).toBe('Ferry CI');
  });

  it('with no display name, the folder is the local part of the address', () => {
    const rows = [row(CI, 'A run'), row(CI, 'B run')];
    expect(filterDefaultsFor(rows).folder).toBe('ci-bot');
  });

  it('the display name comes from the first of the sender\'s rows that has one', () => {
    const rows = [row(CI, 'A run'), row(CI, 'B run', '  Ferry Robot  '), row(CI, 'C run', 'Other Name')];
    expect(filterDefaultsFor(rows).folder).toBe('Ferry Robot');
  });

  it(`the folder is cut to MAX_FOLDER (${MAX_FOLDER}) characters`, () => {
    const name = 'Quarterly Planning Committee Notifications Desk';
    expect(name.length).toBeGreaterThan(MAX_FOLDER);
    const rows = [row(CI, 'A', name), row(CI, 'B', name)];
    const folder = filterDefaultsFor(rows).folder;
    expect(folder.length).toBeLessThanOrEqual(MAX_FOLDER);
    expect(folder).toBe(name.slice(0, MAX_FOLDER).trim());
    expect(filterDefaultsFor(rows, { label: 'L'.repeat(60) }).folder).toBe('L'.repeat(MAX_FOLDER));
    const longLocal = `${'p'.repeat(55)}@post.example.invalid`;
    expect(filterDefaultsFor([row(longLocal, 'x')]).folder).toBe('p'.repeat(MAX_FOLDER));
  });

  it('a single row: sender and folder filled, subject empty', () => {
    expect(filterDefaultsFor([row(CI, '[acme/ferry] Run failed: Build', 'Ferry CI')])).toEqual({
      fromContains: CI, subject: '', folder: 'Ferry CI',
    });
  });

  it('no rows (or rows with no address) give empty values', () => {
    expect(filterDefaultsFor([])).toEqual({ fromContains: '', subject: '', folder: '' });
    expect(filterDefaultsFor([{ from: { address: '' }, subject: 'x' }])).toEqual({ fromContains: '', subject: '', folder: '' });
    expect(filterDefaultsFor([], { label: 'Kept' }).folder).toBe('Kept');
  });
});
