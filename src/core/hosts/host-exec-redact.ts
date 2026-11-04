/**
 * host_exec's output filter (host-exec.ts, host-mcp.ts, host-http.ts): a line that looks like a
 * credential leaves the server as a note instead (the git-sync scanner).
 */
const REDACT_BLOCK_LINES = 200
const FINDINGS_CAP = 20 // findSecretsInText stops at this many
const PEM_BEGIN_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/
const PEM_END_RE = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/

/**
 * A value given to a key named like a password or a token (`password=hunter2hunter2`,
 * `DB_PASS: s3cret!`, `"api_key": "..."`, `--password hunter2`): the scanner flags only values that
 * look random, so a typed password went through (2026-11-05 reviews: `password=hunter2hunter2`,
 * `aws_secret_access_key = ...`, `postgres://admin:s3cr3tP4ss@db`). What counts as a value is
 * narrow, so ordinary output stays (review 12: `invalid token: expected 3 parts`,
 * `const token = getToken(req)`, `secret: config.secret` were hidden; code review 13: every
 * `--- PASS: TestName` of `go test -v`, and `os.environ["DB_PASSWORD"]`): a quoted value (to its
 * closing quote), or a bare one that is not code (a name, `a.b`, a call or an index, open or
 * closed), a placeholder, or plain words; for a password, a bare word is one too. A password's value
 * has 3 characters or more, any other 6. A bare `pass` is a key only after `_` or `-` (`DB_PASS`,
 * `--pass`). Output only: git-sync's own scan keeps its rules.
 *
 * Linear on any line: the key word starts each try, the next try starts after that key, and a value
 * is at most 256 characters (review 12: a lazy key prefix made a line of 100 000 `-` after `token`
 * take 30 s on the server's loop; code review 13: an unbounded value made `apikey:x` repeated over
 * 240 KB take 18 s).
 */
