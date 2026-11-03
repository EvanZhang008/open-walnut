/**
 * No surface the user reads shows a task's phase name (2026-11-03, the user's call, relayed by his
 * lead: on every task row, card, detail pane, pill, Board overview, inbox receipt and the phone,
 * only the user-status words). A phase is shown in those words through ONE map, PHASE_LABELS in
 * web/src/utils/session-status.ts (the phone's twin: PhaseWords in ModelsInboxItems.swift), and a
 * spot that holds the task shows its real user status (taskStatusLabel). Filters and the phase
 * menu still store and send the phase values; only the words changed.
 *
 * The class this guards: a file that keeps its own copy of the old phase words ("Need Action",
 * "In Progress", "To Do"), as five web files and two phone files did. The scan reads every
 * .ts/.tsx/.js under web/src and every .swift under ios-native/Walnut with comments removed, so a
 * new file with its own copy fails here by name and line.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { USER_STATE_LABELS } from '../../src/core/user-status';
import { NOT_STARTED_LABEL, PHASE_LABELS } from '../../web/src/utils/session-status';

const ROOT = path.resolve(__dirname, '../..');
/** Scan another tree instead (a checkout of an older commit), to see the scan catch its words. */
const SCAN_ROOT = process.env.PHASE_WORDS_SCAN_ROOT ? path.resolve(process.env.PHASE_WORDS_SCAN_ROOT) : ROOT;

/** Old phase words anywhere in code a person reads (string literals, JSX text). */
const PHASE_WORD = /Needs? Action|Needs action|In Progress|(?<!Microsoft )\bTo Do\b/;
/** "To do" (lower d) only as a whole label: a literal or JSX text that is just the words. */
const BARE_TO_DO = /(['"`>])\s*To do\s*[:,.]?\s*(['"`<])/;

/**
 * Files that may keep one of the words, each with why it is no phase. Keep it short: a new entry
 * needs a reason a reviewer would accept.
 */
const ALLOWED: Record<string, string> = {
  'ios-native/Walnut/Views/Tasks/TaskRow.swift': 'VoiceOver words of the binary status field (todo / in progress / done) the circle toggles, not a phase',
  'ios-native/Walnut/Views/Tasks/TaskPropertyModel.swift': 'the status picker writes the binary status field (todo / in_progress / done), not a phase',
  'ios-native/Walnut/Stores/TasksStore.swift': 'the "In Progress" smart list lists tasks whose binary status field is in_progress, not a phase',
};

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, exts, out); }
    else if (exts.test(e.name) && !/\.test\.tsx?$|Tests\.swift$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The code with comments blanked, line numbers kept. A `//` after `:` or a quote (a URL) stays. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Every `file:line: text` in `src` that shows an old phase word. */
function phaseWordHits(rel: string, src: string): string[] {
  const hits: string[] = [];
  stripComments(src).split('\n').forEach((line, i) => {
    if (PHASE_WORD.test(line) || BARE_TO_DO.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
  });
  return hits;
}

const files = [
  ...walk(path.join(SCAN_ROOT, 'web/src'), /\.(?:tsx?|m?js)$/),
  ...walk(path.join(SCAN_ROOT, 'ios-native/Walnut'), /\.swift$/),
];

describe('no surface the user reads shows a phase name', () => {
  it('the scan reads both trees', () => {
    expect(files.some((f) => f.endsWith(path.join('web/src/utils/session-status.ts')))).toBe(true);
    expect(files.some((f) => f.endsWith('.swift'))).toBe(true);
  });

  it('no web or phone file keeps its own copy of the old phase words', () => {
    const hits = files.flatMap((f) => {
      const rel = path.relative(SCAN_ROOT, f);
      return ALLOWED[rel] ? [] : phaseWordHits(rel, fs.readFileSync(f, 'utf8'));
    });
    expect(hits, 'Show a phase with PHASE_LABELS (web/src/utils/session-status.ts) or one task\'s status with '
      + 'taskStatusLabel; on the phone PhaseWords.label. Or list the file in ALLOWED with why it is no phase:\n'
      + hits.join('\n')).toEqual([]);
  });

  it('an allowed file still uses a word (the list only shrinks)', () => {
    const stale = Object.keys(ALLOWED).filter((rel) => {
      const p = path.join(ROOT, rel);
      return !fs.existsSync(p) || phaseWordHits(rel, fs.readFileSync(p, 'utf8')).length === 0;
    });
    expect(stale).toEqual([]);
  });

  it('catches the shapes the old copies had, and not a comment or another product\'s name', () => {
    expect(phaseWordHits('a.ts', "  NEED_ACTION: 'Need Action',")).toHaveLength(1);
    expect(phaseWordHits('a.ts', "  TODO: 'To Do', IN_PROGRESS: 'In Progress',")).toHaveLength(1);
    expect(phaseWordHits('a.ts', "  TODO: 'To do', IN_PROGRESS: 'In progress', NEED_ACTION: 'Needs action',")).toHaveLength(1);
    expect(phaseWordHits('a.tsx', '      <span>Needs Action</span>')).toHaveLength(1);
    expect(phaseWordHits('a.swift', '        case "TODO": return "To do"')).toHaveLength(1);
    expect(phaseWordHits('a.tsx', "aria-label={isDone ? 'Reopen (mark To Do)' : 'Mark complete'}")).toHaveLength(1);
    expect(phaseWordHits('a.ts', "const t = 'Open: To Do, In Progress and Need Action';")).toHaveLength(1);
    expect(phaseWordHits('a.ts', '/** Needs Action: what a session asks */\n// In Progress\nconst x = 1;')).toEqual([]);
    expect(phaseWordHits('a.ts', "{ id: 'ms-todo', title: 'Synced with Microsoft To Do' }")).toEqual([]);
    expect(phaseWordHits('a.tsx', '  To do it yourself, run <code>x</code>')).toEqual([]);
  });
});

describe('the one phase map speaks the user-status words', () => {
  it('every PHASE_LABELS word is a user-status name, Not started or Waiting', () => {
    const names = new Set<string>([...Object.values(USER_STATE_LABELS), NOT_STARTED_LABEL, 'Not started', 'Waiting']);
    for (const [phase, word] of Object.entries(PHASE_LABELS)) expect(names.has(word), `${phase}: ${word}`).toBe(true);
    expect(PHASE_LABELS.NEED_ACTION).toBe(USER_STATE_LABELS.needs);
    expect(PHASE_LABELS.IN_PROGRESS).toBe(USER_STATE_LABELS.working);
    expect(PHASE_LABELS.COMPLETE).toBe(USER_STATE_LABELS.done);
  });

  it('the phone\'s twin says the same words', () => {
    const swift = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/API/ModelsInboxItems.swift'), 'utf8');
    const twin = swift.slice(swift.indexOf('enum PhaseWords'), swift.indexOf('struct InboxTaskCandidate'));
    for (const [phase, word] of Object.entries(PHASE_LABELS)) expect(twin, phase).toContain(`case "${phase}": return "${word}"`);
  });
});
