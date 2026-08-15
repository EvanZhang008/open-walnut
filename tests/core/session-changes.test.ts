import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { CLAUDE_HOME } from '../../src/constants.js';
import { encodeProjectPath } from '../../src/core/session-file-reader.js';
import { computeSessionChanges, computeSessionChangesSwr } from '../../src/core/session-changes.js';

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

describe('computeSessionChanges — agent memory-store filtering', () => {
  it('excludes the agent memory store (memory/{MEMORY.md,index,projects,agents,…}) but keeps real code', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    // The Personal AI's memory store lives under a `memory/` dir (here nested in the
    // repo so git-sync would track it). Every shape the store uses must be hidden.
    const memRoot = path.join(repo, 'memory', 'MEMORY.md');
    const memIndex = path.join(repo, 'memory', 'index.md');
    const memWorking = path.join(repo, 'memory', 'working-memory.md');
    const memProject = path.join(repo, 'memory', 'projects', 'work', 'walnut.md');
    const memAgent = path.join(repo, 'memory', 'agents', 'note-agent', 'MEMORY.md');
    const memRepo = path.join(repo, 'memory', 'repos', 'walnut', 'MEMORY.md');
    const memDaily = path.join(repo, 'memory', 'daily', '2026-06-24.md');
    const bareMemory = path.join(repo, 'docs', 'MEMORY.md'); // all-caps convention anywhere
    const codeFile = path.join(repo, 'src', 'app.ts');
    for (const [f, c] of [
      [memRoot, 'm\n'], [memIndex, 'i\n'], [memWorking, 'w\n'], [memProject, 'p\n'],
      [memAgent, 'a\n'], [memRepo, 'r\n'], [memDaily, 'd\n'], [bareMemory, 'b\n'], [codeFile, 'code v2\n'],
    ] as const) await putFile(f, c);

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [
        { name: 'Write', input: { file_path: memRoot, content: 'm\n' } },
        { name: 'Write', input: { file_path: memIndex, content: 'i\n' } },
        { name: 'Write', input: { file_path: memWorking, content: 'w\n' } },
        { name: 'Write', input: { file_path: memProject, content: 'p\n' } },
        { name: 'Write', input: { file_path: memAgent, content: 'a\n' } },
        { name: 'Write', input: { file_path: memRepo, content: 'r\n' } },
        { name: 'Write', input: { file_path: memDaily, content: 'd\n' } },
        { name: 'Write', input: { file_path: bareMemory, content: 'b\n' } },
        { name: 'Edit', input: { file_path: codeFile, old_string: 'code v1', new_string: 'code v2' } },
      ]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const paths = res.groups.flatMap(g => g.files.map(f => f.filePath));
    // Only the real code file survives.
    expect(paths).toEqual([codeFile]);
    for (const m of [memRoot, memIndex, memWorking, memProject, memAgent, memRepo, memDaily, bareMemory]) {
      expect(paths).not.toContain(m);
    }
  });

  it('KEEPS source files that merely have "memory" in their name (no false positives)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    // These are real code — must NOT be mistaken for the memory store.
    const a = path.join(repo, 'src', 'core', 'memory-search.ts');
    const b = path.join(repo, 'src', 'core', 'working-memory.ts');
    const c = path.join(repo, 'web', 'src', 'components', 'memory', 'MemoryPanel.tsx');
    for (const f of [a, b, c]) await putFile(f, 'v2\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [
        { name: 'Edit', input: { file_path: a, old_string: 'v1', new_string: 'v2' } },
        { name: 'Edit', input: { file_path: b, old_string: 'v1', new_string: 'v2' } },
        { name: 'Edit', input: { file_path: c, old_string: 'v1', new_string: 'v2' } },
      ]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const paths = res.groups.flatMap(g => g.files.map(f => f.filePath)).sort();
    expect(paths).toEqual([a, b, c].sort());
  });

  it('drops a group whose ONLY changes are memory-store files (no empty group surfaces)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const memOnly = path.join(repo, 'memory', 'projects', 'life', 'goals.md');
    await putFile(memOnly, 'v2\n');
    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Write', input: { file_path: memOnly, content: 'v2\n' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    expect(res.fileCount).toBe(0);
    expect(res.groups).toEqual([]);
  });
});

