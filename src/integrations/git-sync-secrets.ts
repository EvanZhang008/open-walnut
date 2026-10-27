/**
 * Secret scan for the data repo's auto-commits: no credential reaches the sync
 * history, whatever wrote it and wherever it landed.
 *
 * Why a content scan and not only ignore rules: the .gitignore is a deny list,
 * and the 30s auto-save runs `git add -A`, so anything nobody thought to list is
 * committed. On 2026-07-26 that was `sync/.open-walnut-<hash>.tmp`, the atomic-write
 * temp of the Microsoft To Do sign-in cache (an access token and an MSAL refresh
 * token): `sync/*.json` ignored the cache, not its temp. The rule for that temp
 * came two weeks later, after the file was already in history. This scan judges
 * what is about to be committed, so the next unlisted file is caught the first time.
 *
 * A file it flags is "held": kept out of every commit while it adds a credential.
 *  - A new file is judged whole and leaves the index (`git rm --cached`): it stays
 *    untracked and is deliberately NOT gitignored, because git overwrites an ignored
 *    file when a merge or checkout writes that path but refuses to overwrite an
 *    untracked one.
 *  - A tracked file is judged on what it adds to HEAD's version, and its index entry
 *    goes back to HEAD (`git reset`): the history and every other box keep its last
 *    version without the credential, nothing is deleted anywhere, and the file stays
 *    changed on this box (so the tick's pull takes the merge path, which a dirty file
 *    does not block).
 *  - When the other box changes a held path, git would refuse the merge (and `reset
 *    --hard` / `checkout -f` would discard the local copy), so the merge path first
 *    moves the local copy to `<file>.conflicted-secret-<stamp>` (ignored by the
 *    `*.conflicted-*` rule) and tells the user.
 *  - Every stage judges it again (a cache keyed by the blobs skips unchanged work),
 *    so a hold ends by itself once the credential is gone; .git/walnut-secret-holds.json
 *    only remembers letters and set-aside candidates, and the next stage rebuilds it.
 *  - The user gets one inbox letter per stage that holds new files, naming each file,
 *    the kind of secret and its lines, never the value.
 * An older Walnut (after a rollback) sees ordinary changed and untracked files and
 * would commit them: the guard protects the versions that have it.
 *
 * The rules are high-precision on purpose: a false hit stops one file from syncing
 * and sends a letter; a miss publishes a credential. Values that look like
 * placeholders (EXAMPLE, xxxx, <token>, ***) are not secrets.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logging/index.js';

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

// ── Holds ────────────────────────────────────────────────────────────────────

export type GitRunner = (args: string[], input?: string) => Promise<string>;

export interface SecretHold {
  kinds: string[];
  lines: number[];
  /** ISO time the hold began. */
  since: string;
  /** HEAD has the file: held at HEAD's version in the index (else: a new file, held untracked). */
  tracked: boolean;
  /** The letter that announced it (its opKey). */
  letterOp?: string;
}

interface HoldStore { version: 2; holds: Record<string, SecretHold> }

const HOLDS_FILE = 'walnut-secret-holds.json';

export interface SecretHoldNotice {
  /** `held`: these files were just kept out. `set-aside`: the local copy of `files[0]` moved to `aside` so a merge could run. `released`: no credential left in them. */
  event: 'held' | 'set-aside' | 'released';
  files: Array<{ file: string; hold: SecretHold }>;
  aside?: string;
  /** The letter key for this notice. */
  op: string;
}

type Notifier = (notice: SecretHoldNotice) => Promise<void> | void;
let notifier: Notifier = defaultNotifier;

/** Test seam: where hold notices go (default: the user's inbox). */
export function setSecretHoldNotifierForTest(fn: Notifier | null): void {
  notifier = fn ?? defaultNotifier;
}

