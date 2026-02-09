import crypto from 'node:crypto';

/**
 * Generate a short unique ID: base36 timestamp + 4 random chars.
 */
export function generateId(): string {
  const timePart = Date.now().toString(36);
  const randPart = crypto.randomBytes(2).toString('hex');
  return `${timePart}-${randPart}`;
}

/**
 * Priority display symbol.
 */
export function prioritySymbol(priority: string): string {
  switch (priority) {
    case 'immediate': return '!!!';
    case 'important': return '!!';
    case 'backlog': return '!';
    case 'none': return '';
    default: return '';
  }
}

/**
 * Format ISO date string to a short display form.
 */
export function shortDate(isoString: string): string {
  const d = new Date(isoString);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${min}`;
}

/**
 * Parse group and list name from a category string.
 * "Work / VPA" → { group: "Work", listName: "VPA" }
 * "personal"   → { group: "personal", listName: "personal" }
 */
export function parseGroupFromCategory(category: string): { group: string; listName: string } {
  const sep = ' / ';
  const idx = category.indexOf(sep);
  if (idx === -1) {
    return { group: titleCase(category), listName: titleCase(category) };
  }
  return {
    group: titleCase(category.slice(0, idx)),
    listName: titleCase(category.slice(idx + sep.length)),
  };
}

/** Capitalize the first letter of a string, preserving the rest. */
function titleCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Status display symbol.
 */
export function statusSymbol(status: string): string {
  switch (status) {
    case 'todo': return '○';
    case 'in_progress': return '◐';
    case 'done': return '●';
    default: return '?';
  }
}
