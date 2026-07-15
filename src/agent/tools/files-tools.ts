/**
 * Unified file_* tool group — 6 tools for CRUDL + search on any content source.
 *
 * file_read  — read any source with optional parse
 * file_write — write/append to any source
 * file_edit  — edit by exact string replacement
 * file_list  — list contents under a source prefix
 * file_glob  — find files by glob pattern
 * file_grep  — search file contents by regex
 *
 * readFileState mechanism:
 *   file_read stores { content, mtime } for each file path read.
 *   file_edit/file_write on file sources check:
 *     1. File was read → error if not
 *     2. File mtime unchanged → error if modified since read
 *   Memory/notes/repos sources still use content_hash for safety.
 */
import fsp from 'node:fs/promises';
import type { ToolDefinition, ToolResultContent } from '../tools.js';
import {
  resolveSource,
  parseMarkdown,
  memoryHandler,
  notesHandler,
  reposHandler,
  fileHandler,
  filesGlob,
  filesGrep,
} from './files/index.js';
import type { FileHandler, FilesReadResult, GrepOptions } from './files/index.js';
import {
  StaleHashError,
  ContentNotFoundError,
  AmbiguousMatchError,
  FileTooLargeError,
} from '../../utils/file-ops.js';
import { bus, EventNames } from '../../core/event-bus.js';
import { findSimilarFile } from '../../utils/file-utils.js';
import { isBinaryByExtension } from '../../utils/binary-detect.js';
import { isBlockedDevicePath } from '../../constants/files.js';

// Canonical NOTES_UPDATED event source. The legacy agent-facing source
// 'notes/global' maps to global-notes.md, whose canonical (v2) event name is
// 'notes/global-notes' — every UI hook keys on the canonical form, and a bare
// 'notes/global' would collide with a real vault-root global.md.
function canonicalNotesSource(source: string): string {
  return source === 'notes/global' ? 'notes/global-notes' : source;
}

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ── readFileState — "Must Read Before Write/Edit" ──

interface ReadFileStateEntry {
  /** File mtime at read time (Math.floor(mtimeMs)). */
  timestamp: number;
  /** Whether the read was partial (offset/limit applied). */
  isPartialView: boolean;
}

/**
 * Tracks which files have been read and their mtime at read time.
 * Used to enforce "must read before write/edit" for file sources.
 * Keyed by absolute file path.
 */
const readFileState = new Map<string, ReadFileStateEntry>();

/** Export for testing. */
export function getReadFileState(): Map<string, ReadFileStateEntry> {
  return readFileState;
}

/**
 * Validate that a file was read before write/edit.
 * Returns error string if validation fails, undefined if OK.
 */
async function validateReadState(filePath: string): Promise<string | undefined> {
  const entry = readFileState.get(filePath);
  if (!entry) {
    return `Error: File has not been read yet. You must use file_read to read "${filePath}" before editing or writing to it.`;
  }
  if (entry.isPartialView) {
    return `Error: File was only partially read (with offset/limit). You must read the full file before editing or writing to it. Use file_read without offset/limit.`;
  }

  // Check if file has been modified since we read it
  try {
    const stat = await fsp.stat(filePath);
    const currentMtime = Math.floor(stat.mtimeMs);
    if (currentMtime > entry.timestamp) {
      return `Error: File "${filePath}" has been modified since it was last read (read at ${entry.timestamp}, now ${currentMtime}). Read it again before editing.`;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return `Error: File "${filePath}" no longer exists. It was deleted since last read.`;
    }
    // Other stat errors — don't block, let the write/edit try
  }

  return undefined;
}

/** Get the handler for a resolved source. */
function getHandler(type: string): FileHandler {
  switch (type) {
    case 'memory': return memoryHandler;
    case 'notes': return notesHandler;
    case 'repos': return reposHandler;
    case 'file': return fileHandler;
    default: throw new Error(`Unknown source type: ${type}`);
  }
}