function describe(hold: SecretHold): string {
  const byKind = new Map<string, number[]>();
  hold.kinds.forEach((kind, i) => {
    const lines = byKind.get(kind) ?? [];
    if (hold.lines[i]) lines.push(hold.lines[i]);
    byKind.set(kind, lines);
  });
  return [...byKind].map(([kind, lines]) => (lines.length ? `${kind} (line ${lines.slice(0, 5).join(', ')})` : kind)).join(', ');
}

/** Files Walnut writes itself (session records, chats, task stores): the user cannot "edit the secret out". */
function walnutWritten(file: string): boolean {
  return /^(?:sessions|conversations|tasks|timeline)\/|^chat-history[^/]*\.json$/.test(file);
}

async function defaultNotifier(notice: SecretHoldNotice): Promise<void> {
  if (process.env.WALNUT_SECRET_HOLD_LETTER === '0') return;
  const { sendLetterOnce, findLetterByOp, setArchived } = await import('../core/human-inbox/store.js');
  if (notice.event === 'released') {
    const letter = await findLetterByOp(notice.op);
    if (letter) await setArchived(letter.id, true);
    return;
  }
  const sender = { sessionId: 'external', host: 'local' };
  if (notice.event === 'set-aside') {
    const { file, hold } = notice.files[0];
    await sendLetterOnce({
      subject: 'A file kept out of sync was set aside',
      type: 'review',
      sender,
      markdown: [
        `The other machine changed \`${file}\` in the Walnut data folder while this machine kept its copy out of sync for a secret (${describe(hold)}).`,
        '',
        `So the sync could take that change, this machine's copy was moved to \`${notice.aside}\`, which never syncs, and \`${file}\` now has the synced version. Copy over anything you still need from it, without the secret, then delete it.`,
      ].join('\n'),
    }, { opKey: notice.op });
    return;
  }
  const rows = notice.files.map(({ file, hold }) => `- \`${file}\`: ${describe(hold)}${walnutWritten(file) ? ' (a record Walnut writes; it stays on this machine)' : ''}`);
  await sendLetterOnce({
    subject: notice.files.length === 1 ? 'A file was kept out of sync: it holds a secret' : `${notice.files.length} files were kept out of sync: they hold secrets`,
    type: 'review',
    sender,
    markdown: [
      `Walnut did not sync ${notice.files.length === 1 ? 'this file' : 'these files'} from its data folder, because each looks like it holds a credential:`,
      '',
      ...rows,
      '',
      'Nothing was changed on this machine, and nothing was sent anywhere. A file stays out of the synced history while it holds the credential and syncs again by itself once it does not; a file the sync already had keeps its last version without it on your other machines.',
      '',
      'If it is a real credential, take it out of the file (keep credentials in Settings or in the `secrets/` folder, which never syncs) and consider replacing it. If it is not a secret, rewording those lines lets the file sync.',
    ].join('\n'),
  }, { opKey: notice.op });
}

async function notify(notice: SecretHoldNotice): Promise<void> {
  try {
    await notifier(notice);
  } catch (error) {
    log.git.warn('git-sync: could not tell the user about a secret hold', { event: notice.event, files: notice.files.map((f) => f.file), error: error instanceof Error ? error.message : String(error) });
  }
}

async function gitDir(git: GitRunner, root: string): Promise<string> {
  return path.resolve(root, (await git(['rev-parse', '--git-dir'])).trim());
}

async function readHolds(dir: string): Promise<HoldStore> {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(dir, HOLDS_FILE), 'utf-8')) as HoldStore;
    if (parsed && parsed.version === 2 && parsed.holds && typeof parsed.holds === 'object') return parsed;
  } catch { /* none yet, or unreadable: the scan rebuilds it */ }
  return { version: 2, holds: {} };
}

async function writeHolds(dir: string, store: HoldStore): Promise<void> {
  const file = path.join(dir, HOLDS_FILE);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(tmp, file);
}

/** One hold operation at a time per repo: commitIfDirty and the sync tick can overlap. */
const chains = new Map<string, Promise<unknown>>();
function serialized<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(root) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(root, next.catch(() => undefined));
  return next;
}

