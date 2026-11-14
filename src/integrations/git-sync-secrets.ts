/** Credential detection for letter refusal and output redaction, not private-data sync. */

export interface SecretFinding {
  /** Rule id, e.g. `private-key`, `oauth-token-field`. Never the value. */
  kind: string;
  /** 1-based line in the file. 0 = the path itself. */
  line: number;
}

interface SecretRule {
  id: string;
  /** Cheap substring prefilter (lowercase when the regex ignores case): the regex runs only when one occurs. */
  keywords: string[];
  /** Global regex. Group `v`, when present, is the value judged for placeholders. */
  re: RegExp;
  /** Minimum Shannon entropy (bits/char) of `v`; random credentials sit well above 3.5. */
  minEntropy?: number;
}

// An escaped quote too: a JSON document stored as a string inside JSON (the MSAL
// cache in the 2026-07-26 file) writes every key as \"key\".
const Q = String.raw`\\?["']`;
const FIELD_VALUE = String.raw`\s*[:=]\s*${Q}(?<v>[A-Za-z0-9._~+/=!*-]{32,})${Q}`;

const RULES: SecretRule[] = [
  { id: 'private-key', keywords: ['PRIVATE KEY'], re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws-access-key', keywords: ['AKIA', 'ASIA'], re: /\b(?<v>(?:AKIA|ASIA)[A-Z2-7]{16})\b/g, minEntropy: 3 },
  {
    id: 'aws-secret-key',
    keywords: ['secret_access_key', 'secretaccesskey'],
    re: new RegExp(String.raw`secret_?access_?key${Q}?\s*[:=]\s*${Q}?(?<v>[A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])`, 'gi'),
    minEntropy: 4,
  },
  {
    id: 'github-token',
    keywords: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'],
    re: /\b(?<v>gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/g,
    minEntropy: 4,
  },
  { id: 'gitlab-token', keywords: ['glpat-'], re: /\b(?<v>glpat-[A-Za-z0-9_-]{20,})/g, minEntropy: 3.5 },
  {
    id: 'slack-token',
    keywords: ['xox', 'xapp-'],
    re: /\b(?<v>xox[abposr]-[0-9]{6,}-[A-Za-z0-9-]{10,}|xoxe\.xox[bp]-1-[A-Za-z0-9-]{20,}|xox[pe]-1-[A-Za-z0-9-]{20,}|xapp-1-[A-Z0-9]+-[0-9]+-[a-f0-9]{20,})/g,
    minEntropy: 3.5,
  },
  { id: 'anthropic-key', keywords: ['sk-ant-'], re: /\b(?<v>sk-ant-[a-z]{2,6}\d{2}-[A-Za-z0-9_-]{80,})/g, minEntropy: 4 },
  // Every OpenAI secret key carries the base64 of "OpenAI" in its middle.
  { id: 'openai-key', keywords: ['T3BlbkFJ'], re: /\b(?<v>sk-[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,})/g, minEntropy: 4 },
  { id: 'google-api-key', keywords: ['AIza'], re: /\b(?<v>AIza[0-9A-Za-z_-]{35})(?![0-9A-Za-z_-])/g, minEntropy: 4 },
  { id: 'google-oauth-secret', keywords: ['GOCSPX-'], re: /\b(?<v>GOCSPX-[A-Za-z0-9_-]{28})/g, minEntropy: 4 },
  { id: 'bedrock-api-key', keywords: ['ABSK'], re: /\b(?<v>ABSK[A-Za-z0-9+/]{100,}={0,2})/g, minEntropy: 4 },
  { id: 'npm-token', keywords: ['npm_'], re: /\b(?<v>npm_[A-Za-z0-9]{36})\b/g, minEntropy: 4 },
  {
    id: 'oauth-token-field',
    keywords: ['refresh_token', 'refreshtoken', 'access_token', 'accesstoken', 'client_secret', 'clientsecret', 'id_token', 'idtoken', 'api_key', 'apikey'],
    re: new RegExp(String.raw`${Q}(?:refresh_?token|access_?token|id_?token|client_?secret|api_?key)${Q}${FIELD_VALUE}`, 'gi'),
    minEntropy: 4,
  },
  // An MSAL token cache entry, whatever its value looks like.
  { id: 'msal-credential', keywords: ['credential_type'], re: new RegExp(String.raw`${Q}credential_type${Q}\s*:\s*${Q}(?:RefreshToken|AccessToken|IdToken)${Q}`, 'g') },
  { id: 'bearer-token', keywords: ['bearer '], re: /\bbearer\s+(?<v>[A-Za-z0-9._~+/=-]{32,})/gi, minEntropy: 4 },
  { id: 'jwt', keywords: ['eyJ'], re: /\b(?<v>eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,})/g, minEntropy: 4 },
  // A password in a URL (a git remote with its token, a database URL).
  { id: 'url-credentials', keywords: ['://'], re: /\b[a-z][a-z0-9+.-]{1,15}:\/\/[A-Za-z0-9._%-]{1,64}:(?<v>[A-Za-z0-9._~%!$&'()*+,;=-]{16,})@[A-Za-z0-9.-]+/g, minEntropy: 3.5 },
];

const PLACEHOLDER_RE = /EXAMPLE|example|placeholder|PLACEHOLDER|redacted|REDACTED|xxxxxx|XXXXXX|\*\*\*|\.\.\.|dummy|DUMMY|your_|YOUR_|<|>|\$\{|\{\{/;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Credential stores by NAME: held whatever their content (some are binary). */
const SECRET_PATH_RES: Array<{ id: string; re: RegExp }> = [
  { id: 'env-file', re: /(?:^|\/)\.env(?:\.(?!example$|sample$|template$)[^/]+)?$/ },
  { id: 'ssh-key', re: /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/ },
  { id: 'key-store', re: /\.(?:p12|pfx|jks|keystore|kdbx|keychain|keychain-db|ppk)$/i },
  { id: 'netrc', re: /(?:^|\/)[._]netrc$/ },
  { id: 'credentials-file', re: /(?:^|\/)\.?credentials(?:\.json)?$/ },
  { id: 'aws-credentials', re: /(?:^|\/)\.aws\/(?:credentials|config)$/ },
  { id: 'browser-cookies', re: /(?:^|\/)Cookies(?:-journal)?$|\.cookies(?:\.txt)?$/ },
];

/**
 * The .gitignore lines that match SECRET_PATH_RES (first layer: git never even
 * lists them). The content scan stays the guarantee for a file under another name.
 */
export const SECRET_IGNORE_PATTERNS = [
  '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  '*.p12', '*.pfx', '*.jks', '*.keystore', '*.kdbx', '*.keychain', '*.keychain-db', '*.ppk',
  '.netrc', '_netrc', '.credentials.json',
];

export function secretPathKind(file: string): string | null {
  for (const rule of SECRET_PATH_RES) if (rule.re.test(file)) return rule.id;
  return null;
}

/** Findings in one block of text (sync: keep blocks small, see findSecretsInTextAsync). */
export function findSecretsInText(text: string, lineOffset = 0): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let lineStarts: number[] | null = null;
  const lineAt = (offset: number): number => {
    if (!lineStarts) {
      lineStarts = [0];
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    }
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lineOffset + lo + 1;
  };
  let lower: string | null = null;
  for (const rule of RULES) {
    const ignoreCase = rule.re.flags.includes('i');
    if (ignoreCase && lower === null) lower = text.toLowerCase();
    const haystack = ignoreCase ? lower! : text;
    if (!rule.keywords.some((k) => haystack.includes(k))) continue;
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m; m = rule.re.exec(text)) {
      const value = m.groups?.v;
      if (value !== undefined) {
        if (PLACEHOLDER_RE.test(value)) continue;
        if (rule.minEntropy !== undefined && entropy(value) < rule.minEntropy) continue;
      }
      findings.push({ kind: rule.id, line: lineAt(m.index) });
      if (findings.length >= 20) return findings;
    }
  }
  return findings;
}

const SLICE_CHARS = 256 * 1024;
const SLICE_OVERLAP = 512;
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * findSecretsInText over text of any size: slices of at most 256 KB on line
 * boundaries (a longer line is cut with an overlap wider than any credential),
 * yielding to the event loop between slices so a big file never stalls the server.
 */
export async function findSecretsInTextAsync(text: string): Promise<SecretFinding[]> {
  if (text.length <= SLICE_CHARS) return findSecretsInText(text);
  const findings: SecretFinding[] = [];
  let start = 0;
  let line = 0;
  while (start < text.length && findings.length < 20) {
    let end = Math.min(text.length, start + SLICE_CHARS);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      end = nl > start ? nl + 1 : end;
    }
    const cut = end < text.length && text[end - 1] !== '\n';
    const slice = text.slice(start, cut ? Math.min(text.length, end + SLICE_OVERLAP) : end);
    for (const f of findSecretsInText(slice, line)) {
      if (!findings.some((g) => g.kind === f.kind && g.line === f.line)) findings.push(f);
    }
    for (let i = text.indexOf('\n', start); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) line++;
    start = end;
    await yieldLoop();
  }
  return findings.slice(0, 20);
}

export type GitRunner = (args: string[], input?: string) => Promise<string>;
