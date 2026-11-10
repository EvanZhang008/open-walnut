/**
 * The session header's title row holds the title, the state pills (headerPills: the wait,
 * Cron, Trigger, Worker, Leader, Embedded), ONE folded control for the link tags
 * (headerTags inside <SessionHeaderLabels>), and the kebab. 2026-11-02, the user: "idle
 * and running don't need to show ... the tag still noisy, all collapse"; 2026-11-03: "only
 * tag go there, other should still outside, like trigger ... leader ... worker".
 *
 * This reads SessionPanel.tsx and fails when a pill, chip or badge component is rendered
 * on the row outside those two fragments, when a tag lands among the pills or a pill among
 * the tags, or when the run status comes back. A new pill kind (any component named *Pill,
 * *Pills, *Chip or *Badge) is caught without being listed here. The browser half is
 * tests/e2e/browser/session-header-labels.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PANEL = path.resolve(__dirname, '../../web/src/components/sessions/SessionPanel.tsx');
const src = fs.readFileSync(PANEL, 'utf8');

/** The header's JSX: from the header element to the first thing drawn under it. */
function headerJsx(): string {
  const start = src.indexOf('className={`session-panel-header${');
  const end = src.indexOf('{messagesOpen && (', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The title row alone (row 2), where the labels used to crowd the title. */
function titleRowJsx(): string {
  const header = headerJsx();
  const start = header.indexOf('<div className="session-panel-header-top"');
  expect(start).toBeGreaterThan(0);
  return header.slice(start);
}

/** A fragment SessionPanel defines once: `const <name> = ...;` up to its end. */
function fragment(name: string, end: string): string {
  const start = src.indexOf(`const ${name} = `);
  expect(start, `SessionPanel defines ${name}`).toBeGreaterThan(0);
  const stop = src.indexOf(end, start);
  expect(stop).toBeGreaterThan(start);
  return src.slice(start, stop);
}
const tagsFragment = () => fragment('headerTags', ';\n');
const pillsFragment = () => fragment('headerPills', '\n  );\n');

const PILL_LIKE = /<([A-Z][A-Za-z0-9]*(?:Pill|Pills|Chip|Badge))\b/g;

/** A pill-like component allowed on the title row itself, with why. */
const ALLOWED_ON_ROW: Record<string, string> = {
  // The question view switch (Tree / Conversation), shown only while the session has
  // questions: a control of the chat, not a label of the task.
  ThreadModePill: 'chat view switch, not a label',
};

describe('session header title row', () => {
  it('renders no pill, chip or badge outside the folded labels control', () => {
    const row = titleRowJsx()
      .replace(/<SessionHeaderLabels>[\s\S]*?<\/SessionHeaderLabels>/g, '<SessionHeaderLabels />')
      .replace(/\bheaderPills\b/g, 'HEADER_PILLS')
      // The phone has no title row: its own top bar carries the wait as an hourglass
      // button beside its kebab (PhoneTopBar's action slot), a linked pull request's state
      // as one more button (a phone has no other way to open its card), and the session's
      // web servers as a globe and count (the lead's call, 2026-11-05: "a compact chip next
      // to the kebab on phone"), nothing else.
      .replace('createPortal(<WaitingChip task={sessionTask} compact />, kebabSlot', 'createPortal(PHONE_WAIT, kebabSlot')
      .replace('createPortal(<PrPill task={sessionTask} compact />, kebabSlot', 'createPortal(PHONE_PR, kebabSlot')
      .replace(/createPortal\(\s*<SessionServersChip\b(?:(?!\/>)[\s\S])*\bcompact \/>,\s*kebabSlot/, 'createPortal(PHONE_WEB, kebabSlot')
      // And the task's browser use as one more (2026-11-09: live resources are header pills only).
      .replace(/createPortal\(\s*<SessionBrowserChip\b(?:(?!\/>)[\s\S])*\bcompact \/>,\s*kebabSlot/, 'createPortal(PHONE_BROWSER, kebabSlot');
    const found = [...row.matchAll(PILL_LIKE)].map((m) => m[1]).filter((name) => !(name in ALLOWED_ON_ROW));
    expect(found, 'a label beside the title: put it in headerPills, or a tag in headerTags').toEqual([]);
    // A label drawn as a plain element (a badge span, a tag chip) counts too. The one badge the
    // row keeps is the "Loading..." placeholder while the record loads.
    const raw = [...row.matchAll(/className=["{`][^"}`]*\b(session-panel-badge|tag-chip|task-team-pill|task-trigger-pill|session-cron-pill|task-waiting-chip)\b[^>]*>([^<{]*)/g)]
      .filter((m) => !(m[1] === 'session-panel-badge' && /^Loading/.test(m[2] ?? '')))
      .map((m) => m[1]);
    expect(raw, 'a label drawn beside the title: put it in headerPills or headerTags').toEqual([]);
  });

  it('never shows the run status (Running, Idle) in the header, its labels included', () => {
    // The status words are the task detail's (TaskDetailRows.tsx SessionRow), never the header's.
    for (const [where, jsx] of [['header', headerJsx()], ['headerTags', tagsFragment()], ['headerPills', pillsFragment()]] as const) {
      expect(jsx, where).not.toMatch(/ProcessStatusBadge|process_status|\bps\b|processStatus/);
      expect(jsx, where).not.toMatch(/PROCESS_LABELS|PROCESS_COLORS|deriveDisplayStatus/);
    }
  });

  it('draws the same pills and the same folded tags wherever the header is', () => {
    const header = headerJsx();
    const folded = [...header.matchAll(/<SessionHeaderLabels>\{headerTags\}<\/SessionHeaderLabels>/g)];
    // The title row's own, and the host header's (an Org node draws the panel's header in its own).
    expect(folded.length).toBe(2);
    expect([...src.matchAll(/\{headerTags\}/g)].length).toBe(folded.length);
    // Drawn twice (the row and the host header), and nowhere else: its definition plus those two.
    expect([...header.matchAll(/\bheaderPills\s*\}/g)].length).toBe(2);
    expect([...src.matchAll(/\bheaderPills\s*\}/g)].length).toBe(2);
    // The control folds the tags and nothing else.
    expect(src).not.toMatch(/<SessionHeaderLabels>(?!\{headerTags\}<\/SessionHeaderLabels>)/);
  });

  it('folds only the link tags; every state pill stays on the row', () => {
    const tags = tagsFragment();
    expect(tags).toContain('<TaskTagPills');
    expect([...tags.matchAll(PILL_LIKE)].map((m) => m[1]), 'headerTags holds the tags alone').toEqual(['TaskTagPills']);
    const pills = pillsFragment();
    for (const name of ['WaitingChip', 'CronPill', 'TriggerPill', 'SubtaskPill', 'LeaderPill']) {
      expect(pills, `${name} stays on the row (headerPills)`).toContain(`<${name}`);
    }
    expect(pills, 'a tag among the pills').not.toContain('<TaskTagPills');
  });
});
