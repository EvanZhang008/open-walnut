/**
 * Suggestion accuracy ledger (src/core/suggest-accuracy.ts).
 *
 * The feature exists because "the draft's auto-suggestions feel inaccurate" was
 * unfalsifiable — the parse fills the launch pills while you type and nothing
 * recorded whether the launch kept them. So the claims worth pinning are about
 * whether the ledger can be TRUSTED as evidence:
 *   - the three verdicts mean what they say (kept / changed / cleared),
 *   - a stored verdict is never silently re-judged by a later rule,
 *   - the file is bounded, so telemetry can't become a disk incident,
 *   - a half-written tail (killed process) costs one line, not the ledger,
 *   - and the composer TEXT never lands in it.
 *
 * WALNUT_HOME is forced to a per-pid temp dir under VITEST (see src/constants.ts),
 * so these write to a throwaway path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fsp from 'node:fs/promises';
import {
  SUGGEST_MAX_RECORDS,
  SUGGEST_TRIM_AT,
  recordSuggestDiff,
  readSuggestRecords,
  summarizeSuggestAccuracy,
  suggestAccuracyFile,
  verdictFor,
} from '../../src/core/suggest-accuracy.js';

async function wipe(): Promise<void> {
  await fsp.rm(suggestAccuracyFile(), { force: true });
}

beforeEach(wipe);

describe('verdictFor', () => {
  it('reads the same value as kept', () => {
    expect(verdictFor({ field: 'project', suggested: 'Walnut', chosen: 'Walnut' })).toBe('kept');
  });

  it('reads a different value as changed', () => {
    expect(verdictFor({ field: 'project', suggested: 'Walnut', chosen: 'Fix Walnut' })).toBe('changed');
  });

  it('reads an absent OR empty choice as dropped', () => {
    // Both spellings reach here: an unpinned tier arrives as undefined, and an
    // empty-string project (Inbox) must not read as "changed to nothing".
    expect(verdictFor({ field: 'pinTier', suggested: 'focus' })).toBe('dropped');
    expect(verdictFor({ field: 'project', suggested: 'Walnut', chosen: '' })).toBe('dropped');
  });
});

describe('recordSuggestDiff', () => {
  it('appends one line per commit, with a verdict per entry', async () => {
    await recordSuggestDiff({
      surface: 'draft-session',
      textLen: 42,
      entries: [
        { field: 'project', suggested: 'Walnut', chosen: 'Fix Walnut' },
        { field: 'pinTier', suggested: 'focus', chosen: 'satellite' },
        { field: 'priority', suggested: 'important' },
      ],
    });

    const records = await readSuggestRecords();
    expect(records).toHaveLength(1);
    expect(records[0].surface).toBe('draft-session');
    expect(records[0].textLen).toBe(42);
    expect(records[0].entries.map((e) => [e.field, e.verdict])).toEqual([
      ['project', 'changed'],
      ['pinTier', 'changed'],
      ['priority', 'dropped'],
    ]);
  });

  it('writes NOTHING when the parse suggested nothing', async () => {
    // The common case by far (a short message the parse had no opinion about).
    // An empty record per launch would be pure noise in the ledger.
    await recordSuggestDiff({ surface: 'draft-session', entries: [] });
    expect(await readSuggestRecords()).toEqual([]);
  });

  it('drops unknown fields and empty suggestions rather than recording junk', async () => {
    await recordSuggestDiff({
      surface: 'draft-session',
      entries: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { field: 'nonsense' as any, suggested: 'x' },
        { field: 'project', suggested: '' },
        { field: 'project', suggested: 'Walnut', chosen: 'Walnut' },
      ],
    });
    const records = await readSuggestRecords();
    expect(records[0].entries).toHaveLength(1);
    expect(records[0].entries[0]).toMatchObject({ field: 'project', verdict: 'kept' });
  });

  it('never stores the composer text — only its length', async () => {
    const secret = 'rotate the production database credentials for acme';
    await recordSuggestDiff({
      surface: 'draft-session',
      textLen: secret.length,
      entries: [{ field: 'project', suggested: 'Acme', chosen: 'Acme' }],
    });
    const raw = await fsp.readFile(suggestAccuracyFile(), 'utf-8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain(`"textLen":${secret.length}`);
  });

  it('keeps the ledger bounded instead of growing forever', async () => {
    // Seed a ledger already OVER the trim threshold by writing the file directly,
    // then commit once through the real append path. Driving 2700 launches through
    // recordSuggestDiff proved the same thing but took ~54s under load — and the
    // thing under test is the trim, which one append past the threshold exercises.
    const overflow = Array.from(
      { length: SUGGEST_TRIM_AT + 50 },
      (_, i) => JSON.stringify({
        at: '2026-08-01T00:00:00.000Z',
        surface: 'draft-session',
        entries: [{ field: 'project', suggested: `P${i}`, chosen: `P${i}`, verdict: 'kept' }],
      }),
    ).join('\n') + '\n';
    await fsp.mkdir(suggestAccuracyFile().replace(/\/[^/]+$/, ''), { recursive: true });
    await fsp.writeFile(suggestAccuracyFile(), overflow, 'utf-8');

    await recordSuggestDiff({
      surface: 'draft-session',
      entries: [{ field: 'project', suggested: 'NEWEST', chosen: 'NEWEST' }],
    });

    const records = await readSuggestRecords();
    expect(records.length).toBe(SUGGEST_MAX_RECORDS);
    // The TAIL survived — a trim that kept the OLDEST records would make the
    // accuracy number describe last month instead of this week.
    expect(records[records.length - 1].entries[0].suggested).toBe('NEWEST');
  });

  it('lets the count drift up to the trim threshold rather than rewriting every append', async () => {
    // The bound is amortized on purpose: telemetry rides a launch, so the common
    // path has to be an append, not a read-rewrite of the whole ledger. This pins
    // that SUGGEST_TRIM_AT is the real ceiling — the previous version of this test
    // asserted SUGGEST_MAX_RECORDS and failed, which is the honest reading of the
    // design, not of the code.
    expect(SUGGEST_TRIM_AT).toBeGreaterThan(SUGGEST_MAX_RECORDS);

    const justUnder = Array.from(
      { length: SUGGEST_TRIM_AT },
      () => JSON.stringify({
        at: '2026-08-01T00:00:00.000Z',
        surface: 'draft-session',
        entries: [{ field: 'project', suggested: 'P', chosen: 'P', verdict: 'kept' }],
      }),
    ).join('\n') + '\n';
    await fsp.mkdir(suggestAccuracyFile().replace(/\/[^/]+$/, ''), { recursive: true });
    await fsp.writeFile(suggestAccuracyFile(), justUnder, 'utf-8');

    await recordSuggestDiff({
      surface: 'draft-session',
      entries: [{ field: 'project', suggested: 'P', chosen: 'P' }],
    });
    // One past the threshold → trimmed. At the threshold it would have been left.
    expect((await readSuggestRecords()).length).toBe(SUGGEST_MAX_RECORDS);
  });
});

describe('summarizeSuggestAccuracy', () => {
  it('counts per field and overall, with accuracy = kept / total', async () => {
    await recordSuggestDiff({
      surface: 'draft-session',
      entries: [
        { field: 'project', suggested: 'Walnut', chosen: 'Walnut' },
        { field: 'pinTier', suggested: 'focus', chosen: 'satellite' },
      ],
    });
    await recordSuggestDiff({
      surface: 'draft-task',
      entries: [
        { field: 'project', suggested: 'Walnut', chosen: 'Walnut' },
        { field: 'pinTier', suggested: 'wait' },
      ],
    });

    const summary = await summarizeSuggestAccuracy();
    expect(summary.commits).toBe(2);
    expect(summary.fields.project).toMatchObject({ kept: 2, changed: 0, dropped: 0, total: 2, accuracy: 1 });
    expect(summary.fields.pinTier).toMatchObject({ kept: 0, changed: 1, dropped: 1, total: 2, accuracy: 0 });
    expect(summary.overall).toMatchObject({ kept: 2, total: 4, accuracy: 0.5 });
    // A field nobody ever suggested reads as "no evidence", not as 0% accurate —
    // those are very different answers to "is this any good".
    expect(summary.fields.endDate).toMatchObject({ total: 0, accuracy: null });
  });

  it('returns the newest records first, capped by limit', async () => {
    for (const name of ['A', 'B', 'C']) {
      await recordSuggestDiff({
        surface: 'draft-session',
        entries: [{ field: 'project', suggested: name, chosen: name }],
      });
    }
    const summary = await summarizeSuggestAccuracy(2);
    expect(summary.recent.map((r) => r.entries[0].suggested)).toEqual(['C', 'B']);
  });

  it('trusts the STORED verdict over recomputing it', async () => {
    // A verdict was assigned under the rule that was live when the user chose. If a
    // later build re-judged old lines, yesterday's number would move on its own and
    // the ledger would stop being auditable — so a hand-written line that disagrees
    // with today's rule is honoured as written.
    await fsp.mkdir(suggestAccuracyFile().replace(/\/[^/]+$/, ''), { recursive: true });
    await fsp.writeFile(
      suggestAccuracyFile(),
      JSON.stringify({
        at: '2026-08-01T00:00:00.000Z',
        surface: 'draft-session',
        entries: [{ field: 'project', suggested: 'Walnut', chosen: 'Other', verdict: 'kept' }],
      }) + '\n',
      'utf-8',
    );
    const summary = await summarizeSuggestAccuracy();
    expect(summary.fields.project).toMatchObject({ kept: 1, changed: 0 });
  });

  it('survives a half-written tail and a missing file', async () => {
    expect(await summarizeSuggestAccuracy()).toMatchObject({ commits: 0 });

    await recordSuggestDiff({
      surface: 'draft-session',
      entries: [{ field: 'project', suggested: 'Walnut', chosen: 'Walnut' }],
    });
    // Exactly what a SIGKILL mid-append leaves behind.
    await fsp.appendFile(suggestAccuracyFile(), '{"at":"2026-08-01T00:00:00.000Z","entr', 'utf-8');

    const summary = await summarizeSuggestAccuracy();
    expect(summary.commits).toBe(1);
    expect(summary.fields.project.kept).toBe(1);
  });
});
