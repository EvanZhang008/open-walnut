/**
 * App state rendering: what a session reads about a plugin App's state.
 *
 * A plugin shares a small JSON object with the AI working on a task
 * (sessions/app-state.ts). The first time a session sees it, it reads the whole
 * object; after that only what changed since the copy it last read: one line per
 * changed value, and a line patch for a long or multi-line string (an editor
 * buffer), so typing ten characters into a 300-line file costs a few lines, not
 * the file again. Pure: no I/O, no clock, so every rule here is unit-testable.
 */

import { structuredPatch } from 'diff';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A string this long, or with a line break, is a text block: shown as a block, changed as a patch. */
const BLOCK_MIN_CHARS = 120;
/** A scalar or array rendered inline is cut here. */
const INLINE_MAX_CHARS = 300;
/** Patch lines one string may cost before its full new value is the cheaper read. */
const MAX_PATCH_LINES = 80;
/** Myers diff is synchronous: beyond this the new value is shown instead of a patch. */
const MAX_PATCH_INPUT_CHARS = 200_000;
const NESTING_INDENT = '  ';

/** `level`, `lastRun.passed`, `files["solution.py"]`: a path a model reads without guessing. */
export function pathLabel(path: string[]): string {
  let out = '';
  for (const key of path) {
    if (/^[A-Za-z_$][\w$]*$/.test(key)) out += out ? `.${key}` : key;
    else out += `[${JSON.stringify(key)}]`;
  }
  return out || '(root)';
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlock(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && (value.length >= BLOCK_MIN_CHARS || value.includes('\n'));
}

function clip(text: string, max = INLINE_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One value on one line. Strings are JSON-quoted so a number-looking string stays a string. */
export function inline(value: JsonValue | undefined): string {
  if (value === undefined) return '(none)';
  return clip(JSON.stringify(value));
}

function blockLines(text: string, indent: string): string[] {
  return text.split('\n').map((line) => `${indent}${NESTING_INDENT}${line}`);
}

/** The whole object as indented `key: value` lines; nested objects nest, text blocks indent under `|`. */
export function renderFull(state: JsonObject): string {
  const lines: string[] = [];
  const walk = (value: JsonObject, indent: string) => {
    for (const [key, child] of Object.entries(value)) {
      const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      if (isObject(child) && Object.keys(child).length > 0) {
        lines.push(`${indent}${name}:`);
        walk(child, indent + NESTING_INDENT);
      } else if (isBlock(child)) {
        lines.push(`${indent}${name}: |`);
        lines.push(...blockLines(child, indent));
      } else {
        lines.push(`${indent}${name}: ${inline(child)}`);
      }
    }
  };
  walk(state, '');
  return lines.join('\n');
}

/** Leaves of an object by path: scalars, arrays, text, and empty objects. */
function leaves(value: JsonObject, prefix: string[] = [], out = new Map<string, { path: string[]; value: JsonValue }>()) {
  for (const [key, child] of Object.entries(value)) {
    const path = [...prefix, key];
    if (isObject(child) && Object.keys(child).length > 0) leaves(child, path, out);
    else out.set(JSON.stringify(path), { path, value: child });
  }
  return out;
}

function same(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A unified-style patch of one text value, or null when showing the new value is cheaper. */
export function textPatch(before: string, after: string): string[] | null {
  if (before.length + after.length > MAX_PATCH_INPUT_CHARS) return null;
  const patch = structuredPatch('before', 'after', before, after, '', '', { context: 1 });
  const lines: string[] = [];
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) if (!line.startsWith('\\')) lines.push(line);
  }
  return lines.length > MAX_PATCH_LINES ? null : lines;
}

export interface StateChanges {
  /** The rendered lines; empty when nothing changed. */
  lines: string[];
  /** How many leaf values changed, appeared or went away. */
  count: number;
  /** The paths that changed, for the short form when the lines do not fit. */
  paths: string[];
}

/** What changed from `before` (what the session last read) to `after`, one entry per leaf. */
export function renderChanges(before: JsonObject, after: JsonObject): StateChanges {
  const was = leaves(before);
  const now = leaves(after);
  const lines: string[] = [];
  const paths: string[] = [];
  for (const [key, { path, value }] of now) {
    const old = was.get(key)?.value;
    if (was.has(key) && same(old, value)) continue;
    const label = pathLabel(path);
    paths.push(label);
    if (isBlock(value)) {
      const patch = typeof old === 'string' ? textPatch(old, value) : null;
      if (patch && patch.length > 0) {
        lines.push(`${label}: changed`);
        lines.push(...patch.map((line) => `${NESTING_INDENT}${line}`));
      } else {
        lines.push(`${label}: ${was.has(key) ? 'now' : '(new)'} |`);
        lines.push(...blockLines(value, ''));
      }
    } else if (!was.has(key)) {
      lines.push(`${label}: (new) ${inline(value)}`);
    } else {
      lines.push(`${label}: ${isBlock(old) ? '(text)' : inline(old)} → ${inline(value)}`);
    }
  }
  for (const [key, { path }] of was) {
    if (now.has(key)) continue;
    const label = pathLabel(path);
    paths.push(label);
    lines.push(`${label}: (removed)`);
  }
  return { lines, count: paths.length, paths };
}
