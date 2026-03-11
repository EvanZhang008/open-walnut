import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DAILY_DIR } from '../constants.js';
import { getTokenizer } from '@anthropic-ai/tokenizer';
import { computeContentHash } from '../utils/file-ops.js';
import sizeOf from 'image-size';

// ─── Singleton tokenizer ────────────────────────────────────────────
// The @anthropic-ai/tokenizer's countTokens() creates and destroys a
// Tiktoken instance (parsing 680KB of BPE ranks) on every call.
// With hundreds of calls per Context Inspector request, that's seconds
// of pure overhead. A singleton eliminates this entirely.
// Intentionally never freed — lives for process lifetime. Safe in
// Node.js single-threaded model. FinalizationRegistry handles cleanup
// if the module is ever unloaded.
let _tokenizer: ReturnType<typeof getTokenizer> | undefined;

function tokenizer(): ReturnType<typeof getTokenizer> {
  if (!_tokenizer) _tokenizer = getTokenizer();
  return _tokenizer;
}

function countTokensFast(text: string): number {
  try {
    return tokenizer().encode(text.normalize('NFKC'), 'all').length;
  } catch {
    // Fallback if WASM init fails or encode throws on pathological input
    return Math.ceil(text.length / 4);
  }
}

/**
 * Format a date as YYYY-MM-DD.
 */
export function formatDateKey(date?: Date): string {
  const d = date ?? new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Accurate token count using Anthropic's official tokenizer.
 * 100% accurate for text content sent to Claude models.
 */
export function estimateTokens(text: string): number {
  return countTokensFast(text);
}

/**
 * Estimate tokens for an image using Anthropic's formula: (width × height) / 750
 * This matches how the API actually counts image tokens (based on pixel dimensions,
 * NOT base64 size which can be 500x larger).
 */
function estimateImageTokens(imagePath: string): number {
  try {
    // Read file as buffer for sizeOf (TypeScript prefers explicit buffer over string path)
    const buffer = fs.readFileSync(imagePath);
    const dims = sizeOf(buffer);
    if (!dims.width || !dims.height) return 1400; // fallback
    return Math.ceil((dims.width * dims.height) / 750);
  } catch {
    return 1400; // fallback: 1024×1024 image
  }
}

/**
 * Structural overhead per content block type.
 * The API adds tokens for type tags, IDs, names, wrappers etc. that aren't
 * part of the raw content. Without these, estimates undercount by ~15-25%.
 * Values calibrated against Anthropic's actual token counting on representative payloads.
 */
const BLOCK_OVERHEAD = {
  text: 4,          // type tag, content wrapper
  image: 10,        // type tag, source wrapper, media_type
  tool_use: 20,     // type tag + id (~12 tokens) + name (~5 tokens) + input wrapper
  tool_result: 15,  // type tag + tool_use_id (~12 tokens) + content wrapper
  other: 8,         // conservative fallback
} as const;

/**
 * Robust token estimation that handles mixed content (text + images + tools).
 * Adds per-block structural overhead to account for type tags, IDs, names, wrappers.
 */
function estimateTokensRobust(content: unknown): number {
  if (content == null) return 0;

  if (typeof content === 'string') {
    return countTokensFast(content);
  }

  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      if (block.type === 'text') {
        total += countTokensFast(block.text || '') + BLOCK_OVERHEAD.text;
      } else if (block.type === 'image' && block.path) {
        // Path-based image: read dimensions from file
        total += estimateImageTokens(block.path) + BLOCK_OVERHEAD.image;
      } else if (block.type === 'image' && block.source?.type === 'base64') {
        // Base64 image: can't determine size accurately without decoding,
        // use a conservative estimate (assumes ~1024×1024)
        total += 1400 + BLOCK_OVERHEAD.image;
      } else if (block.type === 'tool_use') {
        total += countTokensFast(JSON.stringify(block.input || {})) + BLOCK_OVERHEAD.tool_use;
      } else if (block.type === 'tool_result') {
        if (Array.isArray(block.content)) {
          // Structured content blocks (may contain images) — recurse to handle properly
          total += estimateTokensRobust(block.content) + BLOCK_OVERHEAD.tool_result;
        } else {
          const str = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '');
          total += countTokensFast(str) + BLOCK_OVERHEAD.tool_result;
        }
      } else {
        // Unknown block types (thinking, server_tool_use, future types)
        total += countTokensFast(JSON.stringify(block)) + BLOCK_OVERHEAD.other;
      }
    }
    return total;
  }

  const serialized = JSON.stringify(content);
  return countTokensFast(serialized ?? '');
}

