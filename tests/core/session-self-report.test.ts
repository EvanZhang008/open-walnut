/**
 * Unit tests for the session self-report parsing in session-hooks/builtins.ts.
 *
 * These cover the pure helpers that turn a side_question self-report into a
 * Tier-1 task.summary: extractField (label extraction, tolerant of bold markers
 * and missing fields) and summaryFromSelfReport (field selection + formatting).
 */
import { describe, it, expect } from 'vitest';
import { extractField, summaryFromSelfReport, milestoneFromSelfReport } from '../../src/core/session-hooks/builtins.js';

const SAMPLE = `WHAT_I_DID: Added READ_ONLY_TOOL_NAMES allowlist in tools.ts and wired triage to use it.
STATUS: succeeded — build passes, triage can no longer create tasks.
CHANGES_TRIED: First tried a denylist, abandoned it because new tools would default to writable.
PHASE_SIGNAL: implement-done
NEXT_STEPS: Run /verify on an ephemeral server to confirm no write tools leak.
BLOCKERS: none
USER_INTENT: workflow-command — user said "proceed".
VERIFIED: assumed — have not run the e2e test yet.
ARTIFACTS: src/agent/tools.ts, src/web/server.ts`;

describe('extractField', () => {
  it('extracts a single-line field', () => {
    expect(extractField(SAMPLE, 'PHASE_SIGNAL')).toBe('implement-done');
  });

  it('extracts a field that contains an em-dash and punctuation', () => {
    expect(extractField(SAMPLE, 'STATUS')).toBe('succeeded — build passes, triage can no longer create tasks.');
  });

  it('returns empty string for an absent field', () => {
    expect(extractField(SAMPLE, 'NONEXISTENT')).toBe('');
  });

  it('tolerates **bold** label markers', () => {
    const bolded = `**WHAT_I_DID**: Fixed the parser.\n**STATUS**: succeeded — ok.`;
    expect(extractField(bolded, 'WHAT_I_DID')).toBe('Fixed the parser.');
    expect(extractField(bolded, 'STATUS')).toBe('succeeded — ok.');
  });

  it('stops at the next ALL-CAPS label (does not bleed into following field)', () => {
    expect(extractField(SAMPLE, 'BLOCKERS')).toBe('none');
  });

  it('captures a multi-line field up to the next label', () => {
    const multi = `WHAT_I_DID: line one\nline two continues here.\nSTATUS: succeeded — done.`;
    expect(extractField(multi, 'WHAT_I_DID')).toBe('line one\nline two continues here.');
  });

  it('does NOT truncate at an unrelated ALL-CAPS WORD: line (only known labels terminate)', () => {
    // "API:" / "TODO:" are not self-report labels — a wrapped field must keep them.
    const wrapped = `NEXT_STEPS: Update the sender.\nAPI: must bump the version too.\nTODO: write docs.\nBLOCKERS: none`;
    expect(extractField(wrapped, 'NEXT_STEPS')).toBe(
      'Update the sender.\nAPI: must bump the version too.\nTODO: write docs.',
    );
    // The real next label still terminates correctly.
    expect(extractField(wrapped, 'BLOCKERS')).toBe('none');
  });
});

describe('summaryFromSelfReport', () => {
  it('builds ONE single-paragraph summary (no labelled sub-sections)', () => {
    const out = summaryFromSelfReport(SAMPLE);
    // Single paragraph: WHAT_I_DID is the spine + a trailing "Next: …" clause.
    expect(out).toContain('READ_ONLY_TOOL_NAMES allowlist');
    expect(out).toContain('Next: Run /verify');
    // No multi-section bold field labels — this is the core of the "one summary" fix.
    expect(out).not.toContain('**Session Summary**');
    expect(out).not.toContain('**Current Agent Status**');
    expect(out).not.toContain('**Next Steps**');
    // It's one line (no embedded newlines).
    expect(out).not.toContain('\n');
  });

  it('appends a status qualifier only for failed/blocked/waiting (not "succeeded")', () => {
    const blocked = `WHAT_I_DID: Wired the FIFO reader.\nSTATUS: blocked — port conflict.\nPHASE_SIGNAL: verify-fail`;
    const out = summaryFromSelfReport(blocked);
    expect(out).toContain('Wired the FIFO reader.');
    expect(out).toContain('(blocked — port conflict.)');
    // A "succeeded" status is implied by progress and should NOT be appended.
    const succeeded = `WHAT_I_DID: Shipped the parser.\nSTATUS: succeeded — all good.`;
    expect(summaryFromSelfReport(succeeded)).toBe('Shipped the parser.');
  });

  it('falls back to STATUS when WHAT_I_DID is absent', () => {
    const partial = `STATUS: blocked — port conflict.\nPHASE_SIGNAL: verify-fail`;
    expect(summaryFromSelfReport(partial)).toBe('blocked — port conflict.');
  });

  it('returns empty string when the report has no usable fields', () => {
    expect(summaryFromSelfReport('garbage with no labels')).toBe('');
  });
});

describe('milestoneFromSelfReport', () => {
  it('builds a one-line milestone for a real PHASE_SIGNAL transition', () => {
    const m = milestoneFromSelfReport(SAMPLE);
    expect(m).not.toBeNull();
    expect(m!.signal).toBe('implement-done');
    expect(m!.line).toBe('🔧 Implemented — Added READ_ONLY_TOOL_NAMES allowlist in tools.ts and wired triage to use it.');
  });

  it('matches the bare keyword inside committed(<hash>)', () => {
    const report = `WHAT_I_DID: Closed the session with a commit.\nPHASE_SIGNAL: committed(abc1234)`;
    const m = milestoneFromSelfReport(report);
    expect(m).not.toBeNull();
    expect(m!.signal).toBe('committed');
    expect(m!.line).toBe('📦 Committed — Closed the session with a commit.');
  });

  it('returns null for noise signals (conversational / reconfirmed)', () => {
    expect(milestoneFromSelfReport(`WHAT_I_DID: Answered a question.\nPHASE_SIGNAL: conversational(user-asked-question)`)).toBeNull();
    expect(milestoneFromSelfReport(`WHAT_I_DID: Re-checked the plan.\nPHASE_SIGNAL: reconfirmed`)).toBeNull();
  });

  it('returns null when WHAT_I_DID is missing even on a real signal', () => {
    expect(milestoneFromSelfReport(`PHASE_SIGNAL: verify-pass`)).toBeNull();
  });

  it('returns null when there is no PHASE_SIGNAL at all', () => {
    expect(milestoneFromSelfReport(`WHAT_I_DID: did stuff.`)).toBeNull();
  });
});
