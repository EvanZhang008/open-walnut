/**
 * The matching half of the public leak scan (scripts/leak-scan/README.md).
 *
 * A rule set has two kinds of rules:
 *   - `regex`: a pattern for a SHAPE (an email domain, a host naming scheme, a key format).
 *   - `terms`: exact words or phrases (internal names, account ids, a private address),
 *     stored only as salted hashes, so the rule file does not carry the words in the clear.
 *     A hash of a short word can still be confirmed by guessing, so the file stays private.
 * A term matches the way `grep -w -i` does: on word boundaries, whatever separates its
 * words in the text (`a-b`, `a_b`, `a b`, `a/b`, `a.b` all match the term `a b`). A single
 * word also matches as one part of a camelCase or letter-digit identifier (`fooClient`,
 * `foo2`), and through the escapes of JSON and JS strings (`\nfoo`, `%2Ffoo`).
 */

export const RULES_VERSION = 1
const MAX_TERM_WORDS = 6
const HEX = /^[0-9a-f]{14}$/

/** Words of a text: runs of ASCII letters and digits. */
export function words(text) {
  return text.match(/[A-Za-z0-9]+/g) ?? []
}

/** cyrb53: a fast, well-mixed 53-bit string hash (a safe integer). */
export function hashNum(s, seed = 0) {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** The same hash as a fixed-width hex string, the form a rule file stores. */
export function termHash(s, seed = 0) {
  return hashNum(s, seed).toString(16).padStart(14, '0')
}

/** The normal form a term is hashed in: its words joined by one space. */
export function termKey(term, caseSensitive) {
  const w = words(caseSensitive ? term : term.toLowerCase())
  return w.length ? w.join(' ') : null
}

/**
 * Builds a rule set from plain entries:
 *   { label, kind: 'regex' | 'regex-cs' | 'term' | 'term-cs', value, allow? }
 * `allow` (regex rules only) is a list of patterns; a hit whose surrounding text
 * matches one of them is not reported (a documented placeholder, say).
 * A label is printed with every hit, so it must name a kind of thing, never the term.
 */
export function compileRules(entries, { seed = 0 } = {}) {
  const regex = []
  const terms = []
  const labels = [] // term labels, stored once: a term carries its index (`l`), which keeps the file small
  const labelIndex = (l) => (labels.includes(l) ? labels.indexOf(l) : labels.push(l) - 1)
  for (const e of entries) {
    if (e.kind === 'regex' || e.kind === 'regex-cs') {
      // throw here, at build time, never in CI where the error could quote the pattern
      new RegExp(e.value, e.kind === 'regex' ? 'i' : '')
      for (const a of e.allow ?? []) new RegExp(a, 'i')
      regex.push({ label: e.label, source: e.value, flags: e.kind === 'regex' ? 'i' : '', allow: e.allow ?? [] })
    } else if (e.kind === 'term' || e.kind === 'term-cs') {
      const cs = e.kind === 'term-cs'
      const key = termKey(e.value, cs)
      if (!key) throw new Error(`term has no letters or digits (label ${e.label})`)
      const n = key.split(' ').length
      if (n > MAX_TERM_WORDS) throw new Error(`term longer than ${MAX_TERM_WORDS} words (label ${e.label})`)
      // `f`, the first word's hash, lets the scan skip every word no multi-word term starts with
      terms.push({ l: labelIndex(e.label), h: termHash(key, seed), n, ...(cs ? { cs: 1 } : {}), ...(n > 1 ? { f: termHash(key.split(' ')[0], seed) } : {}) })
    } else {
      throw new Error(`unknown rule kind "${e.kind}" (label ${e.label})`)
    }
  }
  return { version: RULES_VERSION, seed, regex, labels, terms }
}

/** Validates a parsed rule set and prepares it for scanning. Throws on anything malformed. */
export function loadRules(json) {
  if (!json || json.version !== RULES_VERSION || !Array.isArray(json.regex) || !Array.isArray(json.terms)) {
    throw new Error(`not a leak-scan rule set (version ${RULES_VERSION} with regex and terms lists)`)
  }
  if (json.regex.length + json.terms.length === 0) throw new Error('the rule set is empty')
  const regex = json.regex.map((r) => ({
    label: r.label,
    re: new RegExp(r.source, `g${r.flags ?? ''}`),
    allow: (r.allow ?? []).map((a) => new RegExp(a, 'i')),
  }))
  // per case mode: word count -> (hash -> label), and the first-word hashes of multi-word terms
  const modes = { i: { byLen: new Map(), firsts: new Set(), max: 0 }, s: { byLen: new Map(), firsts: new Set(), max: 0 } }
  for (const t of json.terms) {
    const n = t.n
    const label = t.label ?? json.labels?.[t.l]
    if (typeof label !== 'string' || !Number.isInteger(n) || n < 1 || n > MAX_TERM_WORDS || !HEX.test(t.h ?? '') || (n > 1 && !HEX.test(t.f ?? ''))) {
      throw new Error(`malformed term rule (label ${label})`)
    }
    const m = modes[t.cs ? 's' : 'i']
    if (!m.byLen.has(n)) m.byLen.set(n, new Map())
    m.byLen.get(n).set(parseInt(t.h, 16), label)
    if (n > 1) m.firsts.add(parseInt(t.f, 16))
    m.max = Math.max(m.max, n)
  }
  return { seed: json.seed ?? 0, regex, modes, count: json.regex.length + json.terms.length }
}

const ESCAPES = /\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|\\[nrtfvb0]|%[0-9a-fA-F]{2}/g

/** The text with string escapes blanked to spaces of the same length, so offsets stay put. */
export function unescapeForWords(text) {
  return text.includes('\\') || text.includes('%') ? text.replace(ESCAPES, (m) => ' '.repeat(m.length)) : text
}

/** camelCase and letter-digit parts of one word: `fooBarClient2` -> foo, Bar, Client, 2. */
const PARTS = /[A-Z]{2,}(?=[A-Z][a-z]|[0-9]|$)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g

/**
 * Finds every rule hit in a text. Returns [{ label, offset, length }], offsets into `text`.
 * `base` is added to every offset (for a text that is one chunk of a larger file).
 */
export function scanText(rules, text, base = 0) {
  const hits = []
  for (const r of rules.regex) {
    r.re.lastIndex = 0
    let m
    while ((m = r.re.exec(text)) !== null) {
      if (m[0].length === 0) { r.re.lastIndex++; continue }
      const around = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80)
      if (!r.allow.some((a) => a.test(around))) hits.push({ label: r.label, offset: base + m.index, length: m[0].length })
    }
  }
  const active = Object.entries(rules.modes).filter(([, md]) => md.max > 0)
  if (!active.length) return hits
  const plain = unescapeForWords(text)
  const re = /[A-Za-z0-9]+/g
  const toks = [] // flat: start, length
  let m
  while ((m = re.exec(plain)) !== null) toks.push(m.index, m[0].length)
  for (const [mode, md] of active) {
    const ones = md.byLen.get(1)
    const norm = (w) => (mode === 'i' ? w.toLowerCase() : w)
    for (let k = 0; k < toks.length; k += 2) {
      const raw = plain.substr(toks[k], toks[k + 1])
      const first = norm(raw)
      const h0 = hashNum(first, rules.seed)
      const found = [] // [label, start, end]
      const start = toks[k]
      if (ones?.has(h0)) found.push([ones.get(h0), start, start + raw.length])
      if (md.firsts.has(h0)) {
        let key = first
        for (let n = 2; n <= md.max && k + 2 * (n - 1) < toks.length; n++) {
          const j = k + 2 * (n - 1)
          key = `${key} ${norm(plain.substr(toks[j], toks[j + 1]))}`
          const label = md.byLen.get(n)?.get(hashNum(key, rules.seed))
          if (label) found.push([label, start, toks[j] + toks[j + 1]])
        }
      }
      // one part of an identifier: fooClient, foo2, HTTPFoo
      if (ones && !found.length && raw.length > 3) {
        PARTS.lastIndex = 0
        const subs = []
        let p
        while ((p = PARTS.exec(raw)) !== null) subs.push([p[0], p.index])
        if (subs.length > 1) {
          for (const [w, at] of subs) {
            const label = ones.get(hashNum(norm(w), rules.seed))
            if (label) found.push([label, start + at, start + at + w.length])
          }
        }
      }
      for (const [label, s, e] of found) {
        // a case-sensitive term is an acronym; one that ends an UPPER_SNAKE name (MAX_BARS) is a word of it
        if (mode === 's' && plain[s - 1] === '_') continue
        hits.push({ label, offset: base + s, length: e - s })
      }
    }
  }
  return hits
}

