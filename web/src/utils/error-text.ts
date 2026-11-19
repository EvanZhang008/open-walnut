/**
 * An error as one log string: its message, then its stack. Chromium's stack starts
 * with the message; WebKit's (the Mac app) is the frames alone, so logging the stack
 * by itself lost what went wrong (2026-11-18: a crash logged as "_c@main.js:49" with
 * no "Maximum update depth exceeded" anywhere).
 */
export function errorText(error: unknown): string {
  // Duck-typed: an error from another frame is no `instanceof Error` here.
  const e = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
  if (!e || typeof e !== 'object' || typeof e.message !== 'string') return String(error);
  const head = `${typeof e.name === 'string' ? e.name : 'Error'}: ${e.message}`;
  const stack = typeof e.stack === 'string' ? e.stack : '';
  if (!stack) return head;
  return e.message && stack.includes(e.message) ? stack : `${head}\n${stack}`;
}
