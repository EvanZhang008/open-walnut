import { codeRuns } from './hook-copy';

/**
 * Server or engine text with its commands, flags, paths and ids set in code
 * (C8, N22, N28), so `say` or `~/.claude/settings.json` never reads as a word
 * of the sentence around it.
 */
export function CodeText({ text }: { text: string }) {
  return <>{codeRuns(text).map((r, i) => (r.code ? <code key={i}>{r.text}</code> : r.text))}</>;
}
