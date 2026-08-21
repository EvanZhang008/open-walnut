/**
 * Unit tests for the session self-report parsing in session-hooks/builtins.ts.
 *
 * These cover the pure helpers of the NOTE-based self-report (2026-07-18 redesign:
 * the task NOTE is the single living document — canonical sections, per-section answers):
 * extractField (label extraction), parseNoteSections (note → sections),
 * parseSectionAnswer (per-section unchanged/append/rewrite), assembleNote
 * (existing note + report → new note), and noteShrinkRejected (fact-loss guard).
 */
import { describe, it, expect } from 'vitest';
import {
  extractField, parseNoteSections, parseSectionAnswer, assembleNote,
  noteShrinkRejected, buildSelfReportPrompt, NOTE_REORG_CAP,
} from '../../src/core/session-hooks/builtins.js';

const SAMPLE = `EXEC_SUMMARY: unchanged
USER_REQUEST: unchanged
CONTEXT: unchanged
PROGRESS: DONE parser — done
WIP e2e verify — in progress
WORK_LOG: append: Added READ_ONLY_TOOL_NAMES allowlist in tools.ts; found denylist approach fails open for new tools; committed abc123.
STATUS: succeeded — build passes, triage can no longer create tasks.
PHASE_SIGNAL: implement-done
WHAT_I_DID: Added READ_ONLY_TOOL_NAMES allowlist in tools.ts.
NEXT_STEPS: Run /verify on an ephemeral server.
BLOCKERS: none
USER_INTENT: workflow-command — user said "proceed".
VERIFIED: assumed — have not run the e2e test yet.`;

const STRUCTURED_NOTE = `## Executive Summary
Migrating the session store to SQLite. Dual-write shipped; cutover pending.

## User Request
All session reads/writes go through SQLite with zero data loss; done when the 48h parity check passes.

## Context
sessions.json hit lock contention at ~1400 sessions. SQLite chosen over LMDB for tooling.

## Progress
DONE dual-write — done
WIP parity check — in progress

## References
- [ISSUE-4821 — Session store lock contention](https://tracker.example.com/ISSUE-4821) — driving issue

## Work Log
- Implemented dual-write behind WALNUT_SQLITE=1; found EXDEV pitfall (tmp must be same-dir); committed def456.`;

describe('extractField', () => {
  it('extracts a single-line field', () => {
    expect(extractField(SAMPLE, 'PHASE_SIGNAL')).toBe('implement-done');
  });

  it('captures a multi-line field up to the next known label', () => {
    expect(extractField(SAMPLE, 'PROGRESS')).toBe('DONE parser — done\nWIP e2e verify — in progress');
  });

  it('tolerates **bold** label markers', () => {
    const bolded = `**WORK_LOG**: append: Fixed the parser.\n**STATUS**: succeeded — ok.`;
    expect(extractField(bolded, 'WORK_LOG')).toBe('append: Fixed the parser.');
  });

  it('does NOT truncate at an unrelated ALL-CAPS WORD: line (only known labels terminate)', () => {
    const wrapped = `NEXT_STEPS: Update the sender.\nAPI: must bump the version too.\nBLOCKERS: none`;
    expect(extractField(wrapped, 'NEXT_STEPS')).toBe('Update the sender.\nAPI: must bump the version too.');
    expect(extractField(wrapped, 'BLOCKERS')).toBe('none');
  });
});

