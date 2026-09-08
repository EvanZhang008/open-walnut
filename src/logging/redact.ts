/**
 * Sensitive data masking — runs BEFORE any log line is written.
 *
 * Patterns covered:
 *  - OpenAI / Anthropic API keys (sk-...)
 *  - AWS access key IDs (AKIA...)
 *  - AWS secrets & session tokens (in key=value form)
 *  - Bearer tokens
 *  - PEM private key blocks
 *  - Generic secrets after password=, secret=, token= (key=value form)
 *  - The same pairs in JSON-quoted form ("api_key":"…")
 *
 * ── Why the pair patterns are shape-constrained ──
 *
 * This masker started life on LOG LINES, where a false positive costs nothing: a
 * mangled log is still a log. It is now also applied to tool previews that a user
 * READS (`detail` / `inputPreview` / `resultPreview` in core/tool-summary.ts), and
 * there a false positive is a defect — the common case for a `Read` or a `Grep` is
 * ordinary source code and prose. Measured before the constraints below:
 * `const password = form.get('password')` came back as `const password =
 * [REDACTED]`, `## Secret: keep the design quiet` lost the word "keep",
 * `Authorization: Bearer <token>` in a markdown file lost `<token>`'s neighbours,
 * and the phrase "Bearer tokens" in this file's own header was masked.
 *
 * So the right-hand side of a pair now has to be VALUE-shaped rather than
 * "anything not a space": no internal whitespace, immediately after its separator,
 * not the head of an expression, not one ordinary word.
 *
 * ── Every tightening here can cost real coverage. Prove it did not. ──
 *
 * The first version of these constraints looked obviously safe and silently stopped
 * masking two shapes the old pattern caught: an all-uppercase bearer token (the
 * "not one word" guard carried the `i` flag, under which `[a-z]` matches `B`) and
 * `password=1234` (a plain "value ≥6 characters" floor). Both were found by running
 * a probe matrix, not by reading the regex. So when you change a pattern here, run
 * the shapes in tests/core/tool-summary-redaction.test.ts and
 * tests/logging/redact.test.ts and check the MASKED direction too — a tightening
 * that only loses true positives looks exactly like a tightening that works.
 */

const REDACTED = '[REDACTED]';

/**
 * Characters a real credential is built from: base64url plus the punctuation
 * tokens use. Deliberately excludes quotes, spaces, parens, commas and braces —
 * i.e. everything that surrounds an assignment in code.
 */
const VALUE_CHARS = 'A-Za-z0-9._~+/\\-';

/**
 * "the value does not continue, and does not open a call or an index."
 *
 * Without the `(` / `[` half, `password=form.get('x')` masks the 8 in-class chars
 * `form.get`; and because the length quantifier can backtrack, forbidding only the
 * in-class continuation is not enough on its own (the engine would settle for
 * `form.ge` and mask that). Both halves have to be in one lookahead.
 */
const VALUE_END = `(?![${VALUE_CHARS}(\\[])`;

/**
 * Expand a word so it matches in any case WITHOUT the `i` flag: `[tT][oO]…`.
 *
 * The value-shape guards below have to distinguish a lowercase letter from an
 * uppercase one, and `i` makes that impossible — under `i`, `[a-z]` matches `B`.
 * That is not hypothetical: the first version of this file's Bearer guard carried
 * `i`, so `Bearer BBBB…` (60 uppercase characters) read as "one lowercase word"
 * and shipped unmasked, a shape the pattern had always caught. Keys still have to
 * match in any case (`GITHUB_TOKEN=`, `Secret:`), hence this instead of the flag.
 */
function anyCase(word: string): string {
  return word
    .split('')
    .map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c))
    .join('');
}

/**
 * "the value is not one ordinary word."
 *
 * The only lexical signal that separates prose from a credential here is shape.
 * Two variants, because the two patterns have different evidence:
 *
 *  - Bearer: an initial letter plus up to 19 LOWERCASE letters, i.e. one written
 *    word ("Bearer authentication", "bearer credentials"). Any uppercase after the
 *    first character, any digit, any dot — all real token alphabets — fail it.
 *  - Pairs: at most 5 lowercase letters, because `password=mysecretpassword` (16
 *    lowercase letters) is a real secret this masker is tested on, while the
 *    measured false positives were short words: "## Secret: keep the design
 *    quiet" and "token: an opaque handle".
 */
const NOT_ONE_WORD = `(?![A-Za-z][a-z]{0,19}(?![${VALUE_CHARS}]))`;
const NOT_SHORT_WORD = `(?![a-z]{1,5}(?![${VALUE_CHARS}]))`;

/** Keys whose value is a credential wherever it appears. */
const SECRET_KEYS = ['password', 'secret', 'token', 'api_key', 'apikey'];
const SECRET_KEYS_ANY_CASE = SECRET_KEYS.map(anyCase).join('|');
/** Same, plus the header/OAuth names that only ever show up in a JSON bag. */
const SECRET_KEYS_JSON = [
  ...SECRET_KEYS,
  'authorization', 'auth_token', 'access_token', 'refresh_token', 'client_secret',
].join('|');

