import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { CLAUDE_HOME } from '../../src/constants.js';
import { encodeProjectPath } from '../../src/core/session-file-reader.js';
import { computeSessionChanges } from '../../src/core/session-changes.js';

const tmpBase = CLAUDE_HOME;
// A sandbox for the actual edited files (the "current content on disk" the engine
// reads as `after`). Distinct from CLAUDE_HOME so we control real file paths.
let workRoot: string;

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  workRoot = path.join(os.tmpdir(), `walnut-changes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(workRoot, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

// ── Helpers ──

/** Write the canonical session JSONL at Claude Code's expected path. */
async function writeSessionJsonl(sessionId: string, cwd: string, lines: unknown[]) {
  const dir = path.join(tmpBase, 'projects', encodeProjectPath(cwd));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'));
}

/** Write a subagent JSONL under the session's subagents/ dir. */
async function writeSubagentJsonl(sessionId: string, cwd: string, agentId: string, lines: unknown[]) {
  const dir = path.join(tmpBase, 'projects', encodeProjectPath(cwd), sessionId, 'subagents');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `agent-${agentId}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'));
}

/** Build an assistant line carrying one or more tool_use blocks. */
function assistantToolUse(cwd: string, blocks: Array<{ name: string; input: Record<string, unknown> }>, ts = '2025-01-01T00:00:00Z') {
  return {
    type: 'assistant',
    cwd,
    timestamp: ts,
    message: {
      id: `a-${Math.random().toString(36).slice(2)}`,
      role: 'assistant',
      content: blocks.map((b, i) => ({ type: 'tool_use', id: `t-${i}-${Math.random().toString(36).slice(2)}`, name: b.name, input: b.input })),
    },
  };
}

/** Create a real file on disk (the post-edit "current" content the engine reads). */
async function putFile(absPath: string, content: string) {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, content);
}

/** Init a fake git repo root (just the `.git` marker the engine looks for). */
async function gitInit(dir: string) {
  await fsp.mkdir(path.join(dir, '.git'), { recursive: true });
}

describe('computeSessionChanges — Edit reconstruction', () => {
  it('reconstructs before/after for a single Edit', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'src', 'a.ts');
    // Current on-disk content (after the edit).
    await putFile(file, 'const x = 2;\nconst y = 3;\n');

    await writeSessionJsonl('s1', repo, [
      { type: 'user', cwd: repo, message: { role: 'user', content: 'go' } },
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'const x = 1;', new_string: 'const x = 2;' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    expect(res.fileCount).toBe(1);
    const change = res.groups[0].files[0];
    expect(change.after).toBe('const x = 2;\nconst y = 3;\n');
    // before = after with the edit reversed: const x = 2; → const x = 1;
    expect(change.before).toBe('const x = 1;\nconst y = 3;\n');
    expect(change.status).toBe('modified');
    expect(change.partial).toBe(false);
    expect(change.relPath).toBe(path.join('src', 'a.ts'));
  });

  it('accumulates multiple Edits to the same file (first old = baseline)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'f.txt');
    // Two sequential edits: "A" → "B" → "C". Final on disk is "C".
    await putFile(file, 'C\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'A', new_string: 'B' } }]),
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'B', new_string: 'C' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups[0].files[0];
    expect(change.after).toBe('C\n');
    // Reverse newest→oldest: C→B then B→A → before is "A".
    expect(change.before).toBe('A\n');
    expect(change.ops).toBe(2);
  });

  it('handles Write as a created file (before = empty, status added)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'new.ts');
    await putFile(file, 'export const v = 1;\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Write', input: { file_path: file, content: 'export const v = 1;\n' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups[0].files[0];
    expect(change.before).toBe('');
    expect(change.after).toBe('export const v = 1;\n');
    expect(change.status).toBe('added');
  });

  it('marks partial when the recorded old_string no longer matches current content', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'f.txt');
    // Current file does NOT contain the new_string → reverse-apply can't find it.
    await putFile(file, 'totally different content\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'old line', new_string: 'new line that is absent' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups[0].files[0];
    expect(change.partial).toBe(true);
    expect(res.anyPartial).toBe(true);
  });

  it('reverses replace_all edits across all occurrences', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'f.txt');
    await putFile(file, 'NEW\nNEW\nkeep\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'OLD', new_string: 'NEW', replace_all: true } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups[0].files[0];
    expect(change.before).toBe('OLD\nOLD\nkeep\n');
  });
});