describe('parseNoteSections', () => {
  it('splits a structured note into its sections', () => {
    const { sections, preamble } = parseNoteSections(STRUCTURED_NOTE);
    expect(preamble).toBe('');
    expect(sections['Executive Summary']).toContain('Migrating the session store');
    expect(sections['User Request']).toContain('48h parity check');
    expect(sections['References']).toContain('ISSUE-4821');
    expect(sections['Work Log']).toContain('def456');
  });

  it('normalizes a legacy "## Goal" header into User Request (pre-rename notes)', () => {
    const legacy = '## Goal\nShip the widget.\n\n## Progress\n- [WIP] widget';
    const { sections } = parseNoteSections(legacy);
    expect(sections['User Request']).toBe('Ship the widget.');
    expect(sections['Progress']).toContain('widget');
  });

  it('returns a free-form (pre-migration) note entirely as preamble', () => {
    const { sections, preamble } = parseNoteSections('Goal: do X\nsome free-form notes here');
    expect(Object.keys(sections)).toHaveLength(0);
    expect(preamble).toContain('free-form notes');
  });

  it('recognizes a header at end-of-string (empty last section, no trailing newline)', () => {
    // Regression: headerRe required `\n` after the name, so a trimmed note ending
    // `## Work Log` left that header inside Progress's body and the next assemble
    // fabricated a SECOND `## Work Log` header — corruption compounding per fire.
    const note = '## Progress\nWIP thing\n\n## Work Log';
    const { sections } = parseNoteSections(note);
    expect(sections['Work Log']).toBe('');
    expect(sections['Progress']).toBe('WIP thing');
    expect(sections['Progress']).not.toContain('## Work Log');
  });

  it('merges duplicate-header bodies instead of last-wins dropping the earlier one', () => {
    const { sections } = parseNoteSections('## Work Log\n- A\n\n## Work Log\n- B');
    expect(sections['Work Log']).toContain('- A');
    expect(sections['Work Log']).toContain('- B');
  });
});

describe('parseSectionAnswer', () => {
  it('parses unchanged / append / plain content', () => {
    expect(parseSectionAnswer(SAMPLE, 'User Request')).toEqual({ kind: 'unchanged' });
    expect(parseSectionAnswer(SAMPLE, 'Work Log').kind).toBe('append');
    expect(parseSectionAnswer(SAMPLE, 'Progress')).toEqual({
      kind: 'rewrite', text: 'DONE parser — done\nWIP e2e verify — in progress',
    });
  });

  it('an absent label is none (treated as unchanged downstream)', () => {
    expect(parseSectionAnswer('STATUS: ok', 'Context')).toEqual({ kind: 'none' });
  });

  it('tolerates backtick wrapping and casing on markers', () => {
    expect(parseSectionAnswer('USER_REQUEST: `unchanged`', 'User Request')).toEqual({ kind: 'unchanged' });
    expect(parseSectionAnswer('WORK_LOG: APPEND: entry here', 'Work Log'))
      .toEqual({ kind: 'append', text: 'entry here' });
  });

  it('accepts the legacy GOAL label for the User Request section (mid-turn rename)', () => {
    expect(parseSectionAnswer('GOAL: Ship the widget.', 'User Request'))
      .toEqual({ kind: 'rewrite', text: 'Ship the widget.' });
    expect(parseSectionAnswer('GOAL: unchanged', 'User Request')).toEqual({ kind: 'unchanged' });
  });

  it('marker-less Work Log content defaults to append, never rewrite (append-only log)', () => {
    // A session that forgets the `append:` prefix must not wipe the whole log
    // with one turn's entry; other sections keep marker-less = rewrite.
    expect(parseSectionAnswer('WORK_LOG: fixed the parser, commit abc123.', 'Work Log'))
      .toEqual({ kind: 'append', text: 'fixed the parser, commit abc123.' });
    expect(parseSectionAnswer('CONTEXT: new background here.', 'Context'))
      .toEqual({ kind: 'rewrite', text: 'new background here.' });
  });
});