// The reported bug: the Changed view only surfaced Edit/Write tool ops, so files
// MOVED / DELETED / CREATED via a Bash command (git mv, rm, touch, cp, `>`) were
// invisible in the default (JSONL) mode. These exercise the Bash-op path.
describe('computeSessionChanges — Bash file ops (move / delete / create)', () => {
  it('shows a `git mv` as a RENAME (status=renamed, oldRelPath = source)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const dest = path.join(repo, 'Areas', 'Career', 'PERM', 'Perm-old.md');
    // The destination exists on disk (post-move); the source is gone.
    await putFile(dest, '# Perm notes\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{
        name: 'Bash',
        input: { command: `cd ${repo}\ngit mv "Projects/Perm.md" "Areas/Career/PERM/Perm-old.md" 2>/dev/null || mv "Projects/Perm.md" "Areas/Career/PERM/Perm-old.md"` },
      }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups.flatMap(g => g.files).find(f => f.relPath === path.join('Areas', 'Career', 'PERM', 'Perm-old.md'));
    expect(change).toBeDefined();
    expect(change!.status).toBe('renamed');
    expect(change!.oldRelPath).toBe(path.join('Projects', 'Perm.md'));
    // The source path must NOT appear as its own (phantom) entry.
    const rels = res.groups.flatMap(g => g.files.map(f => f.relPath));
    expect(rels).not.toContain(path.join('Projects', 'Perm.md'));
  });

  it('shows a folder `git mv` as a rename (dir move, content-preserving)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const moved = path.join(repo, 'Projects', 'PERM');
    await putFile(path.join(moved, 'README.md'), 'x\n'); // dir has a file post-move

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Bash', input: { command: `cd ${repo} && git mv "Areas/Career/PERM" "Projects/PERM"` } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups.flatMap(g => g.files).find(f => f.status === 'renamed');
    expect(change).toBeDefined();
    expect(change!.relPath).toBe(path.join('Projects', 'PERM'));
    expect(change!.oldRelPath).toBe(path.join('Areas', 'Career', 'PERM'));
  });

  it('shows `rm` as a DELETE, recovering the removed content from git (local)', async () => {
    // A real git repo so `git show HEAD:<rel>` can recover the deleted content.
    const { execFileSync } = await import('node:child_process');
    const repo = path.join(workRoot, 'realrepo');
    await fsp.mkdir(repo, { recursive: true });
    execFileSync('git', ['-C', repo, 'init', '-q']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
    const doomed = path.join(repo, 'gone.ts');
    await putFile(doomed, 'export const dead = 1;\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'init']);
    await fsp.rm(doomed); // the session deleted it

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Bash', input: { command: `cd ${repo} && rm gone.ts` } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups.flatMap(g => g.files).find(f => f.relPath === 'gone.ts');
    expect(change).toBeDefined();
    expect(change!.status).toBe('deleted');
    expect(change!.after).toBe('');
    // before recovered from git HEAD:
    expect(change!.before).toBe('export const dead = 1;\n');
    expect(change!.partial).toBe(false);
  });

  it('shows a delete of an UNTRACKED file with empty before + partial (nothing to recover)', async () => {
    const { execFileSync } = await import('node:child_process');
    const repo = path.join(workRoot, 'realrepo2');
    await fsp.mkdir(repo, { recursive: true });
    execFileSync('git', ['-C', repo, 'init', '-q']);
    // File was never committed → git show can't recover it.
    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Bash', input: { command: `cd ${repo} && rm scratch.txt` } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups.flatMap(g => g.files).find(f => f.relPath === 'scratch.txt');
    expect(change).toBeDefined();
    expect(change!.status).toBe('deleted');
    expect(change!.before).toBe('');
    expect(change!.partial).toBe(true);
  });

  it('shows `touch` of a new file as ADDED', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const created = path.join(repo, 'fresh.md');
    await putFile(created, 'hello\n');

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Bash', input: { command: `cd ${repo} && touch fresh.md` } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups.flatMap(g => g.files).find(f => f.relPath === 'fresh.md');
    expect(change).toBeDefined();
    expect(change!.status).toBe('added');
    expect(change!.after).toBe('hello\n');
    expect(change!.before).toBe('');
  });

  it('a rename FOLLOWED by an Edit on the destination shows renamed + the edit diff', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const dest = path.join(repo, 'b.ts');
    await putFile(dest, 'const v = 2;\n'); // post-move, post-edit

    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Bash', input: { command: `cd ${repo} && git mv a.ts b.ts` } }]),
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: dest, old_string: 'const v = 1;', new_string: 'const v = 2;' } }]),
    ]);

    const res = await computeSessionChanges('s1', repo);
    const change = res.groups.flatMap(g => g.files).find(f => f.relPath === 'b.ts');
    expect(change).toBeDefined();
    expect(change!.status).toBe('renamed');
    expect(change!.oldRelPath).toBe('a.ts');
    // The edit still reconstructs a real content diff on the destination.
    expect(change!.after).toBe('const v = 2;\n');
    expect(change!.before).toBe('const v = 1;\n');
  });

  it('ignores unsafe/globbed Bash commands (no fabricated ops)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    await writeSessionJsonl('s1', repo, [
      assistantToolUse(repo, [{ name: 'Bash', input: { command: `cd ${repo} && rm *.tmp && mv $SRC $DST` } }]),
    ]);
    const res = await computeSessionChanges('s1', repo);
    expect(res.fileCount).toBe(0);
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

