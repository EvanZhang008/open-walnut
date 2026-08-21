/**
 * NotesHandler — handles notes/global, notes/instructions, and notes/{name} sources.
 *
 * notes/global        → GLOBAL_NOTES_FILE (~/.open-walnut/notes/global-notes.md)
 * notes/instructions  → AGENTS.md (read) + CLAUDE.md mirror (write/edit)
 * notes/{name}        → ~/.open-walnut/notes/{name}.md
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { GLOBAL_NOTES_FILE, NOTES_DIR, NOTES_CLAUDE_FILE, NOTES_AGENTS_FILE } from '../../../constants.js';
import {
  readFileWithMeta,
  writeFileChecked,
  editFileContent,
  computeContentHash,
} from '../../../utils/file-ops.js';
import type { FileHandler, ResolvedSource, FilesReadResult, FilesWriteResult, FilesEditResult, FilesListItem } from './types.js';

export const notesHandler: FileHandler = {
  async read(resolved, opts) {
    const meta = await readFileWithMeta(resolved.filePath, opts);
    return {
      content: meta.content,
      content_hash: meta.contentHash,
      total_lines: meta.totalLines,
      showing: meta.showing,
    };
  },

  async write(resolved, content, opts) {
    const mode = opts?.mode ?? 'overwrite';

    if (mode === 'append') {
      // Append to notes: just add content at the end
      await fsp.mkdir(path.dirname(resolved.filePath), { recursive: true });
      await fsp.appendFile(resolved.filePath, content, 'utf-8');
      const updated = await fsp.readFile(resolved.filePath, 'utf-8');

      // Mirror to CLAUDE.md for instructions variant
      if (resolved.variant === 'instructions') await mirrorToClaude(updated);

      return {
        status: 'appended',
        content_hash: computeContentHash(updated),
      };
    }

    // Notes allow first-write without hash (simpler UX for new notes).
    // Memory sources always require hash (shared state, stale-write prevention).
    if (!opts?.contentHash) {
      // Allow overwrite without hash only if file doesn't exist (new note)
      try {
        await fsp.access(resolved.filePath);
        throw new Error('content_hash is required for overwrite on existing notes. Read first with file_read.');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // File doesn't exist — allow creation without hash
      }
    }

    await fsp.mkdir(path.dirname(resolved.filePath), { recursive: true });
    const result = await writeFileChecked(resolved.filePath, content, {
      expectedHash: opts?.contentHash,
    });

    // Mirror to CLAUDE.md for instructions variant
    if (resolved.variant === 'instructions') await mirrorToClaude(content);

    return { status: opts?.contentHash ? 'updated' : 'created', content_hash: result.contentHash };
  },

  async edit(resolved, oldContent, newContent, opts) {
    if (!opts?.contentHash) {
      throw new Error('content_hash is required for editing notes. Read first with file_read.');
    }
    if (!oldContent) {
      throw new Error('old_content cannot be empty.');
    }

    const result = await editFileContent(resolved.filePath, oldContent, newContent, {
      expectedHash: opts.contentHash,
      replaceAll: opts?.replaceAll,
    });

    // Mirror edit to CLAUDE.md for instructions variant (best-effort)
    if (resolved.variant === 'instructions') {
      try {
        const claudeContent = await fsp.readFile(NOTES_CLAUDE_FILE, 'utf-8');
        if (claudeContent.includes(oldContent)) {
          const updated = opts?.replaceAll
            ? claudeContent.split(oldContent).join(newContent)
            : claudeContent.replace(oldContent, newContent);
          await fsp.writeFile(NOTES_CLAUDE_FILE, updated, 'utf-8');
        } else {
          // CLAUDE.md diverged — re-sync from AGENTS.md
          const agentsContent = await fsp.readFile(resolved.filePath, 'utf-8');
          await fsp.writeFile(NOTES_CLAUDE_FILE, agentsContent, 'utf-8');
        }
      } catch {
        // Best-effort: CLAUDE.md may not exist yet
      }
    }

    return {
      status: newContent ? 'updated' : 'deleted',
      replacements: result.replacements,
      content_hash: result.contentHash,
    };
  },

  async list(resolved) {
    const items: FilesListItem[] = [];

    // Always include global notes if it exists
    try {
      const stat = fs.statSync(GLOBAL_NOTES_FILE);
      items.push({
        source: 'notes/global',
        name: 'Global Notes',
        description: 'Personal scratchpad on the home page',
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch {
      // global-notes.md doesn't exist yet
    }

    // Include instructions entry if AGENTS.md exists
    try {
      const agentsStat = fs.statSync(NOTES_AGENTS_FILE);
      items.push({
        source: 'notes/instructions',
        name: 'Instructions',
        description: 'Vault instructions for note work (dual-writes to AGENTS.md + CLAUDE.md)',
        size: agentsStat.size,
        modified: agentsStat.mtime.toISOString(),
      });
    } catch {
      // AGENTS.md doesn't exist yet
    }

    // List named notes from NOTES_DIR
    try {
      // Exclude synthetic entries: global-notes.md is "notes/global", AGENTS.md + CLAUDE.md are "notes/instructions"
      const globalBase = path.basename(GLOBAL_NOTES_FILE);
      const excluded = new Set([globalBase, 'AGENTS.md', 'CLAUDE.md']);
      const files = fs.readdirSync(NOTES_DIR)
        .filter((f) => f.endsWith('.md') && !excluded.has(f))
        .sort();
      for (const f of files) {
        const name = f.replace('.md', '');
        const stat = fs.statSync(path.join(NOTES_DIR, f));
        items.push({
          source: `notes/${name}`,
          name,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }
    } catch {
      // notes/ directory doesn't exist yet
    }

    return items;
  },
};

/**
 * Mirror content to CLAUDE.md (best-effort).
 * CLAUDE.md is the Claude Code native project instructions file, kept in sync
 * so sessions with CWD=notes/ automatically pick up instructions.
 */
async function mirrorToClaude(content: string): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(NOTES_CLAUDE_FILE), { recursive: true });
    await fsp.writeFile(NOTES_CLAUDE_FILE, content, 'utf-8');
  } catch {
    // Best-effort — AGENTS.md is the source of truth
  }
}