/**
 * Per-message structural overhead: role token, message boundary markers,
 * content array wrapper. ~4 tokens per message on average.
 */
const MESSAGE_OVERHEAD = 4;

/**
 * Estimate total tokens for an array of API messages.
 * Uses estimateTokensRobust per message — handles text, images, tool blocks.
 * Adds per-message structural overhead (role tokens, content wrappers).
 * This is the single source of truth for message-level token counting.
 */
export function estimateMessagesTokens(messages: Array<{ content: unknown }>): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokensRobust(msg.content) + MESSAGE_OVERHEAD;
  }
  return total;
}

/**
 * Estimate the full API payload: system prompt + tool schemas + messages.
 * This is the single source of truth for total token estimation.
 * Used by needsCompaction(), /api/chat/stats, Context Inspector, and agent loop logging.
 */
export function estimateFullPayload(opts: {
  system: string;
  tools: Array<{ name: string; description: string; input_schema: unknown }>;
  messages: Array<{ content: unknown }>;
}): { system: number; tools: number; messages: number; total: number } {
  const system = estimateTokens(opts.system);
  const tools = estimateTokens(JSON.stringify(opts.tools));
  const messages = estimateMessagesTokens(opts.messages);
  const total = system + tools + messages;
  return { system, tools, messages, total };
}

/**
 * Append an entry to today's daily log file.
 * Creates the file with YAML frontmatter if it doesn't exist yet.
 */
export function appendDailyLog(content: string, source?: string, projectPath?: string): void {
  fs.mkdirSync(DAILY_DIR, { recursive: true });

  const dateKey = formatDateKey();
  const filePath = path.join(DAILY_DIR, `${dateKey}.md`);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `---\nname: '${dateKey}'\ndescription: ''\n---\n\n`, 'utf-8');
  }

  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const time = `${hours}:${minutes}`;

  const sourceLabel = source ?? 'unknown';
  const projectTag = projectPath ? ` [${projectPath}]` : '';
  const entry = `## ${time} — ${sourceLabel}${projectTag}\n${content}\n\n`;

  fs.appendFileSync(filePath, entry, 'utf-8');
}

export interface DailyLogResult {
  content: string;
  contentHash: string;
}

/**
 * Read the daily log for a given date (default: today).
 * Returns content + contentHash for stale-check support.
 */
export function getDailyLog(date?: string): DailyLogResult | null {
  const dateKey = date ?? formatDateKey();
  const filePath = path.join(DAILY_DIR, `${dateKey}.md`);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content, contentHash: computeContentHash(content) };
  } catch {
    return null;
  }
}

/**
 * Resolve a date to the absolute file path of its daily log.
 */
export function resolveDailyLogPath(date?: string): string {
  const dateKey = date ?? formatDateKey();
  return path.join(DAILY_DIR, `${dateKey}.md`);
}

/**
 * Get recent daily logs, iterating backward from today.
 */
export function getRecentDailyLogs(days: number): Array<{ date: string; content: string }> {
  const results: Array<{ date: string; content: string }> = [];
  const now = new Date();

  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateKey = formatDateKey(d);
    const result = getDailyLog(dateKey);
    if (result) {
      results.push({ date: dateKey, content: result.content });
    }
  }

  return results;
}

/**
 * Split a daily log file's content into individual entries by `## ` heading boundary.
 * Returns entries in file order (oldest first), each including its heading line.
 * The file-level `# Daily Log: ...` header is included as part of the first entry.
 */
