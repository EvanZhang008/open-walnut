/**
 * Return on a touch keyboard inserts a newline; sending is the 44 x 44 send
 * button (spec 4.4, like iMessage). A phone has no Shift+Return, so a send on
 * Return made every multi-line message impossible to write.
 */
export function returnInsertsNewline(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
}