// The "granularity" questions: what shows when the SAME region is edited more
// than once, and what happens when ANOTHER process mutates the file between/after
// the session's edits. Reconstruction is string-level (matches new_string, not
// line numbers), reverse-applied newest→oldest, so: repeated edits to one region
// collapse to a single net before→after, and an outside clobber that erases a
// recorded new_string degrades that file to `partial` (flagged in the UI) rather
// than lying about a clean diff.
describe('computeSessionChanges — granularity & multi-edit-of-same-region', () => {
  it('the SAME line edited twice collapses to one net change (first old → last new), middle value gone', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'cfg.ts');
    // One line goes v1 → v2 → v3 across two edits; siblings untouched. Disk = v3.
    await putFile(file, 'const KEEP_TOP = 0;\nconst N = 3;\nconst KEEP_BOT = 9;\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'const N = 1;', new_string: 'const N = 2;' } }]),
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'const N = 2;', new_string: 'const N = 3;' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups[0].files[0];
    // before reverses BOTH edits on that one line → N = 1; the intermediate "N = 2"
    // never appears in either side (it's a net diff, not a per-edit history).
    expect(change.before).toBe('const KEEP_TOP = 0;\nconst N = 1;\nconst KEEP_BOT = 9;\n');
    expect(change.after).toBe('const KEEP_TOP = 0;\nconst N = 3;\nconst KEEP_BOT = 9;\n');
    expect(change.before).not.toContain('N = 2'); // the middle state is collapsed away
    expect(change.partial).toBe(false);
    expect(change.ops).toBe(2);
  });

  it('two DIFFERENT regions edited once each both reverse independently (multi-hunk net diff)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'two.ts');
    await putFile(file, 'top = NEW1;\nmiddle stays;\nbot = NEW2;\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'top = OLD1;', new_string: 'top = NEW1;' } }]),
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'bot = OLD2;', new_string: 'bot = NEW2;' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups[0].files[0];
    expect(change.before).toBe('top = OLD1;\nmiddle stays;\nbot = OLD2;\n');
    expect(change.after).toBe('top = NEW1;\nmiddle stays;\nbot = NEW2;\n');
    expect(change.partial).toBe(false);
  });

  it('an OUTSIDE process clobbered the edited region after the edit → that file is partial (not a false clean diff)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'race.ts');
    // The session edited `was = OLD` → `was = MINE`. But by the time we read the
    // file, another process has overwritten that very text with `was = THEIRS`,
    // so reverse-apply can't locate `was = MINE` → reconstruction is best-effort.
    await putFile(file, 'was = THEIRS;\nother = untouched;\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'was = OLD;', new_string: 'was = MINE;' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups[0].files[0];
    expect(change.partial).toBe(true);    // flagged, not silently wrong
    expect(res.anyPartial).toBe(true);
    expect(change.after).toBe('was = THEIRS;\nother = untouched;\n'); // after is always current disk
  });

  it('an outside change to a DIFFERENT region (session region intact) still reconstructs cleanly', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'coexist.ts');
    // Session changed the TOP line; an outside process changed the BOTTOM line.
    // The session's new_string is still present → its edit reverses cleanly; the
    // outside change just rides along in both before and after (not the session's).
    await putFile(file, 'top = MINE;\nbot = THEIRS;\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'top = OLD;', new_string: 'top = MINE;' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups[0].files[0];
    expect(change.partial).toBe(false);          // session region matched → clean
    expect(change.before).toBe('top = OLD;\nbot = THEIRS;\n'); // only the session's edit reversed
    expect(change.after).toBe('top = MINE;\nbot = THEIRS;\n');
  });

  it('edited then reverted to identical bytes → net no-op, dropped from the result', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'roundtrip.ts');
    // x → y → x: disk ends at the original. before === after, not partial → dropped.
    await putFile(file, 'value = x;\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'value = x;', new_string: 'value = y;' } }]),
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'value = y;', new_string: 'value = x;' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    // A clean net no-op is noise (and would desync from the git modes) → dropped.
    expect(res.fileCount).toBe(0);
    expect(res.groups).toEqual([]);
  });

  it('a later Write supersedes earlier edits: before resets to empty (created), after = current disk', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'rewritten.ts');
    await putFile(file, 'final whole-file content\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }]),
      assistantToolUse(repo, [{ name: 'Write', input: { file_path: file, content: 'final whole-file content\n' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups[0].files[0];
    // Newest→oldest: the Write resets `before` to '' (whole file replaced); the
    // earlier Edit can't change that. So it reads as a creation.
    expect(change.before).toBe('');
    expect(change.after).toBe('final whole-file content\n');
    expect(change.status).toBe('added');
  });
});

describe('computeSessionChanges — MultiEdit', () => {
  it('applies edits[] in order and reverses them', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const file = path.join(repo, 'm.txt');
    await putFile(file, 'one-X\ntwo-Y\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{
        name: 'MultiEdit',
        input: {
          file_path: file,
          edits: [
            { old_string: 'one-A', new_string: 'one-X' },
            { old_string: 'two-B', new_string: 'two-Y' },
          ],
        },
      }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups[0].files[0];
    expect(change.before).toBe('one-A\ntwo-B\n');
    expect(change.after).toBe('one-X\ntwo-Y\n');
  });
});