describe('assembleNote', () => {
  it('applies per-section answers: append adds a bullet, rewrite replaces, unchanged keeps', () => {
    const out = assembleNote(STRUCTURED_NOTE, SAMPLE);
    expect(out).not.toBeNull();
    expect(out!.changed).toEqual(['Progress', 'Work Log']);
    // Unchanged sections preserved verbatim.
    expect(out!.note).toContain('Migrating the session store');
    expect(out!.note).toContain('EXDEV pitfall');
    // Work Log appended as a new bullet.
    expect(out!.note).toContain('- Added READ_ONLY_TOOL_NAMES allowlist');
    // Progress replaced.
    expect(out!.note).toContain('WIP e2e verify — in progress');
    expect(out!.note).not.toContain('WIP parity check');
  });

  it('returns null when every section is unchanged/absent (skip persist)', () => {
    const allUnchanged = 'EXEC_SUMMARY: unchanged\nUSER_REQUEST: unchanged\nCONTEXT: unchanged\nPROGRESS: unchanged\nWORK_LOG: unchanged\nSTATUS: ok';
    expect(assembleNote(STRUCTURED_NOTE, allUnchanged)).toBeNull();
  });

  it('a full sectioned answer supersedes a free-form note (migration) — even without REFERENCES', () => {
    // References is OPTIONAL: a migration answering every mandatory section but
    // carrying no references must still count as complete (else the free-form
    // preamble of a reference-less task is kept forever).
    const freeform = 'Goal: roll out READMEs\nProgress so far: pilot done';
    const migration = `EXEC_SUMMARY: Rolling out READMEs; pilot done.
USER_REQUEST: Roll out READMEs to all teams.
CONTEXT: Cloud copies drifted from local AGENTS.md.
PROGRESS: DONE pilot — done
WORK_LOG: append: Pilot synced 49 READMEs.`;
    const out = assembleNote(freeform, migration);
    expect(out).not.toBeNull();
    expect(out!.note).toContain('## Executive Summary');
    // Old free-form body dropped ONLY because all mandatory sections were provided.
    expect(out!.note).not.toContain('Progress so far');
  });

  it('REFERENCES answers rewrite the curated index in place', () => {
    const report = `REFERENCES: - [ISSUE-4821 — Session store lock contention](https://tracker.example.com/ISSUE-4821) — driving issue
- [PM-77 — June session-store data-loss postmortem](https://postmortems.example.com/PM-77) — action item source`;
    const out = assembleNote(STRUCTURED_NOTE, report);
    expect(out).not.toBeNull();
    expect(out!.changed).toEqual(['References']);
    expect(out!.note).toContain('PM-77 — June session-store data-loss postmortem');
    // Rendered under its own header, between Progress and Work Log.
    expect(out!.note).toMatch(/## Progress[\s\S]*## References[\s\S]*## Work Log/);
  });

  it('an INCOMPLETE structured answer keeps the free-form body as preamble (nothing dropped)', () => {
    const freeform = 'Important fact: cron 108e42e5 must stay deleted.';
    const partial = 'PROGRESS: WIP investigating\nWORK_LOG: append: started digging.';
    const out = assembleNote(freeform, partial);
    expect(out).not.toBeNull();
    expect(out!.note).toContain('cron 108e42e5');
  });

  it('a preamble above a fully-structured note survives a single-section append', () => {
    // Regression: `migrated` was computed from the merged RESULT (all five present),
    // so once the note had five headers, any human text above the first header was
    // silently dropped by the very next append. Must be judged on THIS report.
    const withPreamble = `HUMAN PREAMBLE: keep me.\n\n${STRUCTURED_NOTE}`;
    const out = assembleNote(withPreamble, 'WORK_LOG: append: one more entry.');
    expect(out).not.toBeNull();
    expect(out!.note).toContain('HUMAN PREAMBLE: keep me.');
  });

  it('appends to an empty Work Log section without a stray blank bullet', () => {
    const noLogNote = STRUCTURED_NOTE.replace(/## Work Log[\s\S]*$/, '## Work Log\n');
    const out = assembleNote(noLogNote.trim(), 'WORK_LOG: append: first entry, commit aaa111.');
    expect(out!.note).toMatch(/## Work Log\n- first entry/);
    // The EOF-header fix: exactly ONE Work Log header in the result.
    expect(out!.note.match(/## Work Log/g)).toHaveLength(1);
  });
});

describe('noteShrinkRejected', () => {
  it('small notes rewrite freely', () => {
    expect(noteShrinkRejected('short note', '')).toBe(false);
  });

  it('rejects a large note shrinking below 40%', () => {
    const oldNote = 'x'.repeat(2000);
    expect(noteShrinkRejected(oldNote, 'y'.repeat(700))).toBe(true);
    expect(noteShrinkRejected(oldNote, 'y'.repeat(900))).toBe(false);
  });

  it('over-cap notes use an ABSOLUTE floor so a compliant mandatory reorganize is never rejected', () => {
    // Deadlock regression: for old ≥ 15000, 0.4×old ≥ NOTE_REORG_CAP, so the
    // proportional floor rejected every reorganize that landed under the cap as
    // instructed — the note could never shrink. Over-cap fires floor at cap×0.4.
    const big = 'x'.repeat(20000);
    expect(noteShrinkRejected(big, 'y'.repeat(5900))).toBe(false); // compliant reorg passes
    expect(noteShrinkRejected(big, 'y'.repeat(2000))).toBe(true);  // real fact-dump still caught
    expect(noteShrinkRejected('x'.repeat(15001), 'y'.repeat(5999))).toBe(false);
  });

  it('References, once present, is protected from deletion (external-ID index)', () => {
    // Bulk up Work Log so total length stays high — only the References drop
    // should trip the guard.
    const oldNote = STRUCTURED_NOTE.replace(/## Work Log\n/, `## Work Log\n- ${'evidence '.repeat(250)}\n`);
    const newNote = oldNote.replace(/## References\n[\s\S]*?(?=\n\n## )/, '');
    expect(noteShrinkRejected(oldNote, newNote)).toBe(true);
  });

  it('an EMPTY-bodied section header may disappear without tripping the guard (no freeze)', () => {
    // The assembler renders no header for an empty body, so a note carrying an
    // empty `## References` (or `## Progress`) header loses that header on the
    // very next fire. Judging deletion on header PRESENCE would reject that fire
    // and every one after it — permanent freeze. Deletion is judged on BODY.
    const withEmptyRefs = STRUCTURED_NOTE.replace(/## References\n[\s\S]*?(?=\n\n## )/, '## References\n');
    const nextFire = withEmptyRefs.replace(/## References\n\n/, '');
    expect(noteShrinkRejected(withEmptyRefs, nextFire)).toBe(false);
  });

  it('over-cap reorganize may consolidate References below 40% (curated-index contract)', () => {
    // The MANDATORY REORGANIZE prompt orders the index deduped/consolidated;
    // the per-section proportional floor must not reject that exact compliance.
    // Under the cap the same shrink is still caught (silent wipe protection).
    const refs = Array.from({ length: 40 }, (_, i) =>
      `- [ISSUE-${1000 + i} — Issue number ${i} with a long descriptive title](https://tracker.example.com/ISSUE-${1000 + i}) — related`).join('\n');
    const consolidated = '- [ISSUE-1000 — Umbrella: session store issues](https://tracker.example.com/ISSUE-1000) — supersedes 40 duplicates';
    const overCap = STRUCTURED_NOTE
      .replace(/## References\n[\s\S]*?(?=\n\n## )/, `## References\n${refs}\n`)
      .replace(/## Work Log\n/, `## Work Log\n- ${'evidence '.repeat(400)}\n`);
    expect(overCap.length).toBeGreaterThan(NOTE_REORG_CAP);
    // Only References is consolidated; the rest of the note keeps its bulk so
    // the whole-note absolute floor (cap × 0.4) is not what's under test here.
    const reorganized = overCap
      .replace(/## References\n[\s\S]*?(?=\n\n## )/, `## References\n${consolidated}\n`);
    expect(noteShrinkRejected(overCap, reorganized)).toBe(false);

    const underCap = STRUCTURED_NOTE.replace(/## References\n[\s\S]*?(?=\n\n## )/, `## References\n${refs}\n`);
    const wiped = underCap.replace(/## References\n[\s\S]*?(?=\n\n## )/, `## References\n${consolidated}\n`);
    expect(underCap.length).toBeLessThan(NOTE_REORG_CAP);
    expect(noteShrinkRejected(underCap, wiped)).toBe(true);
  });

  it('protects each durable summary section even when Work Log keeps total length high', () => {
    const protectedSections = ['Executive Summary', 'User Request', 'Context', 'Progress'] as const;
    const oldNote = protectedSections
      .map((section) => `## ${section}\n${section} ${'important fact '.repeat(20)}`)
      .concat(`## Work Log\n${'historical evidence '.repeat(200)}`)
      .join('\n\n');

    for (const section of protectedSections) {
      const newNote = oldNote.replace(
        new RegExp(`(## ${section}\\n)[\\s\\S]*?(?=\\n\\n## )`),
        `$1tiny`,
      );
      expect(noteShrinkRejected(oldNote, newNote), section).toBe(true);
    }
  });

  it('rejects deleting any mandatory section even when its body is short', () => {
    const oldNote = `## Executive Summary
Short summary.

## User Request
Keep the request.

## Context
Keep context.

## Progress
WIP audit.

## Work Log
- ${'evidence '.repeat(250)}`;

    for (const section of ['Executive Summary', 'User Request', 'Context', 'Progress'] as const) {
      const newNote = oldNote.replace(
        new RegExp(`(?:^|\\n\\n)## ${section}\\n[\\s\\S]*?(?=\\n\\n## |$)`),
        '',
      );
      expect(noteShrinkRejected(oldNote, newNote), section).toBe(true);
    }
  });
});

describe('buildSelfReportPrompt', () => {
  it('empty note → asks for all sections', () => {
    expect(buildSelfReportPrompt('')).toContain('NOTE is EMPTY');
  });

  it('feeds the existing note back and offers per-section unchanged', () => {
    const p = buildSelfReportPrompt(STRUCTURED_NOTE);
    expect(p).toContain('<existing_note>');
    expect(p).toContain('EXDEV pitfall');
    expect(p).not.toContain('REORGANIZE');
  });

  it('over the cap → unlocks the Work Log reorganize path with the ID-preservation rule', () => {
    const p = buildSelfReportPrompt('x'.repeat(NOTE_REORG_CAP + 1));
    expect(p).toContain('REORGANIZE');
    expect(p).toContain('keep every external ID');
    expect(p).toContain('commit hashes may be dropped');
  });

  it('always shows the note budget; over the cap the reorganize is mandatory with a shrink target', () => {
    const under = buildSelfReportPrompt('x'.repeat(100));
    expect(under).toContain(`NOTE BUDGET: 100/${NOTE_REORG_CAP} chars`);
    const overLen = NOTE_REORG_CAP + 1;
    const over = buildSelfReportPrompt('x'.repeat(overLen));
    expect(over).toContain(`NOTE BUDGET: ${overLen}/${NOTE_REORG_CAP} chars`);
    expect(over).toContain('MANDATORY REORGANIZE');
    expect(over).toContain('SHORTER than it went in');
  });

  it('Progress uses bulleted, bracketed plain-text status labels, never emoji', () => {
    const p = buildSelfReportPrompt('');
    expect(p).toContain('one BULLET per workitem');
    expect(p).toContain('[DONE]');
    expect(p).toContain('[WIP]');
    expect(p).toContain('[TODO]');
    expect(p).toContain('[BLOCKED]/[WAIT]');
    // No emoji status board leaked into the instructions.
    expect(p).not.toMatch(/[✅🔄👀🚀🚧]/u);
  });

  it('User Request restates the user intent concisely (no verbatim quote) with acceptance criteria', () => {
    const p = buildSelfReportPrompt('');
    expect(p).toContain('USER_REQUEST:');
    expect(p).toMatch(/do NOT quote the user verbatim/);
    expect(p).toContain('acceptance criteria');
  });

  it('Work Log demands external ids but forbids commit hashes', () => {
    const p = buildSelfReportPrompt('');
    expect(p).toContain('ALWAYS carry EXTERNAL ids');
    expect(p).toContain('NEVER include commit hashes');
  });

  it('References asks for markdown links with both id and title findable as text', () => {
    const p = buildSelfReportPrompt('');
    expect(p).toContain('REFERENCES:');
    expect(p).toContain('markdown link');
    expect(p).toMatch(/ID and the TITLE must both appear/);
    // Curated index semantics, not an append-only log.
    expect(p).toContain('curated INDEX');
  });
});

describe('EXEC_SUMMARY multi-workstream contract (2026-08-15 star incident)', () => {
  // task.summary is derived from EXEC_SUMMARY and is a primary search surface.
  // A fork session that pivoted topics used to end with a summary describing
  // ONLY the latest topic — the earlier work (the actual answer to "which task
  // removed X?") vanished from search. The prompt must demand every workstream
  // stays represented.
  it('instructs the session to keep EVERY workstream in the summary', () => {
    const p = buildSelfReportPrompt('');
    expect(p).toContain('EVERY workstream');
    expect(p).toMatch(/never only the latest/i);
  });

  it('explains the why: the summary is a search surface', () => {
    const p = buildSelfReportPrompt('');
    expect(p).toMatch(/search surface/i);
  });
});