/**
 * Verdicts of earlier scans, keyed by what was judged (the staged blob, and for a
 * tracked file the HEAD blob it is compared with). Least recently used goes first,
 * so a held file stays cached through a big first commit.
 */
const verdictCache = new Map<string, SecretFinding[]>();
const VERDICT_CACHE_MAX = 5000;
function cachedVerdict(key: string): SecretFinding[] | undefined {
  const hit = verdictCache.get(key);
  if (hit) { verdictCache.delete(key); verdictCache.set(key, hit); }
  return hit;
}
function rememberVerdict(key: string, findings: SecretFinding[]): void {
  verdictCache.set(key, findings);
  if (verdictCache.size > VERDICT_CACHE_MAX) verdictCache.delete(verdictCache.keys().next().value as string);
}

/** Keywords of the rules that match a credential store's structure rather than its value. */
const STRUCTURAL_KEYWORDS = ['credential_type', 'PRIVATE KEY'];

interface StagedEntry { file: string; blob: string; headBlob: string | null; binary: boolean }

const NULL_BLOB = /^0+$/;

async function stagedEntries(git: GitRunner): Promise<StagedEntry[]> {
  const raw = await git(['diff', '--cached', '--no-renames', '--diff-filter=AMT', '--raw', '-z', '--no-abbrev']);
  if (!raw) return [];
  const fields = raw.split('\0');
  const entries: StagedEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, oldBlob, blob] = fields[i].split(' ');
    if (!fields[i + 1] || mode === '160000' || mode === '120000') continue;
    entries.push({ file: fields[i + 1], blob, headBlob: oldBlob && !NULL_BLOB.test(oldBlob) ? oldBlob : null, binary: false });
  }
  if (entries.length === 0) return entries;
  const numstat = await git(['diff', '--cached', '--no-renames', '--diff-filter=AMT', '--numstat', '-z']);
  const binary = new Set<string>();
  for (const row of numstat.split('\0')) {
    const m = /^-\t-\t(.+)$/s.exec(row);
    if (m) binary.add(m[1]);
  }
  for (const e of entries) e.binary = binary.has(e.file);
  return entries;
}

/**
 * The lines a staged change ADDS to a tracked file, with their line numbers. One
 * file per call (its name goes to git as a literal pathspec, never parsed back out
 * of a patch), and only lines after the first hunk header count, so content that
 * looks like a header ("+++ x") is still content.
 */
async function addedLines(git: GitRunner, file: string): Promise<{ text: string; lines: number[] }> {
  const patch = await git(['--literal-pathspecs', 'diff', '--cached', '--no-renames', '-U0', '--no-color', '--no-ext-diff', '--', file]);
  const out: string[] = [];
  const lines: number[] = [];
  let inHunks = false;
  let next = 0;
  for (const row of patch.split('\n')) {
    if (row.startsWith('@@')) {
      inHunks = true;
      const m = /\+(\d+)/.exec(row);
      next = m ? Number(m[1]) : 0;
      continue;
    }
    if (!inHunks) continue;
    if (row.startsWith('+')) { out.push(row.slice(1)); lines.push(next++); }
  }
  return { text: out.join('\n'), lines };
}

/**
 * What a staged entry adds that holds a credential. A new file is judged whole; a
 * tracked file only on what it adds to HEAD's version, so a credential that is
 * already in the history does not take a file out of sync (the history cleanup is
 * a separate, deliberate step) and a hold ends once the added credential is gone.
 */
