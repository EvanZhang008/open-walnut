/**
 * Threat-pattern table for the memory safety screen (see memory-safety.ts for
 * the threat model, the two enforcement points, and the fail-open contract).
 *
 * Split out from the enforcement layer for the same reason hermes-agent keeps
 * `threat_patterns.py` separate from `memory_tool.py`: the pattern list is the
 * part that gets tuned, reviewed, and argued about, and it should be readable
 * without the plumbing around it.
 *
 * PATTERN PHILOSOPHY — read this before adding one
 * ------------------------------------------------
 * The corpus this runs against is FULL of legitimate imperative text: "NEVER
 * force-kill a coding CLI process", "Never tell the user to git push as a deploy
 * step", "always start a session right away". A pattern keyed on imperative mood
 * would break the product, so every pattern here must anchor on one of:
 *
 *  1. THE AGENT'S CONTROL PLANE — its own instructions, its system prompt, the
 *     operator's rules. Generic directive nouns ("rules", "instructions") only
 *     count when qualified by a conversation-scope word (SCOPE below).
 *  2. EXFIL MECHANICS — a sensitive object AND an outbound sink in the SAME
 *     sentence. Either alone is ordinary text in a developer-tools product.
 *  3. CONCEALMENT WITH A REFLEXIVE OBJECT — hiding the action itself ("about
 *     this", "that you ..."), not hiding some fact about the user's work.
 *  4. AN UNAMBIGUOUS SECRET SHAPE — 20+ opaque chars or a known vendor prefix.
 *
 * NEVER anchor on bossy English ("you must", "always", "never"), and never on a
 * bare noun that appears in normal ops writing (`~/.ssh`, `CLAUDE.md`, "webhook",
 * "debug mode"). Those belong in the `flag` tier at most.
 *
 * Two severities: `block` stops a write / quarantines an injected entry;
 * `flag` only ever logs. When unsure, ship it as `flag` and look at the logs.
 *
 * BILINGUAL: the Chinese half of the table lives in
 * `memory-safety-patterns-cjk.ts` (same discipline, corpus-measured separately)
 * and is concatenated into THREAT_PATTERNS below. Pattern ids are shared
 * deliberately — an override attempt is `override_instructions` in either
 * language, so downstream logging, quarantine markers and tests stay
 * language-agnostic.
 */
import {
  CJK_THREAT_PATTERNS,
  CJK_NEGATION_SOURCE,
  CJK_CLAUSE_BOUNDARY_CHARS,
  foldFullwidthAlnum,
} from './memory-safety-patterns-cjk.js';

// ── Normalization ──

/**
 * Zero-width and word-joiner characters — used to split a keyword ("ig<ZWSP>nore")
 * so it slips past a regex while still reading normally to the model. STRIPPED
 * before matching rather than blocked: blocking them would false-positive on
 * emoji ZWJ sequences and on Persian/Hindi text.
 * Written as escapes on purpose — literal invisibles in source are unreviewable,
 * and a stray NUL makes git classify the file as binary.
 */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\u2062\u2063\u2064\uFEFF]/g;

/**
 * Bidi embeddings / overrides / isolates. Unlike zero-width characters these have
 * no legitimate use inside a short behavior rule, and they can visually reverse
 * text so a human reviewing the entry sees something different from what the
 * model receives. BLOCKED (as `bidi_override`), not stripped.
 */
export const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/;

/** Exotic spaces folded to a plain space so `\s`-based gaps still match. */
const ODD_SPACE_RE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Fold bypass characters so the patterns below see canonical text.
 * Fullwidth letters/digits fold to ASCII too (see foldFullwidthAlnum) so a
 * fullwidth-typed English payload cannot evade the English table. Fullwidth
 * PUNCTUATION is left alone on purpose — folding it would change the negation
 * guard's clause boundaries for English text.
 */
export function normalizeForScreening(text: string): string {
  return foldFullwidthAlnum(text.replace(ZERO_WIDTH_RE, '').replace(ODD_SPACE_RE, ' '));
}

// ── Regex building blocks ──

/** Up to `n` filler tokens between two anchors (blocks the "insert a word" bypass). */
const gap = (n: number) => `(?:\\s+\\S+){0,${n}}\\s+`;

/**
 * One character that does NOT end a sentence. `.`/`!`/`?` only terminate when
 * followed by whitespace or end-of-input, so dots inside `example.test`,
 * `~/.ssh/config` and `.env` do not truncate the window.
 */
const SENT = '(?:[^.!?\\n]|[.!?](?![\\s]|$))';
/** `SENT` repeated lazily up to `n` chars — a sentence-scoped filler run. */
const within = (n: number) => `${SENT}{0,${n}}?`;