/** Format error messages consistently. */
function formatError(err: unknown, source: string): string {
  if (err instanceof StaleHashError) {
    return `Error: ${err.message}`;
  }
  if (err instanceof ContentNotFoundError) {
    return `Error: old_content not found in "${source}". Make sure the string matches exactly (including whitespace and indentation). Use file_read first to see current content.`;
  }
  if (err instanceof AmbiguousMatchError) {
    return `Error: ${err.message}`;
  }
  if (err instanceof FileTooLargeError) {
    return `Error: ${err.message}`;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    const similar = findSimilarFile(source.startsWith('/') ? source : '');
    const suggestion = similar ? ` Did you mean "${similar}"?` : '';
    return `Error: Source not found: "${source}". File does not exist.${suggestion}`;
  }
  if (code === 'EACCES') {
    return `Error: Permission denied: "${source}".`;
  }
  if (code === 'EISDIR') {
    return `Error: Source is a directory, not a file: "${source}". Use file_list instead.`;
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

// ── file_read ──

export const filesReadTool: ToolDefinition = {
  name: 'file_read',
  description: `Read any content source. Returns line-numbered text + content_hash. Images return inline. PDFs supported.

IMPORTANT: You must read a file before editing or writing to it. The system tracks which files have been read.

Special sources (use these URIs instead of raw file paths):
  notes/global           — The Notes panel on the home page: user's personal scratchpad
                           with todos, checklists, task-refs, and links (WYSIWYG markdown).
  notes/instructions     — Vault instructions injected into all Claude Code sessions.
                           Reads AGENTS.md. Writes sync to both AGENTS.md + CLAUDE.md.
  notes/{name}           — Named note document (e.g. notes/recipes, notes/reading-list).
  memory/global          — Agent's curated knowledge & user preferences (MEMORY.md).
                           Updated by the agent as it learns across sessions.
  memory/project/{path}  — Per-project work log and accumulated context
                           (e.g. memory/project/work/api, memory/project/passion/walnut).
  memory/daily           — Today's activity log (timestamped entries from all sessions).
  memory/daily/YYYY-MM-DD — Specific day's log (e.g. memory/daily/2026-03-25).
  memory/main/global     — Main (Walnut) agent's MEMORY.md (READ-ONLY).
                           Use to check what the main agent knows.
  memory/main/daily      — Main agent's today's activity log (READ-ONLY).
  memory/main/daily/YYYY-MM-DD — Main agent's specific day's log (READ-ONLY).
  memory/repo            — List all repository environment memories.
  memory/repo/{slug}     — Environment learnings for a specific repository (build quirks,
                           conventions, structure, known issues). Auto-injected into sessions.
  repos/                 — List all registered repositories (name, description, hosts).
  repos/{name}           — Read repository details (YAML: hosts, tech stack, architecture, commands).
  /absolute/path         — Any file on disk. Images (PNG/JPEG/GIF/WebP) return inline.
                           PDFs return as document blocks. Binary files are rejected.

Default limit: 2000 lines. Use offset/limit for large files.
Set parse=true to also return structured extraction (headers, todos, task-refs, links).
For PDFs: use pages parameter (e.g. "1-5", "3", "10-20") to extract specific pages as images.`,
  input_schema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Content source URI.',
      },
      offset: {
        type: 'number',
        description: '1-based start line.',
      },
      limit: {
        type: 'number',
        description: 'Max lines to return. Default: 2000.',
      },
      pages: {
        type: 'string',
        description: 'PDF page range (e.g. "1-5", "3", "10-20"). Only for PDF files. Max 20 pages per request.',
      },
      parse: {
        type: 'boolean',
        description: 'Also return structured parse result (headers, todos, task-refs, links).',
      },
    },
    required: ['source'],
  },

  async execute(params): Promise<ToolResultContent> {
    const source = params.source as string;
    if (!source) return 'Error: source is required.';
    const agentId = params._agentId as string | undefined;

    try {
      const resolved = resolveSource(source, agentId);
      const handler = getHandler(resolved.type);
      const result = await handler.read(resolved, {
        offset: params.offset as number | undefined,
        limit: params.limit as number | undefined,
        pages: params.pages as string | undefined,
      });

      // If handler returned raw content (e.g. image blocks, PDF blocks, error strings), pass through
      if (typeof result === 'string' || Array.isArray(result)) {
        return result;
      }

      const readResult = result as FilesReadResult;

      // ── Store readFileState for file sources ──
      if (resolved.type === 'file' && readResult._mtimeMs !== undefined) {
        readFileState.set(resolved.filePath, {
          timestamp: readResult._mtimeMs,
          isPartialView: readResult._isPartialView ?? false,
        });
      }

      // Optionally parse
      if (params.parse) {
        const rawLines = readResult.content.split('\n').map((line) => {
          const tabIdx = line.indexOf('\t');
          return tabIdx >= 0 ? line.slice(tabIdx + 1) : line;
        });
        const rawContent = rawLines.join('\n');
        readResult.parsed = parseMarkdown(rawContent);
      }

      // Strip internal fields before returning to model
      const { _mtimeMs, _isPartialView, ...cleanResult } = readResult;
      return json(cleanResult);
    } catch (err) {
      return formatError(err, source);
    }
  },
};