export function splitDailyLogEntries(content: string): string[] {
  if (!content.trim()) return [];

  // Split on ## headings (the entry separator used by appendDailyLog)
  const parts: string[] = [];
  const lines = content.split('\n');
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ') && current.length > 0) {
      parts.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    parts.push(current.join('\n'));
  }

  // Filter out entries that are just whitespace or only the file header with no content
  return parts.filter((p) => p.trim().length > 0);
}

/**
 * Truncate a daily log's content to fit within a token budget by keeping
 * the newest entries. Returns selected entries in chronological order
 * with an omission marker if older entries were dropped.
 *
 * Guarantee: always returns at least one entry (the newest) even if it
 * alone exceeds the budget.
 */
export function truncateDailyLogToFit(content: string, tokenBudget: number): string {
  const entries = splitDailyLogEntries(content);
  if (entries.length === 0) return '';

  // Walk entries from newest to oldest, accumulate until budget exhausted
  const selected: string[] = [];
  let tokensUsed = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entryTokens = estimateTokens(entries[i]);
    if (tokensUsed + entryTokens > tokenBudget && selected.length > 0) {
      break; // budget exhausted, but we already have at least one entry
    }
    selected.unshift(entries[i]); // prepend to maintain chronological order
    tokensUsed += entryTokens;

    // Guarantee: always include at least the newest entry
    if (i === entries.length - 1 && tokensUsed > tokenBudget) {
      break;
    }
  }

  // If we dropped older entries, prepend an omission marker
  if (selected.length < entries.length) {
    const omitted = entries.length - selected.length;
    selected.unshift(`[...${omitted} earlier entries omitted...]`);
  }

  return selected.join('\n\n');
}

/**
 * Load daily logs most-recent-first until the token budget is exhausted.
 *
 * Budget-aware: if a day's log exceeds the remaining budget and we have
 * no content yet, truncate it by entry boundary (keeping newest entries)
 * instead of returning empty. This guarantees the agent always has some
 * recent context.
 */
export function getDailyLogsWithinBudget(tokenBudget: number): string {
  const parts: string[] = [];
  let tokensUsed = 0;
  const now = new Date();

  // Search up to 90 days back
  for (let i = 0; i < 90; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateKey = formatDateKey(d);
    const result = getDailyLog(dateKey);
    if (!result) continue;

    const tokens = estimateTokens(result.content);

    // Fits within remaining budget — include fully
    if (tokensUsed + tokens <= tokenBudget) {
      parts.push(result.content);
      tokensUsed += tokens;
      continue;
    }

    // Exceeds budget but we have no logs yet — truncate by entry, include partial
    if (parts.length === 0) {
      const truncated = truncateDailyLogToFit(result.content, tokenBudget);
      if (truncated) parts.push(truncated);
      break; // stop after truncated inclusion
    }

    // Exceeds budget and we already have content — stop
    break;
  }

  return parts.join('\n---\n\n');
}

/**
 * Compact a daily log file using an LLM summarizer when it exceeds a token threshold.
 * Defense-in-depth: if Fix 1 (no compaction summaries in daily log) is working,
 * this should rarely be needed. But it provides a safety net for days with
 * exceptionally heavy activity.
 *
 * @param dateKey — YYYY-MM-DD date string
 * @param thresholdTokens — only compact if the file exceeds this token count
 * @param summarizer — async function that takes the full log content and returns a summary
 * @returns true if compaction was performed, false if skipped (under threshold or no file)
 */
export async function compactDailyLog(
  dateKey: string,
  thresholdTokens: number,
  summarizer: (content: string) => Promise<string>,
): Promise<boolean> {
  const filePath = path.join(DAILY_DIR, `${dateKey}.md`);

  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch {
    return false; // file doesn't exist
  }

  const tokens = estimateTokens(content);
  if (tokens < thresholdTokens) return false;

  // Call the summarizer
  const summary = await summarizer(content);

  // Rename original to .bak.md for safety
  const bakPath = path.join(DAILY_DIR, `${dateKey}.bak.md`);
  await fsp.rename(filePath, bakPath);

  // Write compacted version
  const compacted = `# Daily Log: ${dateKey} (compacted)\n\n${summary}\n`;
  await fsp.writeFile(filePath, compacted, 'utf-8');

  return true;
}