// Order matters: more specific patterns first, generic catch-alls last.
const patterns: Array<{ re: RegExp; replacement: string }> = [
  // PEM private key blocks (multiline).
  // Case-INSENSITIVE: `openssl` and several key tools emit uppercase markers, but a
  // lowercased copy (a log line normalized on the way in, a pasted key) is still a
  // key, and `-----begin rsa private key-----` used to ship its whole body.
  {
    re: /-----BEGIN\s[\w\s]*PRIVATE KEY-----[\s\S]*?-----END\s[\w\s]*PRIVATE KEY-----/gi,
    replacement: REDACTED,
  },

  // Bearer tokens: Authorization: Bearer <token>
  // The value must be credential-shaped and at least 8 chars, and must not be one
  // lowercase word — otherwise "Fix the bearer auth header parsing" reads as
  // "Fix the bearer [REDACTED] header parsing", and this file's own header comment
  // ("Bearer tokens") masks itself.
  {
    re: new RegExp(`(${anyCase('Bearer')}\\s+)(?=[${VALUE_CHARS}]{8,})${NOT_ONE_WORD}[${VALUE_CHARS}]+={0,2}${VALUE_END}`, 'g'),
    replacement: `$1${REDACTED}`,
  },

  // OpenAI / Anthropic style keys: sk-... (at least 20 chars after prefix)
  {
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED,
  },

  // AWS access key IDs: AKIA...
  {
    re: /\bAKIA[A-Z0-9]{12,}\b/g,
    replacement: REDACTED,
  },

  // AWS secret access key in key=value form
  {
    re: /(aws_secret_access_key\s*[=:]\s*)\S+/gi,
    replacement: `$1${REDACTED}`,
  },

  // AWS session token in key=value form
  {
    re: /(aws_session_token\s*[=:]\s*)\S+/gi,
    replacement: `$1${REDACTED}`,
  },

  // Credentials in URL userinfo: https://user:secret@host/...
  // Motivating shape: execSync embeds the whole command in error.message, so a
  // failed `git remote add origin https://walnut:<device-token>@host/git/data`
  // otherwise logs the cloud companion's long-lived credential verbatim.
  {
    re: /(https?:\/\/[^/\s:@]+:)[^@/\s]+@/gi,
    replacement: `$1${REDACTED}@`,
  },

  // JSON-quoted pairs: {"api_key":"…"} / { "token" : "…" }.
  // Every pattern above needs the key IMMEDIATELY followed by `=` or `:`, and a
  // JSON quote sits in between — so a serialized object slipped through all of
  // them. That is not a theoretical shape: tool inputs are objects, and
  // core/tool-summary.ts renders a non-string value with JSON.stringify, which is
  // exactly where credentials live (`{headers: {Authorization: 'Basic …'}}`).
  // `[^"]` on the value side, not VALUE_CHARS: inside quotes there is no
  // surrounding code to confuse it with, and real values there carry spaces
  // ("Basic ZGV2…") and punctuation ("p@ssw0rd").
  {
    re: new RegExp(`("(?:${SECRET_KEYS_JSON})"\\s*:\\s*")([^"]{6,})(")`, 'gi'),
    replacement: `$1${REDACTED}$3`,
  },

  // Generic secrets: password=, secret=, token=, api_key=, apikey=
  //
  // Three shape constraints, each removing a measured false positive without
  // touching a real shape (see the header comment):
  //  - NO whitespace before the separator, at most ONE space after it. Real
  //    credential syntax is `token=v`, `token: v` (YAML), `api_key: v` (this
  //    repo's own preview rendering). `password = form.get(…)` is code, and the
  //    AWS INI shape (`aws_secret_access_key = …`, spaces and all) keeps its own
  //    dedicated pattern above.
  //  - NOT_SHORT_WORD, which is what "## Secret: keep the design quiet" and
  //    "token: an opaque handle" fail. A plain length floor was tried first and is
  //    worse: at ≥6 it exempts `password=1234`, a weak secret the old pattern
  //    caught, while masking "opaque" anyway — so the shape test does the same job
  //    for prose without giving up short non-word values.
  //  - ≥4 characters, so `token: N/A` and other 1-3 char filler stay untouched.
  //  - VALUE_END, so the value cannot be the head of an expression.
  {
    re: new RegExp(
      `((?:${SECRET_KEYS_ANY_CASE})[=:] ?)${NOT_SHORT_WORD}[${VALUE_CHARS}]{4,}={0,2}${VALUE_END}`, 'g'),
    replacement: `$1${REDACTED}`,
  },
];

/**
 * Replace sensitive patterns in `text` with [REDACTED].
 * Safe to call on any string — returns the original if nothing matches.
 */
export function redactSensitiveText(text: string): string {
  let result = text;
  for (const { re, replacement } of patterns) {
    result = result.replace(re, replacement);
  }
  return result;
}
