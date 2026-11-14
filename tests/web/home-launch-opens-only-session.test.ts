/**
 * A New task send opens only the new session; Main (the chat slot) shows only when the user
 * opens it (2026-11-10 review, the user: "In New Task ... there was a CEO from the beginning ...
 * it's weird"). The draft borrowed the open chat's spot, and its Start gave the spot back, so
 * every launch brought the CEO panel back beside the new session.
 *
 * The class, enumerated from MainPage's source: every way the chat slot is shown, every draft
 * exit, and every column a launch opens.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(__dirname, '../../web/src/pages/MainPage.tsx'), 'utf8');

/** The useLeanCallback body that starts at `marker`, up to its dependency list. */
function callbackBody(marker: string): string {
  const start = SRC.indexOf(marker);
  expect(start, marker).toBeGreaterThan(-1);
  const end = SRC.indexOf('\n  }, [', start);
  return SRC.slice(start, end);
}

/** Every setChatVisible call that can SHOW the slot, with why it is the user's own step. */
const CHAT_SHOWN_BY: Array<{ marker: string; why: string }> = [
  { marker: 'setChatVisible(prev => !prev);', why: 'the dock / sidebar chat toggle: the user' },
  { marker: "if (exit === 'close') setChatVisible(true);", why: 'a draft closed with its ×: nothing was made, the borrowed spot comes back' },
  { marker: "showAskInSlot(MAIN_PICK);\n      setChatVisible(true);", why: 'Talk to Main from the Org chart: the user' },
  { marker: 'showAskInSlot(task.id);\n        setChatVisible(true);', why: 'a locate of an ask task (search, a link): the user' },
];

describe('the chat slot shows only on the user\'s step', () => {
  it('every call that shows it is listed with why', () => {
    const shows = [...SRC.matchAll(/setChatVisible\((?!false\))[^;]*;/g)].map((m) => m.index!);
    const listed = CHAT_SHOWN_BY.map((c) => SRC.indexOf(c.marker));
    expect(listed.filter((i) => i < 0), 'a listed marker is gone').toEqual([]);
    const unlisted = shows.filter((at) => !CHAT_SHOWN_BY.some((c, i) => at >= listed[i] && at < listed[i] + c.marker.length));
    expect(unlisted.map((at) => SRC.slice(at, SRC.indexOf('\n', at)).trim()), 'a new path shows the chat slot: make it the user\'s own step and list it').toEqual([]);
  });

  it('a launch ends the borrow with the chat closed, and keeps it closed across a reload', () => {
    const forget = callbackBody('const forgetDraft = useLeanCallback(');
    expect(forget).toMatch(/\(draftId: string, exit: 'close' \| 'launch'\)/);
    expect(forget).toMatch(/else persistPanelFlag\(LS_CHAT_VISIBLE_KEY, false, HOME_CHAT_VISIBLE_DEFAULT\);/);
  });

  it('every draft exit says which it is: only the ×-close gives the spot back', () => {
    const exits = [...SRC.matchAll(/forgetDraft\(draftId(?:, '(close|launch)')?\)/g)].map((m) => m[1] ?? 'unnamed');
    expect(exits).not.toContain('unnamed');
    expect(exits.filter((e) => e === 'close')).toHaveLength(1);
    expect(callbackBody('const closeDraftColumn = useLeanCallback(')).toMatch(/forgetDraft\(draftId, 'close'\)/);
    const start = callbackBody('const handleDraftStart = useLeanCallback(');
    expect(start.match(/forgetDraft\(draftId, 'launch'\)/g)).toHaveLength(3); // Ask Walnut, fork, coding
    expect(start).not.toMatch(/forgetDraft\(draftId, 'close'\)/);
  });
});

describe('a launch opens one column: the draft\'s own, morphed into the session', () => {
  /** Every call that puts a column on the strip. */
  const OPENS = /\b(openSessionOrToast(?:Ref\.current)?|addSessionColumn|forceAddSessionColumn|replaceSessionColumn|regrowColumns|showAskInSlot)\(/g;

  it('the draft Start opens nothing itself but the fork\'s morph of its own column', () => {
    const start = callbackBody('const handleDraftStart = useLeanCallback(');
    expect([...start.matchAll(OPENS)].map((m) => m[1])).toEqual([]);
    expect(start).toMatch(/handleForkPending\(draft\.cwd, draft\.host \?\? undefined, \{ columnId: draftId \}\)/);
    expect(start.match(/columnId: draftId/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('launchQuickStart opens only its pending column (the draft morphed, else one insert) and swaps it in place', () => {
    const launch = callbackBody('const launchQuickStart = useLeanCallback(');
    expect([...launch.matchAll(OPENS)].map((m) => m[1])).toEqual([
      'replaceSessionColumn', // the draft column morphs into the pending one
      'forceAddSessionColumn', // no draft column: one pending column
      'replaceSessionColumn', // a workspace launch's pending id swap
    ]);
    expect(launch).not.toMatch(/setChatVisible\(/);
  });
});
