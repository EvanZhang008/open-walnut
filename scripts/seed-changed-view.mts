/**
 * Seed an isolated Walnut home with one task + one session whose JSONL records
 * file edits across a cwd repo, a submodule, another repo, and a .claude/plans
 * file (filtered out) — so the "Changed" view has rich data to verify in the UI.
 *
 * Run with an explicit isolated home, e.g.:
 *   OPEN_WALNUT_HOME=/tmp/walnut-changed-ui node_modules/.bin/vite-node scripts/seed-changed-view.mts
 *
 * NOTE: this imports from src/ (via vite-node) so it shares the exact path
 * encoding + session-tracker the server uses. Never point it at ~/.open-walnut.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { WALNUT_HOME, CLAUDE_HOME } from '../src/constants.js';
import { createSessionRecord } from '../src/core/session-tracker.js';
import { encodeProjectPath } from '../src/core/session-file-reader.js';

const SID = 'changed-ui-demo-session';
const TASK_ID = 'changed-ui-demo-task';

async function main() {
  console.log('[seed] WALNUT_HOME =', WALNUT_HOME);
  if (WALNUT_HOME.includes('.open-walnut') && !WALNUT_HOME.includes('demo') && !WALNUT_HOME.includes('test')) {
    throw new Error(`Refusing to seed into a production-looking home: ${WALNUT_HOME}`);
  }

  // ── Real repos + files on disk (the engine reads these as `after`) ──
  const root = path.join(os.tmpdir(), 'walnut-changed-ui-repos');
  await fs.rm(root, { recursive: true, force: true });
  const cwdRepo = path.join(root, 'walnut');
  const otherRepo = path.join(root, 'other-lib');
  const submodule = path.join(cwdRepo, 'vendor', 'widget');
  for (const r of [cwdRepo, otherRepo, submodule]) await fs.mkdir(path.join(r, '.git'), { recursive: true });

  // A LONG file whose session edit touches only ONE line in the middle, so the
  // "Changed" view collapses the surrounding context (lines 1-26 above, 34-60
  // below are hidden) — this is what the expand/unfold controls reveal.
  const longLines = Array.from({ length: 60 }, (_, i) => `  const line${i + 1} = ${i + 1};`);
  const longBefore = longLines.join('\n') + '\n';
  const longAfter = longLines.map((l, i) => (i === 29 ? '  const line30 = 3000; // edited by the session' : l)).join('\n') + '\n';

  const files: Array<{ abs: string; after: string }> = [
    { abs: path.join(cwdRepo, 'src', 'long-file.ts'), after: longAfter }, // long → collapsed context to expand
    { abs: path.join(cwdRepo, 'src', 'event-types.ts'), after: 'export interface Tool {\n  name: string;\n  toolName: string; // added\n  changedFiles?: string[];\n}\n' },
    { abs: path.join(cwdRepo, 'src', 'session-changes.ts'), after: 'export const NEW = true;\nexport const KEEP = 1;\n' },
    { abs: path.join(submodule, 'index.ts'), after: 'export const widget = "v2";\nexport const shared = true;\n' },
    { abs: path.join(otherRepo, 'lib.ts'), after: 'export function helper() { return 2; }\n' },
    { abs: path.join(cwdRepo, '.claude', 'plans', 'plan-x.md'), after: '# Plan v2\n' }, // filtered out
    { abs: path.join(cwdRepo, '.claude', 'settings.json'), after: '{"version": 2}\n' }, // kept
    { abs: path.join(cwdRepo, 'docs', 'README.md'), after: '# Project\n\nA **bold** intro with a list:\n\n- one\n- two\n\n```ts\nconst x = 2;\n```\n' }, // markdown → Rendered toggle
    // Agent memory-store writes (a subagent distilling notes into MEMORY.md) — these
    // must be FILTERED OUT of the Changed view (agent scratch, not reviewable code).
    { abs: path.join(cwdRepo, 'memory', 'MEMORY.md'), after: '# Agent memory\n\n- learned something\n' }, // filtered
    { abs: path.join(cwdRepo, 'memory', 'projects', 'work', 'walnut.md'), after: '# Walnut notes\n\ndistilled\n' }, // filtered
  ];
  for (const f of files) { await fs.mkdir(path.dirname(f.abs), { recursive: true }); await fs.writeFile(f.abs, f.after); }

  // ── Session JSONL recording the edits ──
  const lines: unknown[] = [
    { type: 'user', cwd: cwdRepo, gitBranch: 'main', message: { role: 'user', content: 'make the changes' } },
    {
      type: 'assistant', cwd: cwdRepo, timestamp: '2026-06-22T10:00:00Z',
      message: {
        id: 'asst-1', role: 'assistant', model: 'global.anthropic.claude-opus-4-8[1m]',
        content: [
          { type: 'tool_use', id: 'e0', name: 'Edit', input: { file_path: files[0].abs, old_string: '  const line30 = 30;', new_string: '  const line30 = 3000; // edited by the session' } },
          { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: files[1].abs, old_string: '  name: string;\n}', new_string: '  name: string;\n  toolName: string; // added\n  changedFiles?: string[];\n}' } },
          { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: files[2].abs, content: files[2].after } },
          { type: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: files[3].abs, old_string: 'export const widget = "v1";', new_string: 'export const widget = "v2";' } },
          { type: 'tool_use', id: 'e3', name: 'Edit', input: { file_path: files[4].abs, old_string: 'return 1;', new_string: 'return 2;' } },
          { type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: files[5].abs, content: files[5].after } },
          { type: 'tool_use', id: 'e4', name: 'Edit', input: { file_path: files[6].abs, old_string: '{"version": 1}', new_string: '{"version": 2}' } },
          { type: 'tool_use', id: 'w3', name: 'Write', input: { file_path: files[7].abs, content: files[7].after } },
          { type: 'tool_use', id: 'w4', name: 'Write', input: { file_path: files[8].abs, content: files[8].after } }, // memory/MEMORY.md → filtered
          { type: 'tool_use', id: 'w5', name: 'Write', input: { file_path: files[9].abs, content: files[9].after } }, // memory/projects/... → filtered
        ],
      },
    },
  ];
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(cwdRepo));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n'));
  console.log('[seed] JSONL →', path.join(dir, `${SID}.jsonl`));

  // ── Task + session record ──
  const tasksDir = path.join(WALNUT_HOME, 'tasks');
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [{
      id: TASK_ID, title: 'Changed view demo', status: 'in_progress', priority: 'immediate',
      category: 'Work', project: 'Walnut', session_ids: [SID], active_session_ids: [SID],
      created_at: new Date('2026-06-22T09:00:00Z').toISOString(), updated_at: new Date('2026-06-22T10:00:00Z').toISOString(),
      description: '', summary: '', note: '', subtasks: [],
    }],
  }, null, 2));

  await createSessionRecord(SID, TASK_ID, 'Walnut', cwdRepo, {
    title: 'Changed view demo', mode: 'bypass', provider: 'claude-code', type: 'interactive',
  });
  console.log('[seed] session record created:', SID, '(task', TASK_ID + ')');
  console.log('[seed] DONE. cwdRepo =', cwdRepo);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