describe('computeSessionChanges — subagent edits', () => {
  it('includes files edited inside subagent JSONL files', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const mainFile = path.join(repo, 'main.ts');
    const subFile = path.join(repo, 'sub.ts');
    await putFile(mainFile, 'main v2\n');
    await putFile(subFile, 'sub v2\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: mainFile, old_string: 'main v1', new_string: 'main v2' } }]),
    ]);
    await writeSubagentJsonl('s1', repo, 'abc123', [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: subFile, old_string: 'sub v1', new_string: 'sub v2' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const paths = res.groups.flatMap(g => g.files.map(f => f.filePath));
    expect(paths).toContain(mainFile);
    expect(paths).toContain(subFile);
    expect(res.fileCount).toBe(2);
  });
});

describe('computeSessionChanges — repo grouping', () => {
  it('groups cwd repo, other repo, and submodule separately', async () => {
    const cwdRepo = path.join(workRoot, 'main');
    const otherRepo = path.join(workRoot, 'other');
    const submodule = path.join(cwdRepo, 'vendor', 'lib');
    await gitInit(cwdRepo);
    await gitInit(otherRepo);
    await gitInit(submodule);

    const cwdFile = path.join(cwdRepo, 'a.ts');
    const otherFile = path.join(otherRepo, 'b.ts');
    const subFile = path.join(submodule, 'c.ts');
    await putFile(cwdFile, 'a2\n');
    await putFile(otherFile, 'b2\n');
    await putFile(subFile, 'c2\n');

    await writeSessionJsonl('s1', cwdRepo, [
      assistantToolUse(cwdRepo, [
        { name: 'Edit', input: { file_path: cwdFile, old_string: 'a1', new_string: 'a2' } },
        { name: 'Edit', input: { file_path: otherFile, old_string: 'b1', new_string: 'b2' } },
        { name: 'Edit', input: { file_path: subFile, old_string: 'c1', new_string: 'c2' } },
      ]),
    ]);

    const res = await computeSessionChanges('s1', cwdRepo);
    const byKind = Object.fromEntries(res.groups.map(g => [g.kind, g]));
    expect(byKind.cwd?.repoRoot).toBe(cwdRepo);
    expect(byKind.submodule?.repoRoot).toBe(submodule);
    expect(byKind.other?.repoRoot).toBe(otherRepo);
    expect(byKind.submodule?.label).toContain('submodule');
    // cwd group ordered first.
    expect(res.groups[0].kind).toBe('cwd');
  });

  it('REGRESSION: a file edited OUTSIDE the cwd repo (no .git, not under cwd) is DROPPED (no "../" path, consistent with git modes)', async () => {
    // The session's cwd is a repo; it also wrote a scratch file somewhere ELSE on
    // disk with no git root above it and not under the cwd (e.g. /tmp). Two bugs
    // this guards: (1) the old fallback anchored such a file to the cwd repo root
    // → path.relative produced "../../../../tmp/foo"; (2) the git comparison modes
    // can't diff a non-repo file, so to keep EVERY mode showing the same set, the
    // default (JSONL) mode must drop it too — not surface it in its own group.
    const cwdRepo = path.join(workRoot, 'repo');
    await gitInit(cwdRepo);
    const inRepoFile = path.join(cwdRepo, 'src', 'a.ts');
    // A sibling dir of the repo (NOT under it, NO .git) — the "scratch outside" case.
    const outsideDir = path.join(workRoot, 'scratch-area');
    const outsideFile = path.join(outsideDir, 'e2e.py');
    await putFile(inRepoFile, 'a2\n');
    await putFile(outsideFile, 'print(2)\n');

    await writeSessionJsonl('s1', cwdRepo, [
      assistantToolUse(cwdRepo, [
        { name: 'Edit', input: { file_path: inRepoFile, old_string: 'a1', new_string: 'a2' } },
        { name: 'Write', input: { file_path: outsideFile, content: 'print(2)\n' } },
      ]),
    ]);

    const res = await computeSessionChanges('s1', cwdRepo);
    const allRel = res.groups.flatMap(g => g.files.map(f => f.relPath));
    // No relPath should escape its group with "../".
    expect(allRel.some(r => r.includes('..'))).toBe(false);
    // The orphan scratch file is dropped entirely (no group anchored outside cwd).
    expect(res.groups.find(g => g.repoRoot === outsideDir)).toBeUndefined();
    expect(allRel).not.toContain('e2e.py');
    // The in-repo file is still shown, repo-relative under the cwd group.
    const cwdGroup = res.groups.find(g => g.repoRoot === cwdRepo);
    expect(cwdGroup!.files.map(f => f.relPath)).toEqual([path.join('src', 'a.ts')]);
  });

  it('drops a CLEAN net no-op edit (before === after, not partial) but keeps real changes', async () => {
    // The session edited two files: one nets to no change (edited then reverted to
    // identical bytes — empty diff), one is a real change. The no-op must be
    // dropped (it's why the default mode listed files the git modes did not).
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const noop = path.join(repo, 'noop.ts');
    const real = path.join(repo, 'real.ts');
    // Current on-disk content matches the JSONL old_string for noop → before===after.
    await putFile(noop, 'const x = 1;\n');
    await putFile(real, 'const y = 2;\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [
        // A no-op edit: old===new, file on disk unchanged → reconstruct before===after, not partial.
        { name: 'Edit', input: { file_path: noop, old_string: 'const x = 1;', new_string: 'const x = 1;' } },
        { name: 'Edit', input: { file_path: real, old_string: 'const y = 1;', new_string: 'const y = 2;' } },
      ]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const rels = res.groups.flatMap(g => g.files.map(f => f.relPath));
    expect(rels).toContain('real.ts');
    expect(rels).not.toContain('noop.ts');
  });
});