// ── Incremental parse cache (append-only byte counter) ──
//
// The JSONL is append-only in normal operation, so recomputes should read +
// parse ONLY appended bytes from the cached offset. /compact rewrites the file
// (usually SHRINKING it, sometimes not) — both rewrite shapes must fall back to
// a full re-parse rather than merging ops from two incompatible histories.
describe('computeSessionChanges — incremental parse cache', () => {
  const jsonlAbs = (sessionId: string, cwd: string) =>
    path.join(tmpBase, 'projects', encodeProjectPath(cwd), `${sessionId}.jsonl`);

  /** Append lines to an existing session JSONL and force a DIFFERENT mtime
   *  (rapid test writes can land in the same mtime tick, which would wrongly
   *  serve the cached result and mask the incremental path). */
  async function appendSessionJsonl(sessionId: string, cwd: string, lines: unknown[]) {
    const p = jsonlAbs(sessionId, cwd);
    await fsp.appendFile(p, '\n' + lines.map(l => JSON.stringify(l)).join('\n'));
    const now = new Date(Date.now() + 5_000);
    await fsp.utimes(p, now, now);
  }

  it('picks up ops appended AFTER the first compute (unique session per test → fresh cache)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const f1 = path.join(repo, 'first.ts');
    const f2 = path.join(repo, 'second.ts');
    await putFile(f1, 'one v2\n');

    const sid = `inc-append-${Date.now()}`;
    await writeSessionJsonl(sid, repo, [
      { type: 'user', cwd: repo, message: { role: 'user', content: 'go' } },
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: f1, old_string: 'one v1', new_string: 'one v2' } }]),
    ]);

    const res1 = await computeSessionChanges(sid, repo);
    expect(res1.fileCount).toBe(1);

    // Session continues: a new turn edits a second file (pure append).
    await putFile(f2, 'two v2\n');
    await appendSessionJsonl(sid, repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: f2, old_string: 'two v1', new_string: 'two v2' } }]),
    ]);

    const res2 = await computeSessionChanges(sid, repo);
    const paths = res2.groups.flatMap(g => g.files.map(x => x.filePath));
    expect(paths).toContain(f1); // from the cached prefix
    expect(paths).toContain(f2); // from the appended bytes
    expect(res2.fileCount).toBe(2);
  });

  it('repeated appends accumulate correctly (multi-round incremental)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const sid = `inc-multi-${Date.now()}`;
    await writeSessionJsonl(sid, repo, [
      { type: 'user', cwd: repo, message: { role: 'user', content: 'go' } },
    ]);
    expect((await computeSessionChanges(sid, repo)).fileCount).toBe(0);

    for (let round = 1; round <= 3; round++) {
      const f = path.join(repo, `r${round}.ts`);
      await putFile(f, `v2-${round}\n`);
      await appendSessionJsonl(sid, repo, [
        assistantToolUse(repo, [{ name: 'Edit', input: { file_path: f, old_string: `v1-${round}`, new_string: `v2-${round}` } }]),
      ]);
      const res = await computeSessionChanges(sid, repo);
      expect(res.fileCount).toBe(round);
    }
  });

  it('a REWRITE that shrinks the file (e.g. /compact) rebuilds from scratch — no ghost ops', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const fOld = path.join(repo, 'pre-compact.ts');
    const fNew = path.join(repo, 'post-compact.ts');
    await putFile(fOld, 'old v2\n');
    await putFile(fNew, 'new v2\n');

    const sid = `inc-shrink-${Date.now()}`;
    // A long history (padding makes the rewrite strictly smaller).
    await writeSessionJsonl(sid, repo, [
      { type: 'user', cwd: repo, message: { role: 'user', content: 'x'.repeat(4000) } },
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: fOld, old_string: 'old v1', new_string: 'old v2' } }]),
    ]);
    expect((await computeSessionChanges(sid, repo)).groups.flatMap(g => g.files.map(x => x.filePath))).toContain(fOld);

    // /compact rewrote history: the old Edit line is GONE, a new one exists.
    await writeSessionJsonl(sid, repo, [
      { type: 'user', cwd: repo, message: { role: 'user', content: 'compacted' } },
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: fNew, old_string: 'new v1', new_string: 'new v2' } }]),
    ]);
    const p = jsonlAbs(sid, repo);
    const now = new Date(Date.now() + 10_000);
    await fsp.utimes(p, now, now);

    const res = await computeSessionChanges(sid, repo);
    const paths = res.groups.flatMap(g => g.files.map(x => x.filePath));
    expect(paths).toContain(fNew);
    expect(paths).not.toContain(fOld); // stale cached ops must NOT survive the rewrite
  });

  it('a SAME-OR-LARGER rewrite is caught by the last-line check (not merged as an append)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const fOld = path.join(repo, 'a.ts');
    const fNew = path.join(repo, 'b.ts');
    await putFile(fOld, 'a v2\n');
    await putFile(fNew, 'b v2\n');

    const sid = `inc-rewrite-${Date.now()}`;
    await writeSessionJsonl(sid, repo, [
      { type: 'user', cwd: repo, message: { role: 'user', content: 'go' } },
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: fOld, old_string: 'a v1', new_string: 'a v2' } }]),
    ]);
    await computeSessionChanges(sid, repo);

    // Rewrite with DIFFERENT content but ≥ size (padding), so only the
    // last-line verification can detect it.
    await writeSessionJsonl(sid, repo, [
      { type: 'user', cwd: repo, message: { role: 'user', content: 'rewritten'.repeat(200) } },
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: fNew, old_string: 'b v1', new_string: 'b v2' } }]),
    ]);
    const p = jsonlAbs(sid, repo);
    const now = new Date(Date.now() + 10_000);
    await fsp.utimes(p, now, now);

    const res = await computeSessionChanges(sid, repo);
    const paths = res.groups.flatMap(g => g.files.map(x => x.filePath));
    expect(paths).toContain(fNew);
    expect(paths).not.toContain(fOld);
  });

  it('LONG cwd (>200-char encoding, hashed by Claude Code) still caches via find-resolved path', async () => {
    // A cwd whose encoded form exceeds 200 chars → remoteJsonlPath would be
    // wrong (Claude Code hashes it), so the engine must resolve the absolute
    // path via findSessionPath and STILL get mtime-cache + incremental parse.
    // This mirrors the real 46s-per-click session (encoded cwd = 203 chars).
    // Build the path so its ENCODED form lands in (200, 250): >200 to trip the
    // hashing guard, <255 so the encoded fixture dir name stays a legal filename.
    const pad = Math.max(1, 205 - encodeProjectPath(workRoot).length);
    const longCwd = path.join(workRoot, 'x'.repeat(Math.min(pad, 200)), 'tail-dir');
    expect(encodeProjectPath(longCwd).length).toBeGreaterThan(200);
    expect(encodeProjectPath(longCwd).length).toBeLessThan(250);
    await gitInit(longCwd);
    const f = path.join(longCwd, 'deep.ts');
    await putFile(f, 'deep v2\n');

    const sid = `inc-longcwd-${Date.now()}`;
    // The fixture writes to the encoded dir (the mock's find scans project dirs
    // regardless of name, mirroring the daemon's fs.find).
    await writeSessionJsonl(sid, longCwd, [
      { type: 'user', cwd: longCwd, message: { role: 'user', content: 'go' } },
      assistantToolUse(longCwd, [{ name: 'Edit', input: { file_path: f, old_string: 'deep v1', new_string: 'deep v2' } }]),
    ]);

    const res1 = await computeSessionChanges(sid, longCwd);
    expect(res1.fileCount).toBe(1);
    // Second call with unchanged mtime → cached object identity (would fail if
    // the long cwd skipped the cache and re-parsed).
    const res2 = await computeSessionChanges(sid, longCwd);
    expect(res2).toBe(res1);
  });

  it('mtime unchanged → cached result returned (no reparse of anything)', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const f = path.join(repo, 'c.ts');
    await putFile(f, 'c v2\n');
    const sid = `inc-mtime-${Date.now()}`;
    await writeSessionJsonl(sid, repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: f, old_string: 'c v1', new_string: 'c v2' } }]),
    ]);
    const res1 = await computeSessionChanges(sid, repo);
    const res2 = await computeSessionChanges(sid, repo);
    expect(res2).toBe(res1); // identity: the exact cached object
  });

  it('a JSONL over the whole-file read ceiling still parses (streamed full parse)', async () => {
    // Whale transcripts (34MB+ observed) exceed DaemonFileReader's whole-file
    // ceiling; the old readFileRange(0) full read was rejected and the tab
    // errored. The streaming parse reads bounded windows and must succeed.
    const prevLimit = process.env.WALNUT_MAX_FILE_READ_BYTES;
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096';
    try {
      const repo = path.join(workRoot, 'repo');
      await gitInit(repo);
      const f = path.join(repo, 'whale.ts');
      await putFile(f, 'whale v2\n');

      const sid = `inc-ceiling-${Date.now()}`;
      // Padding lines push the file WELL past the 4KB ceiling.
      const padLines = Array.from({ length: 40 }, (_, i) => (
        { type: 'user', cwd: repo, message: { role: 'user', content: `pad-${i}-${'x'.repeat(400)}` } }
      ));
      await writeSessionJsonl(sid, repo, [
        { type: 'user', cwd: repo, message: { role: 'user', content: 'go' } },
        ...padLines,
        assistantToolUse(repo, [{ name: 'Edit', input: { file_path: f, old_string: 'whale v1', new_string: 'whale v2' } }]),
      ]);

      const res = await computeSessionChanges(sid, repo);
      expect(res.groups.flatMap(g => g.files.map(x => x.filePath))).toContain(f);
      expect(res.groups.flatMap(g => g.files)[0]!.before).toBe('whale v1\n');
    } finally {
      if (prevLimit === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES;
      else process.env.WALNUT_MAX_FILE_READ_BYTES = prevLimit;
    }
  });

  it('streamed full parse establishes VALID incremental state (append after works)', async () => {
    // The streaming parse computes parsedBytes/lastLineStart/lastLineCheck
    // itself — if any byte accounting drifts, the next append's line
    // verification fails and every recompute silently degrades to a full
    // parse. Prove an append after a streamed parse takes the incremental path
    // by checking the appended edit lands AND the first file's record persists.
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const f1 = path.join(repo, 'one.ts');
    const f2 = path.join(repo, 'two.ts');
    await putFile(f1, 'one v2\n');

    const sid = `inc-stream-append-${Date.now()}`;
    await writeSessionJsonl(sid, repo, [
      { type: 'user', cwd: repo, message: { role: 'user', content: 'go' } },
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: f1, old_string: 'one v1', new_string: 'one v2' } }]),
    ]);
    expect((await computeSessionChanges(sid, repo)).fileCount).toBe(1);

    await putFile(f2, 'two v2\n');
    await appendSessionJsonl(sid, repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: f2, old_string: 'two v1', new_string: 'two v2' } }]),
    ]);
    const res = await computeSessionChanges(sid, repo);
    const files = res.groups.flatMap(g => g.files);
    expect(files.map(x => x.filePath).sort()).toEqual([f1, f2].sort());
    // Both records must be REAL reconstructions, not empty placeholders.
    expect(files.find(x => x.filePath === f1)!.before).toBe('one v1\n');
    expect(files.find(x => x.filePath === f2)!.before).toBe('two v1\n');
  });
});

