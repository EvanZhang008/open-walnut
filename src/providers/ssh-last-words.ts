/**
 * What ssh said as a link died, kept short for the log: its first lines, the first line that
 * names an error, and its last lines. The tail alone lost the cause when a ProxyCommand
 * crashed with a stack trace (2026-10-31: a relay's exception was cut off, only "Broken pipe"
 * and the stack's last frames stayed).
 */
export function lastWordsExcerpt(text: string, max = 900): string {
  const t = text.trim()
  if (t.length <= max) return t
  const lines = t.split('\n')
  const head = lines.slice(0, 3).join('\n').slice(0, 300)
  const error = lines.find((l) => /\b\w*(Error|Exception)\b|ECONN|EPIPE|refused|denied/i.test(l))?.slice(0, 300) ?? ''
  const tail = t.slice(-300)
  return [head, error && !head.includes(error) && !tail.includes(error) ? error : '', '…', tail].filter(Boolean).join('\n')
}

/** How many chunks of a chunked upload go at once, each on its own connection. */
export const UPLOAD_PARALLEL = Math.max(1, Math.min(8, Number(process.env.WALNUT_UPLOAD_PARALLEL) || 3))