describe('computeSessionChanges — .claude filtering', () => {
  it('excludes .claude/plans and .claude/projects but keeps other files', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const planFile = path.join(repo, '.claude', 'plans', 'plan-x.md');
    const projFile = path.join(repo, '.claude', 'projects', 'p', 'mem.md');
    const settingsFile = path.join(repo, '.claude', 'settings.json');
    const codeFile = path.join(repo, 'code.ts');
    await putFile(planFile, 'plan v2\n');
    await putFile(projFile, 'mem v2\n');
    await putFile(settingsFile, '{"v":2}\n');
    await putFile(codeFile, 'code v2\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [
        { name: 'Write', input: { file_path: planFile, content: 'plan v2\n' } },
        { name: 'Write', input: { file_path: projFile, content: 'mem v2\n' } },
        { name: 'Edit', input: { file_path: settingsFile, old_string: '{"v":1}', new_string: '{"v":2}' } },
        { name: 'Edit', input: { file_path: codeFile, old_string: 'code v1', new_string: 'code v2' } },
      ]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const paths = res.groups.flatMap(g => g.files.map(f => f.filePath));
    expect(paths).toContain(codeFile);
    expect(paths).toContain(settingsFile); // non-bookkeeping .claude file kept
    expect(paths).not.toContain(planFile);
    expect(paths).not.toContain(projFile);
  });
});

describe('computeSessionChanges — empty + identical', () => {
  it('returns empty result when the session edited nothing', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    await writeSessionJsonl('s1', repo, [
      { type: 'user', cwd: repo, message: { role: 'user', content: 'hi' } },
      assistantToolUse(repo, [{ name: 'Read', input: { file_path: path.join(repo, 'x.ts') } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    expect(res.fileCount).toBe(0);
    expect(res.groups).toEqual([]);
  });
});