async function judge(git: GitRunner, entry: StagedEntry): Promise<SecretFinding[]> {
  const byName = secretPathKind(entry.file);
  if (byName) return [{ kind: byName, line: 0 }];
  if (entry.binary) return [];
  const key = `${entry.headBlob ?? 'new'}:${entry.blob}`;
  const cached = cachedVerdict(key);
  if (cached) return cached;
  let findings: SecretFinding[];
  if (!entry.headBlob) {
    findings = await findSecretsInTextAsync(await git(['cat-file', 'blob', entry.blob]));
  } else {
    const added = await addedLines(git, entry.file);
    findings = (await findSecretsInTextAsync(added.text)).map((f) => ({ kind: f.kind, line: added.lines[f.line - 1] ?? 0 }));
    // A file that already IS a credential store in HEAD (an MSAL cache, a private
    // key) changes only its values on rotation, which no rule sees line by line: judge it whole.
    if (findings.length === 0) {
      const head = await git(['cat-file', 'blob', entry.headBlob]);
      if (STRUCTURAL_KEYWORDS.some((k) => head.includes(k))) findings = await findSecretsInTextAsync(await git(['cat-file', 'blob', entry.blob]));
    }
  }
  rememberVerdict(key, findings);
  return findings;
}

/**
 * Run after `add` and before `commit`: judge every staged new or changed file and
 * take each one that adds a credential out of the commit. A new file leaves the
 * index (untracked, never ignored); a tracked one goes back to HEAD's version in
 * the index, so every other box keeps its last clean copy and nothing is deleted
 * anywhere. Throws when one cannot be taken out, so the caller commits nothing.
 */
export function holdStagedSecrets(git: GitRunner, root: string): Promise<string[]> {
  return serialized(root, () => holdStagedSecretsNow(git, root));
}

async function holdStagedSecretsNow(git: GitRunner, root: string): Promise<string[]> {
  const entries = await stagedEntries(git);
  const flagged = new Map<string, { findings: SecretFinding[]; tracked: boolean }>();
  for (const entry of entries) {
    const findings = await judge(git, entry);
    if (findings.length > 0) flagged.set(entry.file, { findings, tracked: entry.headBlob !== null });
  }

  const dir = await gitDir(git, root);
  const store = await readHolds(dir);
  const files = [...flagged.keys()];
  if (files.length > 0) {
    const fresh = files.filter((f) => !flagged.get(f)!.tracked);
    const tracked = files.filter((f) => flagged.get(f)!.tracked);
    try {
      // --cached / reset never touch the file on disk.
      if (fresh.length > 0) await git(['--literal-pathspecs', 'rm', '--cached', '-r', '-f', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], fresh.join('\0'));
      if (tracked.length > 0) await git(['--literal-pathspecs', 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], tracked.join('\0'));
    } catch (error) {
      throw new Error(`git-sync: could not keep ${files.length} file(s) holding a secret out of the commit: ${error instanceof Error ? error.message : String(error)}`);
    }
    const still = new Set((await stagedEntries(git)).map((e) => e.file));
    const leaked = files.filter((file) => still.has(file));
    if (leaked.length > 0) throw new Error(`git-sync: ${leaked.length} file(s) holding a secret are still staged; refusing to commit`);
  }

  // Holds that ended: the file was staged clean this time, or it is gone.
  const staged = new Set(entries.map((e) => e.file));
  const released: Array<{ file: string; hold: SecretHold }> = [];
  for (const [file, hold] of Object.entries(store.holds)) {
    if (flagged.has(file)) continue;
    let ended = staged.has(file) || !fs.existsSync(path.join(root, file));
    // A tracked file put back to exactly HEAD's version is not staged at all.
    if (!ended && hold.tracked) {
      const [local, headBlob] = await Promise.all([
        git(['hash-object', '--', file]).catch(() => ''),
        blobAt(git, 'HEAD', file),
      ]);
      ended = !!headBlob && local.trim() === headBlob;
    }
    if (ended) {
      released.push({ file, hold });
      delete store.holds[file];
    }
  }

  const op = `git-sync-secret-hold:${new Date().toISOString()}`;
  const added: Array<{ file: string; hold: SecretHold }> = [];
  for (const file of files) {
    const { findings, tracked } = flagged.get(file)!;
    const prior = store.holds[file];
    const hold: SecretHold = {
      kinds: findings.map((f) => f.kind),
      lines: findings.map((f) => f.line),
      since: prior?.since ?? new Date().toISOString(),
      tracked,
      letterOp: prior?.letterOp ?? op,
    };
    store.holds[file] = hold;
    if (!prior) added.push({ file, hold });
  }
  if (added.length > 0 || released.length > 0) await writeHolds(dir, store);

  if (added.length > 0) {
    log.git.warn('git-sync: kept file(s) out of the commit because they hold a secret', {
      files: added.slice(0, 20).map(({ file, hold }) => ({ file, kinds: hold.kinds, lines: hold.lines, tracked: hold.tracked })),
      count: added.length,
    });
    await notify({ event: 'held', files: added, op });
  }
  if (released.length > 0) {
    log.git.info('git-sync: file(s) no longer hold a secret and sync again', { files: released.map((r) => r.file) });
    // A letter is archived once none of the files it named is still held.
    const stillHeldOps = new Set(Object.values(store.holds).map((h) => h.letterOp));
    const ops = new Set(released.map((r) => r.hold.letterOp).filter((o): o is string => !!o && !stillHeldOps.has(o)));
    for (const o of ops) await notify({ event: 'released', files: released.filter((r) => r.hold.letterOp === o), op: o });
  }
  return files;
}