// ── file_write ──

export const filesWriteTool: ToolDefinition = {
  name: 'file_write',
  description: `Write or append content to any source.

IMPORTANT: For file sources (/absolute/path), you MUST read the file first with file_read before writing.
           The system will reject writes to files that haven't been read. New files (that don't exist yet) are exempt.

Mode 'overwrite' replaces entire content (default). Mode 'append' adds to end.
For memory sources: append auto-prepends timestamp heading.
content_hash (from file_read) required for overwrite on memory/notes sources — prevents stale writes.
NOTE: memory/main/* sources are READ-ONLY and cannot be written to.

Sources: notes/global, notes/instructions, notes/{name}, memory/global, memory/project/{path},
memory/daily[/YYYY-MM-DD], memory/repo/{slug}, repos/{name}, /absolute/path — see file_read for full descriptions.`,
  input_schema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Content source URI.',
      },
      content: {
        type: 'string',
        description: 'The content to write or append.',
      },
      mode: {
        type: 'string',
        enum: ['overwrite', 'append'],
        description: 'Write mode. Default: overwrite.',
      },
      content_hash: {
        type: 'string',
        description: 'From file_read. Required for overwrite on memory/notes sources.',
      },
    },
    required: ['source', 'content'],
  },

  async execute(params): Promise<ToolResultContent> {
    const source = params.source as string;
    const content = params.content as string;
    if (!source) return 'Error: source is required.';
    if (content == null) return 'Error: content is required.';
    const agentId = params._agentId as string | undefined;

    try {
      const resolved = resolveSource(source, agentId);

      // ── readFileState check for file sources ──
      if (resolved.type === 'file') {
        // Check if file exists — new files are exempt from "must read first"
        let fileExists = false;
        try {
          await fsp.stat(resolved.filePath);
          fileExists = true;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }

        if (fileExists) {
          // Blocked device check
          if (isBlockedDevicePath(resolved.filePath)) {
            return `Error: "${resolved.filePath}" is a blocked device path and cannot be written.`;
          }
          // Binary check
          if (isBinaryByExtension(resolved.filePath)) {
            return `Error: "${resolved.filePath}" is a binary file and cannot be written as text.`;
          }

          const readError = await validateReadState(resolved.filePath);
          if (readError) return readError;
        }
      }

      const handler = getHandler(resolved.type);
      const result = await handler.write(resolved, content, {
        mode: (params.mode as 'overwrite' | 'append') ?? 'overwrite',
        contentHash: params.content_hash as string | undefined,
      });

      // ── Update readFileState after successful write ──
      if (resolved.type === 'file') {
        try {
          const stat = await fsp.stat(resolved.filePath);
          readFileState.set(resolved.filePath, {
            timestamp: Math.floor(stat.mtimeMs),
            isPartialView: false,
          });
        } catch {
          // Non-critical — state update failed but write succeeded
        }
      }

      // ── Notify UI when notes are modified via agent API ──
      // Scoped to web-ui only — broadcasting to '*' would hit main-agent's
      // CoalescingQueue and trigger an unnecessary AI turn.
      if (resolved.type === 'notes' && result.content_hash) {
        bus.emit(EventNames.NOTES_UPDATED, {
          source: canonicalNotesSource(source),
          contentHash: result.content_hash,
        }, ['web-ui'], { source: 'files-tools' });
      }

      return json(result);
    } catch (err) {
      return formatError(err, source);
    }
  },
};