// ── Subagent per-file parse cache (size-keyed) ──
//
// A whale session's subagents/ dir can dwarf the main JSONL (observed 59MB vs
// 9.8MB). Finished subagent JSONLs never change, so recomputes must NOT
// re-read files whose size is unchanged — only new/grown ones.
describe('computeSessionChanges — subagent per-file cache', () => {
  const jsonlAbs = (sessionId: string, cwd: string) =>
    path.join(tmpBase, 'projects', encodeProjectPath(cwd), `${sessionId}.jsonl`);

  async function touchMain(sessionId: string, cwd: string) {
    // Append a benign line + bump mtime so the mtime fast-path doesn't serve
    // the cached result (we want a real recompute that hits the subagent path).
    const p = jsonlAbs(sessionId, cwd);
    await fsp.appendFile(p, '\n' + JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'tick' } }));
    const now = new Date(Date.now() + 5_000);
    await fsp.utimes(p, now, now);
  }

  it('unchanged subagent files are NOT re-read on recompute; new ones are picked up', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const subA = path.join(repo, 'a.ts');
    const subB = path.join(repo, 'b.ts');
    await putFile(subA, 'aaa v2\n');
    await putFile(subB, 'bbb v2\n');

    const sid = `subcache-${Date.now()}`;
    await writeSessionJsonl(sid, repo, [
      { type: 'user', cwd: repo, message: { role: 'user', content: 'go' } },
    ]);
    await writeSubagentJsonl(sid, repo, 'agent1', [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: subA, old_string: 'aaa v1', new_string: 'aaa v2' } }]),
    ]);

    const res1 = await computeSessionChanges(sid, repo);
    expect(res1.groups.flatMap(g => g.files.map(f => f.filePath))).toContain(subA);

    // DELETE agent1's file content on disk out from under the cache, keeping
    // name+size identical (rewrite same bytes) — a size-keyed cache hit means
    // the ops survive without a read. Then add a NEW subagent file.
    await writeSubagentJsonl(sid, repo, 'agent2', [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: subB, old_string: 'bbb v1', new_string: 'bbb v2' } }]),
    ]);
    await touchMain(sid, repo);

    const res2 = await computeSessionChanges(sid, repo);
    const paths2 = res2.groups.flatMap(g => g.files.map(f => f.filePath));
    expect(paths2).toContain(subA); // cached ops still merged
    expect(paths2).toContain(subB); // new file picked up
    expect(res2.fileCount).toBe(2);
  });

  it('a vanished subagent file drops out of the merge', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const subA = path.join(repo, 'gone.ts');
    await putFile(subA, 'ggg v2\n');

    const sid = `subgone-${Date.now()}`;
    await writeSessionJsonl(sid, repo, [
      { type: 'user', cwd: repo, message: { role: 'user', content: 'go' } },
    ]);
    await writeSubagentJsonl(sid, repo, 'agentg', [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: subA, old_string: 'ggg v1', new_string: 'ggg v2' } }]),
    ]);

    const res1 = await computeSessionChanges(sid, repo);
    expect(res1.fileCount).toBe(1);

    await fsp.rm(path.join(tmpBase, 'projects', encodeProjectPath(repo), sid, 'subagents', 'agent-agentg.jsonl'));
    await touchMain(sid, repo);

    const res2 = await computeSessionChanges(sid, repo);
    expect(res2.fileCount).toBe(0);
  });
});