async function blobAt(git: GitRunner, ref: string, file: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', '--verify', '-q', `${ref}:${file}`])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run after a fetch and before a merge, reset or checkout to `ref`. A held file is
 * either untracked or a tracked file with local changes, so git refuses to write
 * its path (the safe failure, but the sync would stay stuck on it), and `reset
 * --hard` / `checkout -f` would discard it. When `ref` brings its own version, the
 * local copy moves to a never-synced sidecar and the path is cleared for git.
 *
 * `merge`: only when `ref` changed or added the path since the merge base.
 * `replace` (reset --hard, checkout -f): whenever the local file differs from what
 * `ref` holds there (or `ref` lacks a tracked held file, which the reset deletes).
 */
export function setAsideHeldTouchedBy(git: GitRunner, root: string, ref: string, mode: 'merge' | 'replace'): Promise<string[]> {
  return serialized(root, async () => {
    const dir = await gitDir(git, root);
    if (!fs.existsSync(path.join(dir, HOLDS_FILE))) return [];
    const store = await readHolds(dir);
    const held = Object.keys(store.holds).filter((file) => fs.existsSync(path.join(root, file)));
    if (held.length === 0) return [];
    let base: string | null = null;
    if (mode === 'merge') {
      try { base = (await git(['merge-base', 'HEAD', ref])).trim() || null; } catch { base = null; }
    }
    const moved: string[] = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const file of held) {
      const hold = store.holds[file];
      const incoming = await blobAt(git, ref, file);
      if (mode === 'merge') {
        const before = base ? await blobAt(git, base, file) : null;
        // The other box deleted a tracked held file: the merge would refuse over the local change.
        if (!incoming && !(hold.tracked && before)) continue;
        if (incoming && before === incoming) continue;
      } else {
        if (!incoming && !hold.tracked) continue;
        const local = (await git(['hash-object', '--', file]).catch(() => '')).trim();
        if (incoming && local === incoming) continue;
      }
      const aside = `${file}.conflicted-secret-${stamp}`;
      try {
        await fsp.copyFile(path.join(root, file), path.join(root, aside));
        if (hold.tracked) await git(['--literal-pathspecs', 'checkout', '-q', 'HEAD', '--', file]);
        else await fsp.rm(path.join(root, file));
      } catch (error) {
        log.git.error('git-sync: could not set aside a held file before a merge', { file, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      delete store.holds[file];
      moved.push(file);
      await notify({ event: 'set-aside', files: [{ file, hold }], aside, op: `git-sync-secret-aside:${file}:${stamp}` });
    }
    if (moved.length > 0) {
      await writeHolds(dir, store);
      log.git.warn('git-sync: set aside held file(s) the other box changed, so the merge can run', { files: moved, ref, mode });
    }
    return moved;
  });
}

/** Test hook: forget cached verdicts. */
export function resetSecretScanCacheForTest(): void {
  verdictCache.clear();
}