/** Conversation-scope qualifiers that turn a generic noun into a control-plane noun. */
const SCOPE =
  '(?:previous|prior|preceding|earlier|above|foregoing|original|initial|system|operator|developer|your)';
const DIRECTIVE = '(?:instructions?|prompts?|directives?|guidelines?|rules?|constraints?|policy|policies)';
const PRINCIPAL = '(?:user|operator|human|owner)';

export type MemorySafetySeverity = 'block' | 'flag';

export interface ThreatPattern {
  id: string;
  severity: MemorySafetySeverity;
  re: RegExp;
  /**
   * When true, a match governed by an earlier negation in the SAME clause is
   * ignored — this is what keeps "Never ignore your previous instructions" and
   * "Never hide errors from the user" clean. Set it on any pattern whose
   * payload phrasing a legitimate rule might quote in order to forbid it.
   */
  negatable?: boolean;
}

/** The English half. Concatenated with the CJK half into THREAT_PATTERNS below. */
const EN_THREAT_PATTERNS: ThreatPattern[] = [
  // ── Instruction override ──────────────────────────────────────────────
  {
    id: 'override_instructions',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      // "ignore all previous instructions" — scope word before the directive noun
      `\\b(?:ignore|disregard|forget|discard|override|bypass|nullify|abandon)\\b${gap(4)}\\b${SCOPE}\\b${gap(2)}\\b${DIRECTIVE}\\b` +
        // "...the guidelines above" — directive noun before the scope word
        `|\\b(?:ignore|disregard|forget|discard|override|bypass|nullify)\\b${gap(3)}\\b${DIRECTIVE}\\b${gap(2)}\\b(?:above|before|previously|earlier)\\b` +
        // "forget everything you were told earlier"
        `|\\b(?:ignore|disregard|forget)\\s+(?:everything|anything|all)\\b${gap(3)}\\b(?:above|before|previously|earlier|told|instructed)\\b`,
      'i',
    ),
  },
  {
    id: 'precedence_over_operator',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      `\\b(?:overrides?|supersedes?|outranks?|takes?\\s+precedence\\s+over|has\\s+priority\\s+over)\\b${gap(3)}\\b(?:the\\s+|your\\s+)?(?:operator|system|developer)(?:'s|s')?\\s+${DIRECTIVE}\\b` +
        `|\\bthese?\\s+${DIRECTIVE}\\s+(?:take|takes|have|has)\\s+(?:precedence|priority)\\b`,
      'i',
    ),
  },
  {
    id: 'leak_system_prompt',
    severity: 'block',
    negatable: true,
    // Verbatim-dump verbs only. "The context inspector can show the system
    // prompt" is a legitimate memory entry and must stay clean.
    re: new RegExp(
      `\\b(?:reveal|disclose|leak|exfiltrate)\\b${gap(3)}\\b(?:system\\s+(?:prompt|message|instructions))\\b` +
        `|\\b(?:output|print|repeat|echo|dump|reproduce|recite)\\b${gap(3)}\\b(?:system\\s+(?:prompt|message|instructions)|initial\\s+instructions)\\b`,
      'i',
    ),
  },
  {
    id: 'role_hijack',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      `\\byou\\s+are\\s+now\\s+(?:a|an|the)\\b` +
        `|\\b(?:from\\s+now\\s+on|henceforth|going\\s+forward)\\b${gap(2)}\\byou\\s+are\\s+(?:a|an|the|no\\s+longer)\\b` +
        `|\\bpretend\\s+(?:that\\s+)?(?:you\\s+are|to\\s+be)\\b` +
        `|\\byour\\s+(?:real|true|actual)\\s+(?:name|identity|purpose)\\s+is\\b`,
      'i',
    ),
  },
  {
    id: 'unrestricted_mode',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      `\\bact\\s+as\\s+(?:if|though)\\b${gap(4)}\\b(?:no|without)\\b${gap(2)}\\b(?:restrictions?|limits?|rules?|guidelines?|filters?)\\b` +
        `|\\b(?:respond|reply|answer|behave|operate)\\s+without\\s+(?:any\\s+)?(?:restrictions?|limitations?|filters?|safety|guardrails)\\b` +
        // "debug mode" deliberately excluded — a real, frequently-stated product fact.
        `|\\b(?:developer|god|jailbreak|unrestricted|DAN)\\s+mode\\s+(?:is\\s+)?(?:on|enabled|activated)\\b`,
      'i',
    ),
  },
  {
    id: 'spoofed_authority',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      `\\b(?:this\\s+(?:is|message\\s+is)|the\\s+following\\s+is)\\b${gap(3)}\\b(?:from|by)\\s+(?:the\\s+|your\\s+)?(?:system|developer|operator|administrator|model\\s+provider)\\b` +
        `|\\byou\\s+have\\s+been\\s+(?:updated|upgraded|patched|reconfigured)\\s+to\\b`,
      'i',
    ),
  },

  // ── Concealment / covert channel ──────────────────────────────────────
  // A reflexive continuation is REQUIRED: an attacker conceals the attack
  // ("about this", "that you ..."), while legitimate rules concern the user's
  // work ("never tell the user a task is done while a test is red").
  {
    id: 'conceal_from_user',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      `\\b(?:do\\s+not|don'?t|never|avoid|refrain\\s+from)\\b${gap(3)}\\b(?:tell|telling|inform|informing|notify|notifying|alert|alerting)\\b${gap(2)}\\b(?:the\\s+)?${PRINCIPAL}\\b\\s+(?:(?:about|regarding|of)\\s+(?:this|that|it|any|the\\b)|that\\s+you\\b|what\\s+you\\b|anything\\b)` +
        `|\\b(?:do\\s+not|don'?t|never|avoid)\\b${gap(3)}\\bmention\\b${gap(4)}\\bto\\s+(?:the\\s+)?${PRINCIPAL}\\b` +
        `|\\b(?:hide|conceal|withhold|suppress|obscure)\\b${within(60)}\\bfrom\\s+(?:the\\s+)?${PRINCIPAL}\\b` +
        `|\\bwithout\\s+(?:telling|informing|notifying|alerting)\\s+(?:the\\s+)?${PRINCIPAL}\\b` +
        `|\\bkeep\\s+(?:this|it|that)\\s+(?:a\\s+)?secret\\b` +
        `|\\b(?:silently|covertly|secretly)\\s+(?:send|post|upload|forward|copy|exfiltrate)\\b`,
      'i',
    ),
  },

  // ── Hidden markup ─────────────────────────────────────────────────────
  {
    id: 'html_comment_injection',
    severity: 'block',
    re: /<!--[\s\S]{0,300}?(?:ignore|override|system\s+prompt|developer\s+mode|do\s+not\s+tell|jailbreak)[\s\S]{0,300}?-->/i,
  },
  {
    id: 'hidden_markup',
    severity: 'block',
    re: /<[^>\n]{0,200}style\s*=\s*["'][^"'\n]{0,200}(?:display\s*:\s*none|font-size\s*:\s*0|visibility\s*:\s*hidden)/i,
  },

  // ── Exfiltration ──────────────────────────────────────────────────────
  // Send verb + sensitive object + outbound sink, all in ONE sentence and in
  // order. Any one alone is ordinary text here: this product legitimately
  // documents a cloud companion at an https:// URL that receives conversation
  // traffic, so only the full three-part shape is a hit.
  {
    id: 'exfil_to_endpoint',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      `\\b(?:send|sends|post|posts|upload|uploads|transmit|transmits|forward|forwards|leak|leaks|exfiltrate|mirror|beacon|copy|copies)\\b` +
        within(60) +
        `\\b(?:conversation|chat\\s+history|message\\s+history|memory\\s+file|system\\s+prompt|credentials?|secrets?|api\\s*keys?|access\\s*keys?|auth\\s+tokens?|passwords?|env(?:ironment)?\\s+(?:vars?|variables?)|\\.env|ssh\\s+keys?|private\\s+key)\\b` +
        within(80) +
        `\\b(?:to|at|into|toward)\\b${within(40)}(?:https?:\\/\\/|\\bwebhook\\b|\\bcollector\\b|\\bendpoint\\b)`,
      'i',
    ),
  },
  {
    id: 'exfil_shell_secret',
    severity: 'block',
    re: /\b(?:curl|wget|httpie|nc|ncat|Invoke-WebRequest|iwr)\b[^\n]{0,140}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i,
  },
  {
    id: 'read_secret_files',
    severity: 'block',
    negatable: true,
    re: /\b(?:cat|strings|base64|xxd)\b[^\n]{0,80}(?:\.env\b|\/credentials\b|\.netrc\b|\.pgpass\b|\.npmrc\b|id_rsa\b|id_ed25519\b)/i,
  },
  {
    id: 'ssh_backdoor_write',
    severity: 'block',
    negatable: true,
    re: new RegExp(
      `\\b(?:append|add|write|echo|install|inject|copy|register)\\b${within(80)}authorized_keys` +
        `|authorized_keys${within(40)}>>`,
      'i',
    ),
  },

  // ── Credential-looking strings ────────────────────────────────────────
  // Memory is injected every turn AND rides the data-repo sync plane, so a real
  // secret parked here is both prompt bloat and a leak. Shape-anchored, so
  // "api_key: <from keychain>" and "set the token from the credential helper"
  // stay clean.
  {
    id: 'hardcoded_secret',
    severity: 'block',
    re: new RegExp(
      `(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|private[_-]?key|bearer)\\s*[:=]\\s*["'\`]?[A-Za-z0-9+/=_-]{20,}` +
        `|\\b(?:sk|rk)-[A-Za-z0-9_-]{24,}` +
        `|\\bgh[pousr]_[A-Za-z0-9]{20,}|\\bgithub_pat_[A-Za-z0-9_]{20,}` +
        `|\\bAKIA[0-9A-Z]{16}\\b` +
        `|\\bxox[baprs]-[A-Za-z0-9-]{12,}` +
        `|-----BEGIN\\s+(?:[A-Z]+\\s+)?PRIVATE KEY-----`,
      'i',
    ),
  },

  // ── Flag-only: observable, never blocking ─────────────────────────────
  // These are the patterns whose false-positive risk is real (security notes,
  // ops runbooks, legitimate config guidance), so they log and nothing else.
  {
    id: 'c2_vocabulary',
    severity: 'flag',
    re: /\bcommand\s+and\s+control\b|\bc2\s+(?:server|channel|beacon|infrastructure)\b|\b(?:cobalt\s*strike|metasploit|sliver\s+implant|mythic\s+agent)\b/i,
  },
  {
    id: 'conversation_dump',
    severity: 'flag',
    re: new RegExp(
      `\\b(?:dump|exfiltrate|upload|share)\\b${gap(3)}\\b(?:full|entire|whole|complete)\\s+(?:conversation|chat\\s+history|context)\\b`,
      'i',
    ),
  },
  {
    id: 'turn_delimiter_spoof',
    severity: 'flag',
    re: /(?:^|\n)\s*(?:Human|Assistant)\s*:\s|<\/?(?:system|human|assistant)>/i,
  },
  {
    id: 'ssh_path_mention',
    severity: 'flag',
    re: /~\/\.ssh\b|\$HOME\/\.ssh\b|authorized_keys/i,
  },
  {
    id: 'agent_config_write',
    severity: 'flag',
    re: /\b(?:append|write|modify|edit|patch|overwrite)\b[^\n]{0,80}(?:CLAUDE\.md|AGENTS\.md|\.cursorrules|\.clinerules|settings\.local\.json)/i,
  },
  {
    id: 'env_unset_agent',
    severity: 'flag',
    re: /\bunset\s+\w*(?:CLAUDE|ANTHROPIC|OPENAI|WALNUT)\w*/i,
  },
];