/**
 * The text of a binary file: runs of printable bytes (ASCII, tab, newlines, and whole
 * UTF-8 sequences, so non-English text stays in one run), each run on its own line. Runs of
 * `min`+ bytes are kept, as `strings -n <min>` keeps them; the default of 8 drops the short
 * runs compressed data is full of, where a 4-letter word turns up by chance. A shorter run
 * (4+) is kept only when NUL bytes stand on both sides of it: a C string, which random
 * bytes rarely make. Returns the text and a map back to byte offsets.
 */
export function printableRuns(buf, min = 8) {
  const parts = []
  const starts = []
  let start = -1
  const close = (i) => {
    const len = i - start
    const cString = len >= 4 && i < buf.length && buf[i] === 0 && start > 0 && buf[start - 1] === 0
    if (len >= min || cString) { parts.push(buf.toString('latin1', start, i)); starts.push(start) }
    start = -1
  }
  for (let i = 0; i < buf.length;) {
    const c = buf[i]
    let width = 0
    if ((c >= 0x20 && c < 0x7f) || c === 0x09 || c === 0x0a || c === 0x0d) width = 1
    else if (c >= 0xc2 && c <= 0xf4) {
      const need = c < 0xe0 ? 1 : c < 0xf0 ? 2 : 3
      let ok = i + need < buf.length
      for (let j = 1; ok && j <= need; j++) ok = (buf[i + j] & 0xc0) === 0x80
      if (ok) width = need + 1
    }
    if (width) { if (start < 0) start = i; i += width; continue }
    if (start >= 0) close(i)
    i++
  }
  if (start >= 0) close(buf.length)
  return { text: parts.join('\n'), parts, starts }
}

/** Maps an offset in printableRuns().text back to a byte offset of the file. */
export function runOffset(runs, offset) {
  let pos = 0
  for (let k = 0; k < runs.parts.length; k++) {
    const len = runs.parts[k].length
    if (offset < pos + len) return runs.starts[k] + (offset - pos)
    pos += len + 1
  }
  return -1
}
