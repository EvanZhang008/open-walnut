/**
 * The session header's title row holds the title, ONE folded labels control and the
 * kebab (2026-11-02, the user: "idle and running don't need to show ... the tag still
 * noisy, all collapse, user can click"). Every label lives inside <SessionHeaderLabels>;
 * the run status (Running, Idle) is not in the header at all.
 *
 * This reads SessionPanel.tsx's header JSX and fails when a pill, chip or badge
 * component is rendered there outside the labels control, or when the run status
 * comes back. A new pill kind (any component named *Pill, *Pills, *Chip or *Badge)
 * is caught without being listed here. The browser half is
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
  const start = header.indexOf('<div className="session-panel-header-top">');
  expect(start).toBeGreaterThan(0);
  return header.slice(start);
}

/** The labels fragment SessionPanel hands to <SessionHeaderLabels>. */
function labelsFragment(): string {
  const start = src.indexOf('const headerLabels = (');
  expect(start).toBeGreaterThan(0);
  const end = src.indexOf('\n  );\n', start);
  return src.slice(start, end);
}

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
      // The phone has no title row: its own top bar carries the wait as an hourglass
      // button beside its kebab (PhoneTopBar's action slot), and nothing else.
      .replace('createPortal(<WaitingChip task={sessionTask} compact />, kebabSlot', 'createPortal(PHONE_WAIT, kebabSlot');
    const found = [...row.matchAll(PILL_LIKE)].map((m) => m[1]).filter((name) => !(name in ALLOWED_ON_ROW));
    expect(found, 'a label beside the title: put it in headerLabels (SessionHeaderLabels.tsx)').toEqual([]);
    // A label drawn as a plain element (a badge span, a tag chip) counts too. The one badge the
    // row keeps is the "Loading..." placeholder while the record loads.
    const raw = [...row.matchAll(/className=["{`][^"}`]*\b(session-panel-badge|tag-chip|task-team-pill|task-trigger-pill|session-cron-pill|task-waiting-chip)\b[^>]*>([^<{]*)/g)]
      .filter((m) => !(m[1] === 'session-panel-badge' && /^Loading/.test(m[2] ?? '')))
      .map((m) => m[1]);
    expect(raw, 'a label drawn beside the title: put it in headerLabels').toEqual([]);
  });

  it('never shows the run status (Running, Idle) in the header, its labels included', () => {
    // The status words are the task detail's (TaskDetailRows.tsx SessionRow), never the header's.
    for (const [where, jsx] of [['header', headerJsx()], ['headerLabels', labelsFragment()]] as const) {
      expect(jsx, where).not.toMatch(/ProcessStatusBadge|process_status|\bps\b|processStatus/);
      expect(jsx, where).not.toMatch(/PROCESS_LABELS|PROCESS_COLORS|deriveDisplayStatus/);
    }
  });

  it('draws every label inside the labels control, the same set wherever the header is', () => {
    const header = headerJsx();
    const uses = [...header.matchAll(/<SessionHeaderLabels>\{headerLabels\}<\/SessionHeaderLabels>/g)];
    // The title row's own, and the host header's (an Org node draws the panel's header in its own).
    expect(uses.length).toBe(2);
    // headerLabels is used nowhere else.
    expect([...src.matchAll(/\{headerLabels\}/g)].length).toBe(uses.length);
  });

  it('keeps the label components in the labels fragment', () => {
    const labels = labelsFragment();
    for (const name of ['TaskTagPills', 'WaitingChip', 'CronPill', 'TriggerPill', 'SubtaskPill', 'LeaderPill']) {
      expect(labels, `${name} belongs in headerLabels`).toContain(`<${name}`);
    }
  });
});