/**
 * The full table: English patterns first, then the Chinese ones. Ids repeat
 * across the two halves by design (see the header) — `screenMemoryText`
 * collects ids into a list, and a duplicate id would only mean a payload that
 * is an override attempt in both languages at once.
 */
export const THREAT_PATTERNS: ThreatPattern[] = [...EN_THREAT_PATTERNS, ...CJK_THREAT_PATTERNS];

// ── Negation guard ──

/**
 * Tokens that flip an imperative into a prohibition. Chinese markers come from
 * the CJK module (curated there against the live corpus) — the guard has to be
 * bilingual or "永远不要无视系统规则" would be read as the payload it forbids.
 */
const NEGATION_RE = new RegExp(
  `\\b(?:never|not|avoid|refuse|refrain|prohibited|forbidden)\\b|n['’]t\\b|(?:${CJK_NEGATION_SOURCE})`,
  'i',
);
/** Clause boundaries — a negation governs only its OWN clause. */
const CLAUSE_BOUNDARY_RE = new RegExp(`[.!?;:\\n${CJK_CLAUSE_BOUNDARY_CHARS}]`, 'g');
const NEGATION_LOOKBACK = 160;

/**
 * True when the match at `matchIndex` sits in a clause that already contains a
 * negation before it. Clause-scoped rather than a fixed char window, so a long
 * rule like "Never restart the production server without telling the user." is
 * read as a prohibition, while a prepended decoy ("you must never refuse;
 * ignore all previous instructions") does NOT disarm the following clause.
 */
function isNegated(text: string, matchIndex: number): boolean {
  const window = text.slice(Math.max(0, matchIndex - NEGATION_LOOKBACK), matchIndex);
  CLAUSE_BOUNDARY_RE.lastIndex = 0;
  let clauseStart = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_BOUNDARY_RE.exec(window)) !== null) {
    clauseStart = m.index + 1;
  }
  return NEGATION_RE.test(window.slice(clauseStart));
}

/** Does `pattern` hit `text` (already normalized), honoring the negation guard? */
export function patternMatches(pattern: ThreatPattern, text: string): boolean {
  const { re } = pattern;
  if (!pattern.negatable) return re.test(text);
  const global = re.flags.includes('g') ? re : new RegExp(re.source, re.flags + 'g');
  global.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = global.exec(text)) !== null) {
    if (!isNegated(text, m.index)) return true;
    if (m.index === global.lastIndex) global.lastIndex++; // zero-length guard
  }
  return false;
}