// ── file_edit ──

export const filesEditTool: ToolDefinition = {
  name: 'file_edit',
  description: `Edit by exact string replacement in any source.

IMPORTANT: For file sources (/absolute/path), you MUST read the file first with file_read before editing.
           The system will reject edits to files that haven't been read.

content_hash (from file_read) required for memory/notes sources — prevents stale edits.

Sources: notes/global, notes/instructions, notes/{name}, memory/global, memory/project/{path},
memory/daily[/YYYY-MM-DD], memory/repo/{slug}, repos/{name}, /absolute/path — see file_read for full descriptions.`,
  input_schema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Content source URI.',
      },
      old_content: {
        type: 'string',
        description: 'Exact text to find.',
      },
      new_content: {
        type: 'string',
        description: 'Replacement text. Empty string to delete matched text.',
      },
      content_hash: {
        type: 'string',
        description: 'From file_read. Required for memory/notes sources.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences instead of requiring a unique match. Default: false.',
      },
    },
    required: ['source', 'old_content'],
  },

  async execute(params): Promise<ToolResultContent> {
    const source = params.source as string;
    const oldContent = params.old_content as string;
    const newContent = (params.new_content as string) ?? '';
    if (!source) return 'Error: source is required.';
    if (!oldContent) return 'Error: old_content is required.';
    const agentId = params._agentId as string | undefined;

    try {
      const resolved = resolveSource(source, agentId);

      // ── readFileState check for file sources ──
      if (resolved.type === 'file') {
        if (isBlockedDevicePath(resolved.filePath)) {
          return `Error: "${resolved.filePath}" is a blocked device path and cannot be edited.`;
        }
        if (isBinaryByExtension(resolved.filePath)) {
          return `Error: "${resolved.filePath}" is a binary file and cannot be edited as text.`;
        }

        const readError = await validateReadState(resolved.filePath);
        if (readError) return readError;
      }

      const handler = getHandler(resolved.type);
      const result = await handler.edit(resolved, oldContent, newContent, {
        contentHash: params.content_hash as string | undefined,
        replaceAll: (params.replace_all as boolean) ?? false,
      });

      // ── Update readFileState after successful edit ──
      if (resolved.type === 'file') {
        try {
          const stat = await fsp.stat(resolved.filePath);
          readFileState.set(resolved.filePath, {
            timestamp: Math.floor(stat.mtimeMs),
            isPartialView: false,
          });
        } catch {
          // Non-critical
        }
      }

      // ── Notify UI when notes are modified via agent API ──
      // Scoped to web-ui only — broadcasting to '*' would hit main-agent's
      // CoalescingQueue and trigger an unnecessary AI turn.
      if (resolved.type === 'notes' && result.content_hash) {
        bus.emit(EventNames.NOTES_UPDATED, {
          source: canonicalNotesSource(source),
          contentHash: result.content_hash,
        }, ['web-ui'], { source: 'files-tools' });
      }

      return json(result);
    } catch (err) {
      return formatError(err, source);
    }
  },
};

// ── file_list ──

export const filesListTool: ToolDefinition = {
  name: 'file_list',
  description: `List available content under a source prefix.
  "notes"          → all note documents (global + named notes)
  "memory/project" → all project memories with names & descriptions
  "memory/daily"   → all daily log dates (most recent first)
  "memory/repo"    → all repository environment memories
  "repos"          → all registered repositories (name, description, hosts)
  "/path/to/dir"   → directory listing of files on disk`,
  input_schema: {
    type: 'object',
    properties: {
      prefix: {
        type: 'string',
        description: 'Source prefix to list.',
      },
    },
    required: ['prefix'],
  },

  async execute(params): Promise<ToolResultContent> {
    const prefix = params.prefix as string;
    if (!prefix) return 'Error: prefix is required.';
    const agentId = params._agentId as string | undefined;

    try {
      const resolved = resolveSource(prefix, agentId);
      const handler = getHandler(resolved.type);
      const items = await handler.list(resolved);

      if (items.length === 0) {
        return `No items found under "${prefix}".`;
      }
      return json(items);
    } catch (err) {
      return formatError(err, prefix);
    }
  },
};