const FIELD_HINTS = ['pass', 'secret', 'token', 'key']
const KEY_SRC = '(password|passwd|passphrase|(?<=[_-])pass\\b|secret|token|(?:api|access|secret|private)[_-]?key)'
const VALUE_SRC = '(?:(["\'])([^"\'\\r\\n]{1,256})|([^\\s"\',;]{1,256}))'
const FIELD_RE = new RegExp(`${KEY_SRC}["']?[ \\t]{0,8}[:=][ \\t]{0,8}${VALUE_SRC}`, 'gi')
/** A command-line flag and its value: `--password hunter2`, `--token "abc def"`. */
const FLAG_RE = new RegExp(`(?:^|[\\s'"])--(password|passwd|pass|token|secret|(?:api|access)[_-]?key)[ \\t]{1,8}${VALUE_SRC}`, 'gi')
/** A flag's placeholder in help text (`--password PASSWORD`, `--token TOKEN_VALUE`) or the next flag. */
const METAVAR_RE = /^(?:[A-Z][A-Z0-9_]*|-.*)$/
const PLACEHOLDER_RE = /^(?:null|none|nil|true|false|undefined|required|optional|string|\*+|x+)$|^[$%<{[]|^\*{3}/i
/** Code, not a value: a name chain with an optional call or index, open or closed, and an optional `!` (`process.env.API_KEY!`, `getToken(req)`, `os.environ[`, `jwt.encode(payload`). */
const CODE_RE = /^[A-Za-z_$][\w$]*(?:(?:\.|\?\.)[A-Za-z_$][\w$]*)*(?:[([].*)?[!?]?$/
/** Plain words, alone or joined by `-`, `_`, `/`, `.` or `:` (`expired`, `default-namespace/my-app`, `API_KEY`), or a camelCase name (`myToken`, not `aBcDeFgH`). */
const WORDS_RE = /^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)(?:[-_/.:](?:[a-z]+|[A-Z][a-z]+|[A-Z]+))*[!.]?$|^[a-z]+(?:[A-Z][a-z]{2,})+$/
/** A password in a URL (`postgres://admin:s3cr3t@db`), however short: the scanner wants 16 characters. */
const URL_PASSWORD_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:/@]{1,64}:([^\s@/]{3,})@[A-Za-z0-9.-]/gi
const URL_PLACEHOLDER_RE = /^(?:password|passwd|pass|secret|\*+|x+)$|^[$%<{]/i

/** Whether `value`, given to `key` (`quoted` or bare), is a credential's value. */
function fieldValue(key: string, quoted: boolean, raw: string): boolean {
  // `(hunter2)`: the parentheses are not the value; `(none)` is a placeholder still. A value cut at
  // 256 characters may end on a separator, which plain words never do.
  const whole = raw.length >= 256 ? raw.replace(/[-_/.:]+$/, '') : raw
  const value = /^\(.*\)$/.test(whole) ? whole.slice(1, -1) : whole
  const password = /^pass/i.test(key)
  if (value.trim().length < (password ? 3 : 6) || PLACEHOLDER_RE.test(value)) return false
  // A count (`input_token: 4096`), never a password's digits.
  if (/^\d+$/.test(value)) return password
  if (quoted) return true
  if (/[.([]/.test(value) && CODE_RE.test(value)) return false
  return password || !WORDS_RE.test(value)
}

function fieldSecret(line: string): boolean {
  const lower = line.toLowerCase()
  if (FIELD_HINTS.some((w) => lower.includes(w))) {
    FIELD_RE.lastIndex = 0
    for (let m = FIELD_RE.exec(line); m; m = FIELD_RE.exec(line)) {
      if (fieldValue(m[1]!, m[2] !== undefined, m[3] ?? m[4]!)) return true
      // On after the key, not after the value: a value cut at 256 may hold the next key.
      FIELD_RE.lastIndex = m.index + m[1]!.length
    }
    if (lower.includes('--')) {
      FLAG_RE.lastIndex = 0
      for (let m = FLAG_RE.exec(line); m; m = FLAG_RE.exec(line)) {
        const value = m[3] ?? m[4]!
        if (!(m[2] === undefined && METAVAR_RE.test(value)) && fieldValue(m[1]!, m[2] !== undefined, value)) return true
        FLAG_RE.lastIndex = m.index + 2 + m[1]!.length
      }
    }
  }
  if (lower.includes('://')) {
    URL_PASSWORD_RE.lastIndex = 0
    for (let m = URL_PASSWORD_RE.exec(line); m; m = URL_PASSWORD_RE.exec(line)) if (!URL_PLACEHOLDER_RE.test(m[1]!)) return true
  }
  return false
}

/**
 * Lines that look like a credential leave as a note; the count says how many. The
 * scanner stops at 20 findings, so the text is scanned in blocks of lines and a block
 * that hits the cap again one line at a time; a private key hides every line from its
 * BEGIN to its END (its body is plain base64 the scanner would not flag), and a window
 * that starts inside one hides up to its END. Known limit: a token split across two
 * windows inside one very long line with no newline passes as two halves; this stops
 * an accident, not a reader.
 */
export async function redact(text: string): Promise<{ text: string; redacted: number; keyToEnd?: true }> {
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
    block.forEach((l, i) => { if (!hit.has(from + i) && fieldSecret(l)) hit.set(from + i, 'password-field') })
    if (from + REDACT_BLOCK_LINES < lines.length) await new Promise<void>((r) => setImmediate(r))
  }
  let keyToEnd = false
  for (const [i, kind] of [...hit]) {
    if (kind !== 'private-key' || PEM_END_RE.test(lines[i])) continue
    // To its END line, or (a key cut off) to the end of the output, which the answer says.
    let ended = false
    for (let j = i + 1; j < lines.length && !(j === lines.length - 1 && lines[j] === ''); j++) {
      if (!hit.has(j)) hit.set(j, 'private-key')
      if (PEM_END_RE.test(lines[j])) { ended = true; break }
    }
    if (!ended && PEM_BEGIN_RE.test(lines[i])) keyToEnd = true
  }
  // A window that starts inside a key (a tail, or the next page) has its END and no BEGIN:
  // everything up to that END is the key's body.
  const firstEnd = lines.findIndex((l) => PEM_END_RE.test(l))
  if (firstEnd !== -1 && !lines.slice(0, firstEnd).some((l) => PEM_BEGIN_RE.test(l))) {
    for (let j = 0; j <= firstEnd; j++) hit.set(j, 'private-key')
  }
  if (!hit.size) return { text, redacted: 0 }
  for (const [i, kind] of hit) if (i < lines.length) lines[i] = `[Walnut hid this line: it looks like a credential (${kind})]`
  return { text: lines.join('\n'), redacted: hit.size, ...(keyToEnd ? { keyToEnd: true as const } : {}) }
}