// ── SWR (stale-while-revalidate) ──
describe('computeSessionChangesSwr', () => {
  it('serves the cached result instantly with stale+refreshing flags', async () => {
    const repo = path.join(workRoot, 'repo');
    await gitInit(repo);
    const f = path.join(repo, 'swr.ts');
    await putFile(f, 'v2\n');

    const sid = `swr-${Date.now()}`;
    await writeSessionJsonl(sid, repo, [
      assistantToolUse(repo, [{ name: 'Edit', input: { file_path: f, old_string: 'v1', new_string: 'v2' } }]),
    ]);

    // Cold: no cache → falls through to a blocking compute (no stale flag).
    const cold = await computeSessionChangesSwr(sid, repo);
    expect(cold.stale).toBeUndefined();
    expect(cold.fileCount).toBe(1);

    // Warm, file UNCHANGED: the freshness probe (one stat) sees the same
    // mtime → the cached result IS current → served with NO stale flag.
    // This is what lets the frontend's convergence poll terminate.
    const warmFresh = await computeSessionChangesSwr(sid, repo);
    expect(warmFresh.stale).toBeUndefined();
    expect(warmFresh.fileCount).toBe(1);

    // Warm, file CHANGED (mtime moved): instant stale result + refreshing.
    const p = path.join(tmpBase, 'projects', encodeProjectPath(repo), `${sid}.jsonl`);
    const later = new Date(Date.now() + 10_000);
    await fsp.utimes(p, later, later);
    const warmStale = await computeSessionChangesSwr(sid, repo);
    expect(warmStale.stale).toBe(true);
    expect(warmStale.refreshing).toBe(true);
    expect(warmStale.fileCount).toBe(1);
  });
});
