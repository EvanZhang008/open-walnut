/**
 * Live Edit's pure decisions — the parts that decide whether an auto-write is
 * allowed to happen at all.
 *
 * These are separated from the React hook because each one is a rule that costs
 * real data when it is wrong:
 *  - decideAfterConflict is the only thing bounding the pull/merge/write retry
 *    loop; without the bound, two writers racing on one file turn the editor
 *    into an infinite read+write generator.
 *  - agentPathMatches decides whether an agent's write is even ABOUT the open
 *    file. Too loose and every write in the repo triggers a re-read of an
 *    unrelated file; too strict and the pull silently never fires on a remote
 *    host, where the agent's path arrives `~`-relative.
 *  - the suspension map is module state shared by every mounted viewer, so its
 *    key has to separate two hosts that happen to use the same absolute path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  decideAfterConflict, agentPathMatches, MAX_MERGE_ATTEMPTS, AGENT_WRITE_TOOLS,
  liveSuspensionKey, isLiveSuspended, suspendLiveEdit, resumeLiveEdit, clearLiveSuspensions,
  noteFileDeleted, isRecentlyDeleted, noteWritten, freshestBase,
  loadLiveEditPref, LIVE_EDIT_PREF_KEY, LIVE_WRITE_DEBOUNCE_MS,
  planLiveWrite,
} from '../../web/src/hooks/useLiveEdit';
import { threeWayMerge } from '../../web/src/utils/three-way-merge';
import { computeContentHashClient } from '../../web/src/utils/content-hash';

describe('decideAfterConflict', () => {
  const clean = threeWayMerge('a\nb\n', 'A\nb\n', 'a\nB\n');
  const conflicted = threeWayMerge('a\nb\n', 'OURS\nb\n', 'THEIRS\nb\n');

  it('writes the merged text on the first 409 (no cycle has run yet)', () => {
    expect(clean.ok).toBe(true);
    expect(decideAfterConflict(clean, 0)).toEqual({ action: 'write-merged', merged: 'A\nB\n' });
  });

  it('gives up on a conflicting merge, however early the attempt', () => {
    expect(conflicted.ok).toBe(false);
    expect(decideAfterConflict(conflicted, 0)).toEqual({ action: 'give-up' });
  });

  it('gives up once the attempts are exhausted, even for a clean merge', () => {
    // The bound is what stops a file two writers are hammering from becoming an
    // endless read+write cycle.
    expect(decideAfterConflict(clean, MAX_MERGE_ATTEMPTS)).toEqual({ action: 'give-up' });
    expect(decideAfterConflict(clean, MAX_MERGE_ATTEMPTS + 5)).toEqual({ action: 'give-up' });
  });

  it('allows exactly MAX_MERGE_ATTEMPTS cycles, then stops', () => {
    const allowed = [0, 1, 2, 3, 4]
      .filter((attempt) => decideAfterConflict(clean, attempt).action === 'write-merged');
    expect(allowed).toEqual([0, 1, 2]);
    expect(allowed).toHaveLength(MAX_MERGE_ATTEMPTS);
  });
});

describe('agentPathMatches', () => {
  it('matches an identical absolute path', () => {
    expect(agentPathMatches('/work/repo/src/a.ts', '/work/repo/src/a.ts')).toBe(true);
  });

  it('normalises duplicate slashes and /./ segments', () => {
    expect(agentPathMatches('/work/repo/src/a.ts', '/work//repo/./src/a.ts')).toBe(true);
    expect(agentPathMatches('/work//repo/src/a.ts', '/work/repo/src/a.ts')).toBe(true);
  });

  it('matches a ~-relative agent path by its suffix', () => {
    // The remote host's home directory is unknown here, so the tail is all we
    // can compare — and an agent on a dev box routinely reports `~/...`.
    expect(agentPathMatches('/home/dev/repo/src/a.ts', '~/repo/src/a.ts')).toBe(true);
  });

  it('does not match a different file in the same directory', () => {
    expect(agentPathMatches('/work/repo/src/a.ts', '/work/repo/src/b.ts')).toBe(false);
    expect(agentPathMatches('/home/dev/repo/src/a.ts', '~/repo/src/b.ts')).toBe(false);
  });

  it('does not let a ~-suffix match a mere basename collision', () => {
    // `~/a.ts` must not claim `/work/repo/src/a.ts`: the suffix comparison keeps
    // the separator, so "…/src/a.ts".endsWith("/a.ts") is intentional but
    // "…/other/deep/a.ts" vs "~/src/a.ts" is not a match.
    expect(agentPathMatches('/work/repo/other/deep/a.ts', '~/src/a.ts')).toBe(false);
  });

  it('skips the signal when the open path is not absolute', () => {
    // A relative open path has no fixed point to compare against, and guessing
    // would pull a random file into the editor.
    expect(agentPathMatches('src/a.ts', '/work/repo/src/a.ts')).toBe(false);
    expect(agentPathMatches('src/a.ts', 'src/a.ts')).toBe(false);
  });

  it('rejects a relative agent path', () => {
    expect(agentPathMatches('/work/repo/src/a.ts', 'src/a.ts')).toBe(false);
    expect(agentPathMatches('/work/repo/src/a.ts', 'a.ts')).toBe(false);
  });

  it('rejects empty input on either side', () => {
    expect(agentPathMatches('', '/work/a.ts')).toBe(false);
    expect(agentPathMatches('/work/a.ts', '')).toBe(false);
  });

  it('leaves a path containing .. unresolved rather than guessing', () => {
    // Not a resolver: a `..` path simply fails to match instead of matching the
    // wrong file, which is the safe direction for a signal that triggers a read.
    expect(agentPathMatches('/work/repo/src/a.ts', '/work/repo/other/../src/a.ts')).toBe(false);
  });
});

describe('AGENT_WRITE_TOOLS', () => {
  it('covers every tool that writes a file', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(AGENT_WRITE_TOOLS.has(tool)).toBe(true);
    }
  });

  it('ignores tools that only read or run things', () => {
    // A Read or a Bash call must not trigger a pull — the file has not changed,
    // and each pull costs a no-cache round trip to the host.
    for (const tool of ['Read', 'Bash', 'Grep', 'Glob', 'Task', 'TodoWrite']) {
      expect(AGENT_WRITE_TOOLS.has(tool)).toBe(false);
    }
  });
});

describe('per-file suspension', () => {
  beforeEach(() => { clearLiveSuspensions(); });

  it('keys by host + path so the same path on two hosts stays independent', () => {
    expect(liveSuspensionKey(undefined, '/a/b.ts')).toBe('local /a/b.ts');
    expect(liveSuspensionKey('builder', '/a/b.ts')).toBe('builder /a/b.ts');

    suspendLiveEdit('builder', '/a/b.ts');
    expect(isLiveSuspended('builder', '/a/b.ts')).toBe(true);
    expect(isLiveSuspended(undefined, '/a/b.ts')).toBe(false);
  });

  it('resumes only the file that was resumed', () => {
    suspendLiveEdit(undefined, '/a/one.ts');
    suspendLiveEdit(undefined, '/a/two.ts');
    resumeLiveEdit(undefined, '/a/one.ts');
    expect(isLiveSuspended(undefined, '/a/one.ts')).toBe(false);
    expect(isLiveSuspended(undefined, '/a/two.ts')).toBe(true);
  });

  it('is idempotent in both directions', () => {
    suspendLiveEdit(undefined, '/a/b.ts');
    suspendLiveEdit(undefined, '/a/b.ts');
    resumeLiveEdit(undefined, '/a/b.ts');
    resumeLiveEdit(undefined, '/a/b.ts');
    expect(isLiveSuspended(undefined, '/a/b.ts')).toBe(false);
  });
});

describe('recently deleted paths', () => {
  // The server's PUT creates a missing file, so a live write armed before a
  // delete (or flushed on unmount after it) would bring the file back.
  beforeEach(() => { clearLiveSuspensions(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('refuses the deleted file and anything under a deleted directory', () => {
    noteFileDeleted(undefined, '/repo/gone.ts');
    noteFileDeleted(undefined, '/repo/dir');
    expect(isRecentlyDeleted(undefined, '/repo/gone.ts')).toBe(true);
    expect(isRecentlyDeleted(undefined, '/repo/dir/deep/x.ts')).toBe(true);
    // A sibling that merely shares the prefix is a different file.
    expect(isRecentlyDeleted(undefined, '/repo/dir-2/x.ts')).toBe(false);
    expect(isRecentlyDeleted(undefined, '/repo/gone.ts.bak')).toBe(false);
  });

  it('is scoped to the host', () => {
    noteFileDeleted('builder', '/repo/a.ts');
    expect(isRecentlyDeleted('builder', '/repo/a.ts')).toBe(true);
    expect(isRecentlyDeleted(undefined, '/repo/a.ts')).toBe(false);
  });

  it('forgets the delete after the window, so recreating the name works again', () => {
    noteFileDeleted(undefined, '/repo/a.ts');
    vi.advanceTimersByTime(59_000);
    expect(isRecentlyDeleted(undefined, '/repo/a.ts')).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(isRecentlyDeleted(undefined, '/repo/a.ts')).toBe(false);
  });
});

describe('freshestBase', () => {
  // A record for a file the panel has LEFT carries the base captured at keystroke
  // time. If one of our own writes landed after that keystroke, that base is no
  // longer what is on disk and the flush would 409 against our own bytes.
  //
  // It hands back BYTES, not a hash, because the write's token is now derived from
  // the base rather than quoted: a correction that cannot show the bytes it claims
  // are on disk is exactly the kind of unprovable token this bug was made of.
  beforeEach(() => { clearLiveSuspensions(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns the captured base when nothing was written since', () => {
    expect(freshestBase(undefined, '/a.ts', 'base0', Date.now())).toBe('base0');
    noteWritten(undefined, '/a.ts', 'h1', 'our write 1');
    vi.advanceTimersByTime(10);
    expect(freshestBase(undefined, '/a.ts', 'base2', Date.now())).toBe('base2');
  });

  it("swaps in our newer write's TEXT for a record captured before it", () => {
    const capturedAt = Date.now();
    vi.advanceTimersByTime(10);
    noteWritten(undefined, '/a.ts', 'h1', 'our write 1');
    expect(freshestBase(undefined, '/a.ts', 'base0', capturedAt)).toBe('our write 1');
    // Another file, another host: their writes are not this file's.
    expect(freshestBase(undefined, '/b.ts', 'base0', capturedAt)).toBe('base0');
    expect(freshestBase('builder', '/a.ts', 'base0', capturedAt)).toBe('base0');
  });

  it('moves the base to the EMPTY string when our write emptied the file', () => {
    // The empty string is a real base, not "no base". While `noteWritten` let the
    // text be omitted and defaulted it to '', these two were the same value, so a
    // write that emptied a file could not move the base — and the next flush then
    // 409'd against bytes WE had just written and was dropped. `text` is required
    // for exactly this reason.
    const capturedAt = Date.now();
    vi.advanceTimersByTime(10);
    noteWritten(undefined, '/c.ts', 'h-empty', '');
    expect(freshestBase(undefined, '/c.ts', 'base0', capturedAt)).toBe('');
  });

  it('holds a bounded number of files (it stores whole file texts)', () => {
    for (let i = 0; i < 20; i++) noteWritten(undefined, `/f${i}.ts`, `h${i}`, `text ${i}`);
    const capturedAt = Date.now() - 1000;
    // The newest is remembered, the oldest was evicted.
    expect(freshestBase(undefined, '/f19.ts', 'base0', capturedAt)).toBe('text 19');
    expect(freshestBase(undefined, '/f0.ts', 'base0', capturedAt)).toBe('base0');
  });
});

describe('preference', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is OFF when nothing was ever stored', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(loadLiveEditPref()).toBe(false);
  });

  it("is ON only for '1'", () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === LIVE_EDIT_PREF_KEY ? '1' : null) });
    expect(loadLiveEditPref()).toBe(true);
    vi.stubGlobal('localStorage', { getItem: () => '0' });
    expect(loadLiveEditPref()).toBe(false);
    vi.stubGlobal('localStorage', { getItem: () => 'true' });
    expect(loadLiveEditPref()).toBe(false);
  });

  it('degrades to OFF when storage throws', () => {
    // Private browsing / blocked storage must not turn auto-writing on by
    // accident, and must not throw during a render.
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(loadLiveEditPref()).toBe(false);
  });
});

describe('timing constants', () => {
  it('debounces writes rather than writing per keystroke', () => {
    expect(LIVE_WRITE_DEBOUNCE_MS).toBeGreaterThanOrEqual(300);
  });
});

describe('planLiveWrite — an armed write may not outlive the buffer it came from', () => {
  // 2026-09-05: a remote design doc was overwritten with a stale 28 KB copy four
  // times, each write about a second after the pane had read the newer bytes. The
  // write sent the text captured earlier together with the lock token the read had
  // just installed, and the server's optimistic lock cannot refuse that pair: it
  // re-reads the file, sees the token match, and accepts. So the rule under test
  // is that a token from one generation is never sent with text from another.
  const BASE = 'what is on disk\n';

  it('writes the armed text while the buffer is still the one it came from', () => {
    expect(planLiveWrite({
      armedText: 'my typing\n', armedGen: 7, currentGen: 7,
      armedBaseText: BASE, bufferText: 'my typing\n', baseContent: BASE,
    })).toEqual({ action: 'write', text: 'my typing\n', baseText: BASE });
  });

  it('NEVER writes text from an older generation — the buffer on screen wins', () => {
    // The incident's exact shape: armedText is the copy loaded before the read,
    // the buffer now holds what the read installed plus the user's edit.
    expect(planLiveWrite({
      armedText: 'the stale copy\n', armedGen: 3, currentGen: 4,
      armedBaseText: 'the stale base\n',
      bufferText: 'the newer file, edited\n', baseContent: 'the newer file\n',
      // The base follows the TEXT: writing the buffer means the buffer's base.
    })).toEqual({ action: 'write', text: 'the newer file, edited\n', baseText: 'the newer file\n' });
  });

  it('writes nothing when the newer buffer is already the bytes on disk', () => {
    // The pane read the file and replaced the buffer with exactly disk; the write
    // armed against the previous buffer has nothing left to say. Writing here is
    // what put the stale copy back.
    expect(planLiveWrite({
      armedText: 'the stale copy\n', armedGen: 3, currentGen: 4,
      bufferText: BASE, baseContent: BASE,
    })).toEqual({ action: 'skip', reason: 'nothing-to-write' });
  });

  it('writes nothing when there is no buffer to re-read (editor unmounted)', () => {
    expect(planLiveWrite({
      armedText: 'the stale copy\n', armedGen: 3, currentGen: 4,
      bufferText: null, baseContent: BASE,
    })).toEqual({ action: 'skip', reason: 'buffer-gone' });
  });

  it('still writes the buffer when the generation moved and no base is known', () => {
    // A restored stale draft has no trustworthy base (baseContent null). The
    // buffer is the user's text and they can still save it; the 409 path is what
    // protects the other writer, and it needs the write to be attempted.
    expect(planLiveWrite({
      armedText: 'older\n', armedGen: 1, currentGen: 2,
      bufferText: 'restored draft\n', baseContent: null,
      // No base ⇒ nothing to derive a token from. writeOnce drops it rather than
      // sending an unprovable one; the draft store still holds the text.
    })).toEqual({ action: 'write', text: 'restored draft\n', baseText: null });
  });

  it('2026-09-08: generations in step is NOT proof — the base travels with the text', () => {
    // The fifth clobber. The pane bumps its generation when it installs a LOCK,
    // but the editor is reseeded by a remount one render later. In that window the
    // generation and the lock described the freshly read 40 KB file while the
    // editor still held a three-day-old 28 KB copy out of the IndexedDB content
    // cache, so armedGen === currentGen was TRUE for stale text and this function
    // waved it through — correctly, by its own rule.
    //
    // What makes the write refusable is the base riding along: the armed text's
    // base is the stale copy, so the token derived from it cannot match disk.
    const STALE = 'the three-day-old copy\n';
    const plan = planLiveWrite({
      armedText: STALE, armedGen: 2, currentGen: 2, armedBaseText: STALE,
      bufferText: STALE, baseContent: 'the newer 40 KB file\n',
    });
    expect(plan).toEqual({ action: 'write', text: STALE, baseText: STALE });
    // And the property that actually protects the file: the token derived from that
    // base is NOT the token of the bytes on disk, so the server refuses it. Pinned
    // here rather than only in the server test, because "baseText is some string"
    // would pass while proving nothing.
    expect(plan.action === 'write' && computeContentHashClient(plan.baseText!))
      .not.toBe(computeContentHashClient('the newer 40 KB file\n'));
  });

  it('an unchanged buffer at the SAME generation is still written (it is a real edit)', () => {
    // Guard against over-eager skipping: at the same generation the armed text is
    // authoritative even if it happens to equal baseContent (an edit typed and
    // undone still clears the dirty state through the normal write path).
    expect(planLiveWrite({
      armedText: BASE, armedGen: 5, currentGen: 5, armedBaseText: BASE,
      bufferText: BASE, baseContent: BASE,
    })).toEqual({ action: 'write', text: BASE, baseText: BASE });
  });
});
