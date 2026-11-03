/**
 * host_exec's output filter (host-exec.ts, host-mcp.ts, host-http.ts): a line that looks like a
 * credential leaves the server as a note instead (the git-sync scanner).
 */
const REDACT_BLOCK_LINES = 200
const FINDINGS_CAP = 20 // findSecretsInText stops at this many
const PEM_BEGIN_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/
const PEM_END_RE = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/

/**
 * Lines that look like a credential leave as a note; the count says how many. The
 * scanner stops at 20 findings, so the text is scanned in blocks of lines and a block
 * that hits the cap again one line at a time; a private key hides every line from its
 * BEGIN to its END (its body is plain base64 the scanner would not flag), and a window
 * that starts inside one hides up to its END. Known limit: a token split across two
 * windows inside one very long line with no newline passes as two halves; this stops
 * an accident, not a reader.
 */
export async function redact(text: string): Promise<{ text: string; redacted: number }> {
  if (!text) return { text, redacted: 0 }
  const { findSecretsInText } = await import('../../integrations/git-sync-secrets.js')
  const lines = text.split('\n')
  const hit = new Map<number, string>() // 0-based line -> kind
  for (let from = 0; from < lines.length; from += REDACT_BLOCK_LINES) {
    const block = lines.slice(from, from + REDACT_BLOCK_LINES)
    let found = findSecretsInText(block.join('\n'))
    if (found.length >= FINDINGS_CAP) {
      found = block.flatMap((l, i) => findSecretsInText(l).map((f) => ({ ...f, line: i + 1 })))
    }
    for (const f of found) if (!hit.has(from + f.line - 1)) hit.set(from + f.line - 1, f.kind)
    if (from + REDACT_BLOCK_LINES < lines.length) await new Promise<void>((r) => setImmediate(r))
  }
  for (const [i, kind] of [...hit]) {
    if (kind !== 'private-key' || PEM_END_RE.test(lines[i])) continue
    // To its END line, or (a key cut off) to the end of the output.
    for (let j = i + 1; j < lines.length && !(j === lines.length - 1 && lines[j] === ''); j++) {
      if (!hit.has(j)) hit.set(j, 'private-key')
      if (PEM_END_RE.test(lines[j])) break
    }
  }
  // A window that starts inside a key (a tail, or the next page) has its END and no BEGIN:
  // everything up to that END is the key's body.
  const firstEnd = lines.findIndex((l) => PEM_END_RE.test(l))
  if (firstEnd !== -1 && !lines.slice(0, firstEnd).some((l) => PEM_BEGIN_RE.test(l))) {
    for (let j = 0; j <= firstEnd; j++) hit.set(j, 'private-key')
  }
  if (!hit.size) return { text, redacted: 0 }
  for (const [i, kind] of hit) if (i < lines.length) lines[i] = `[Walnut hid this line: it looks like a credential (${kind})]`
  return { text: lines.join('\n'), redacted: hit.size }
}