// ── file_glob ──

export const filesGlobTool: ToolDefinition = {
  name: 'file_glob',
  description: `Find files by glob pattern. Returns matching paths sorted by modification time (most recent first).
Pattern syntax: * matches any chars in one segment, ** matches across segments,
{a,b} matches either, [abc] matches character class.
Example: file_glob(pattern="**/*.ts", path="/project/src")`,
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern (e.g. "**/*.ts", "src/**/index.*").',
      },
      path: {
        type: 'string',
        description: 'Base directory to search in. Default: cwd.',
      },
    },
    required: ['pattern'],
  },

  async execute(params): Promise<ToolResultContent> {
    const pattern = params.pattern as string;
    if (!pattern) return 'Error: pattern is required.';

    try {
      const result = filesGlob(pattern, params.path as string | undefined);
      return json(result);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ── file_grep ──

export const filesGrepTool: ToolDefinition = {
  name: 'file_grep',
  description: `Search file contents by regex. Returns matching lines with optional context.
Output modes: "content" (lines + context), "files" (paths only, default), "count" (per-file counts).
Use glob or type to filter files. type maps common names (js, ts, py, go, rust, etc.) to extensions.`,
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for.',
      },
      path: {
        type: 'string',
        description: 'File or directory to search. Default: cwd.',
      },
      glob: {
        type: 'string',
        description: 'Glob to filter files (e.g. "*.ts", "**/*.{ts,tsx}"). Mutually exclusive with type.',
      },
      type: {
        type: 'string',
        description: 'File type filter (e.g. "js", "ts", "py", "go", "rust", "java", "c", "cpp", "css", "html", "json", "yaml", "md", "sh"). Mutually exclusive with glob.',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files', 'count'],
        description: 'Default: "files".',
      },
      context: {
        type: 'number',
        description: 'Symmetric context lines before AND after each match (-C).',
      },
      context_before: {
        type: 'number',
        description: 'Lines of context before each match (-B). Overrides context for before direction.',
      },
      context_after: {
        type: 'number',
        description: 'Lines of context after each match (-A). Overrides context for after direction.',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case insensitive matching. Default: false.',
      },
      max_results: {
        type: 'number',
        description: 'Max entries to return. Default: 50.',
      },
      offset: {
        type: 'number',
        description: 'Skip first N entries before collecting results.',
      },
      multiline: {
        type: 'boolean',
        description: 'Enable multiline mode: . matches newlines, patterns can span lines. Default: false.',
      },
    },
    required: ['pattern'],
  },

  async execute(params): Promise<ToolResultContent> {
    const pattern = params.pattern as string;
    if (!pattern) return 'Error: pattern is required.';

    try {
      const opts: GrepOptions = {
        path: params.path as string | undefined,
        glob: params.glob as string | undefined,
        type: params.type as string | undefined,
        output_mode: params.output_mode as GrepOptions['output_mode'],
        context: params.context as number | undefined,
        context_before: params.context_before as number | undefined,
        context_after: params.context_after as number | undefined,
        case_insensitive: params.case_insensitive as boolean | undefined,
        max_results: params.max_results as number | undefined,
        offset: params.offset as number | undefined,
        multiline: params.multiline as boolean | undefined,
      };
      const result = filesGrep(pattern, opts);
      return json(result);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** All file_* tools for registration. */
export const filesTools: ToolDefinition[] = [
  filesReadTool,
  filesWriteTool,
  filesEditTool,
  filesListTool,
  filesGlobTool,
  filesGrepTool,
];
