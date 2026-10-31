/**
 * The words a gone working folder is reported in. A copy of
 * src/core/sessions/folder-gone-words.ts (the web build does not import server modules);
 * tests/web/folder-gone-words.test.ts keeps the two the same.
 */
export const FOLDER_GONE_RE = /working directory (no longer exists|not available)|cwd does not exist on this host/i

/** Whether an error or park reason says the session's folder is gone. */
export function isFolderGoneReason(text: unknown): boolean {
  return typeof text === 'string' && FOLDER_GONE_RE.test(text)
}

/** The folder a folder-gone reason names, when it names one. */
export function goneFolderOf(text: string | undefined): string | undefined {
  if (!text) return undefined
  const m = text.match(/(?:no longer exists(?: on [^:]+)?|does not exist on this host \([^)]*\)): (\S.*)$/i)
  return m?.[1]?.trim()
}
