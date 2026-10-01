/**
 * The rules file on disk: `<plugin data dir>/sort-rules.yaml`.
 *
 * The file is the user's, so every rule about it leans toward not surprising them:
 * - a file that fails to read, parse or validate never replaces the rules in use; the last good
 *   rules (also kept in the mail database's meta table) stay, and the error says which line;
 * - a file that vanishes is only believed gone after it stays gone for two checks about 4 s
 *   apart (an editor's atomic save deletes then renames);
 * - a save from the console writes a temp file and renames it over the old one, after copying the
 *   old one to `.bak` ONCE per editing session (60 s), so a burst of reorders keeps the version
 *   from before the burst.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { derivedRuleId } from './sort-classify.js'
import { rulesErrorOf, syntaxErrorOf, withLines } from './sort-rules-lines.js'
import { validateRulesDoc } from './sort-rules-schema.js'
import type { Rule, RuleValidationError, RulesError, RulesFileDoc } from './sort-types.js'

export const RULES_FILE_NAME = 'sort-rules.yaml'
export const LAST_GOOD_META_KEY = 'sort_rules_last_good'
export const MISSING_FILE_REV = 'missing'
const WATCH_DEBOUNCE_MS = 1_000
const POLL_MS = 5_000
const MISSING_CONFIRM_MS = 4_000
const BACKUP_SESSION_MS = 60_000

export const RULES_CHANGED_ON_DISK = 'The rules file changed on disk. Reload to see the new version.'

export function fileRevOf(bytes: string | Buffer | null): string {
  if (bytes === null) return MISSING_FILE_REV
  return crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12)
}

export function parseRulesYaml(text: string): unknown {
  return yaml.load(text, { schema: yaml.CORE_SCHEMA })
}

const HEADER = '# Walnut mail sorting rules. Saving from Walnut rewrites this file;'
  + ' the previous version is kept as sort-rules.yaml.bak.\n'

/** Canonical YAML for a doc (hand-written comments are not kept). */
export function dumpRulesDoc(doc: RulesFileDoc): string {
  const rules = doc.rules.map((rule) => {
    const out: Record<string, unknown> = { id: rule.id, when: rule.when, then: rule.then, source: rule.source }
    if (rule.note) out.note = rule.note
    if (rule.created) out.created = rule.created
    if (rule.enabled === false) out.enabled = false
    if (rule.label) out.label = rule.label
    if (rule.skipInbox) out.skipInbox = true
    return out
  })
  return HEADER + yaml.dump({ version: 1, groups: doc.groups, rules }, { lineWidth: 120, noRefs: true })
}

export const EXAMPLE_RULES_FILE = `# Walnut mail sorting rules.
# Walnut's model sorts unread mail into Important and groups it names; these rules come first,
# top to bottom, and the first rule that matches wins. Each rule: when (every listed condition
# must hold) and then (Important, Not important, or a group name). Not important keeps the
# model's group; a group name puts the mail in that group.
# Conditions: from (address glob like "issues@*" or "@example.invalid", or a display name),
#   subject (text it contains, or { re: "pattern" }), listId, addressedToMe (true/false),
#   cc (true), sender (person, bulk, transactional, automated, unknown), account, message,
#   group (the group the model put the mail in).
# skipInbox: true keeps the mail out of the inbox: Walnut moves it to the account's archive as it
#   arrives (unread), while Walnut is running. Only with a group in then.
# Example:
#   - when: { from: ["issues@*", "noreply-oncall-notifications@*"] }
#     then: On-call & tickets
#     source: user
#     note: "Pages and tickets"
version: 1
groups: []
rules: []
`

/** Fill missing ids with `r-` + 6 hex, never colliding with another rule's id. */
export function fillRuleIds(rules: Rule[]): Rule[] {
  const used = new Set(rules.map((rule) => rule.id).filter((id): id is string => !!id))
  return rules.map((rule, index) => {
    if (rule.id) return rule
    let id = derivedRuleId(rule, index)
    for (let salt = 0; used.has(id); salt += 1) id = derivedRuleId(rule, index + 1000 * (salt + 1))
    used.add(id)
    return { ...rule, id }
  })
}

export function missingSentence(since: number): string {
  const at = new Date(since)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return `The rules file is missing. Walnut is still using the rules from ${hh}:${mm}.`
}

export interface RulesFileState {
  doc: RulesFileDoc
  fileRev: string
  exists: boolean
  error?: RulesError
  /** When the rules in use were last read successfully. */
  since: number
}

export type RulesSaveOutcome =
  | { ok: true; fileRev: string; doc: RulesFileDoc }
  | { ok: false; status: 400 | 404 | 409; json: Record<string, unknown> }

export interface RulesFileDeps {
  dataDir: string
  meta: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }
  /** Host timers (walnut.timers.interval), so teardown cancels the poll. */
  interval?: (handler: () => void | Promise<void>, ms: number) => { dispose(): void }
  /** Default on; tests pass false and call `check()` themselves. */
  watch?: boolean
  now?: () => number
  onChange: (state: RulesFileState) => void
  log?: { warn(message: string, fields?: Record<string, unknown>): void }
}

const EMPTY_DOC: RulesFileDoc = { version: 1, groups: [], rules: [] }

export class MailRulesFile {
  readonly path: string
  readonly backupPath: string
  private state: RulesFileState
  private missingSince: number | null = null
  private lastPutAt = 0
  private lastStat = ''
  private debounce: ReturnType<typeof setTimeout> | null = null
  private watcher: fs.FSWatcher | null = null
  private poll: { dispose(): void } | null = null
  private checking: Promise<void> | null = null
  private disposed = false

  constructor(private readonly deps: RulesFileDeps) {
    this.path = path.join(deps.dataDir, RULES_FILE_NAME)
    this.backupPath = `${this.path}.bak`
    this.state = { doc: EMPTY_DOC, fileRev: MISSING_FILE_REV, exists: false, since: this.now }
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  get current(): RulesFileState {
    return this.state
  }

  /** Boot: the meta copy first (so a broken file still has rules), then the disk. */
  async start(): Promise<void> {
    const raw = await this.deps.meta.get(LAST_GOOD_META_KEY).catch(() => undefined)
    if (raw) {
      try {
        const saved = JSON.parse(raw) as { doc?: unknown; at?: number }
        const valid = validateRulesDoc(saved.doc)
        if (valid.ok) this.state = { ...this.state, doc: valid.doc, since: saved.at ?? this.now }
      } catch { /* a corrupt meta row reads as none */ }
    }
    await this.check(true)
    if (this.deps.watch === false || this.disposed) return
    try {
      this.watcher = fs.watch(this.deps.dataDir, (_event, name) => {
        if (name && !String(name).startsWith(RULES_FILE_NAME)) return
        this.schedule()
      })
      this.watcher.on('error', () => undefined)
      this.watcher.unref?.()
    } catch (error) {
      this.deps.log?.warn('mail rules file watch unavailable; polling only', { error: String(error) })
    }
    this.poll = this.deps.interval?.(() => this.pollOnce(), POLL_MS) ?? null
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => { this.debounce = null; void this.check() }, WATCH_DEBOUNCE_MS)
    this.debounce.unref?.()
  }

  private async pollOnce(): Promise<void> {
    const stat = await fsp.stat(this.path).then((s) => `${s.mtimeMs}:${s.size}`, () => 'missing')
    if (stat === this.lastStat && stat !== 'missing') return
    if (stat === 'missing' && !this.state.exists && this.missingSince === null) return
    await this.check()
  }

  /** Read the disk once; serialised so two triggers never race each other. */
  check(boot = false): Promise<void> {
    const run = (this.checking ?? Promise.resolve()).then(() => this.checkNow(boot))
    this.checking = run.catch(() => undefined)
    return run
  }

  private async checkNow(boot: boolean): Promise<void> {
    if (this.disposed) return
    let bytes: Buffer | null = null
    try {
      bytes = await fsp.readFile(this.path)
      const stat = await fsp.stat(this.path)
      this.lastStat = `${stat.mtimeMs}:${stat.size}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.setError({ message: `Walnut could not read the rules file: ${String(error)}`, since: this.state.since })
        return
      }
      this.lastStat = 'missing'
    }
    if (bytes === null) return this.onMissing(boot)
    this.missingSince = null
    const fileRev = fileRevOf(bytes)
    if (!boot && fileRev === this.state.fileRev && this.state.exists) return
    const text = bytes.toString('utf8')
    let parsed: unknown
    try {
      parsed = parseRulesYaml(text)
    } catch (error) {
      this.setError(syntaxErrorOf(error, this.state.since), { fileRev, exists: true })
      return
    }
    const valid = validateRulesDoc(parsed)
    if (!valid.ok) {
      this.setError(rulesErrorOf(text, valid.errors, this.state.since), { fileRev, exists: true })
      return
    }
    await this.accept(valid.doc, fileRev)
  }

  private onMissing(boot: boolean): void {
    const hadRules = this.state.doc.rules.length > 0 || this.state.doc.groups.length > 0
    if (boot) {
      // Never created: built-ins only, no error. Deleted while Walnut was off: keep the meta copy.
      this.state = { ...this.state, exists: false, fileRev: MISSING_FILE_REV }
      if (hadRules) this.state.error = { message: missingSentence(this.state.since), since: this.state.since }
      this.deps.onChange(this.state)
      return
    }
    if (!this.state.exists) return
    if (this.missingSince === null) { this.missingSince = this.now; return }
    if (this.now - this.missingSince < MISSING_CONFIRM_MS) return
    this.state = {
      ...this.state, exists: false, fileRev: MISSING_FILE_REV,
      error: { message: missingSentence(this.state.since), since: this.state.since },
    }
    this.deps.onChange(this.state)
  }

  private setError(error: RulesError, patch: Partial<RulesFileState> = {}): void {
    this.state = { ...this.state, ...patch, error }
    this.deps.onChange(this.state)
  }

  private async accept(doc: RulesFileDoc, fileRev: string): Promise<void> {
    const at = this.now
    this.state = { doc, fileRev, exists: true, since: at }
    await this.deps.meta.set(LAST_GOOD_META_KEY, JSON.stringify({ doc, at })).catch(() => undefined)
    this.deps.onChange(this.state)
  }

  private async readDisk(): Promise<Buffer | null> {
    try { return await fsp.readFile(this.path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** Temp file in the same directory, then rename: a reader never sees half a file. */
  private async writeAtomic(text: string): Promise<void> {
    const tmp = `${this.path}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    await fsp.writeFile(tmp, text, { mode: 0o600 })
    try {
      await fsp.rename(tmp, this.path)
    } catch (error) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /**
   * `PUT /rules`. `baseRev` is the fileRev the caller last saw; anything else on disk is 409.
   * Validates before touching the disk; fills missing ids; keeps one `.bak` per editing session.
   */
  async save(input: { groups: unknown; rules: unknown }, baseRev: string): Promise<RulesSaveOutcome> {
    const bytes = await this.readDisk()
    if (fileRevOf(bytes) !== baseRev) {
      return { ok: false, status: 409, json: { error: 'changed', message: RULES_CHANGED_ON_DISK } }
    }
    const valid = validateRulesDoc({ version: 1, groups: input.groups ?? [], rules: input.rules ?? [] })
    if (!valid.ok) return { ok: false, status: 400, json: { error: 'invalid', errors: valid.errors } }
    const doc: RulesFileDoc = { ...valid.doc, rules: fillRuleIds(valid.doc.rules) }
    const text = dumpRulesDoc(doc)
    const now = this.now
    if (bytes !== null && now - this.lastPutAt >= BACKUP_SESSION_MS) {
      await fsp.writeFile(this.backupPath, bytes, { mode: 0o600 })
    }
    this.lastPutAt = now
    await this.writeAtomic(text)
    const fileRev = fileRevOf(text)
    this.missingSince = null
    await this.accept(doc, fileRev)
    return { ok: true, fileRev, doc }
  }

  /** `POST /rules/init`: the commented example, only when there is no file. */
  async init(): Promise<RulesSaveOutcome> {
    if ((await this.readDisk()) !== null) {
      return { ok: false, status: 409, json: { error: 'exists', message: 'The rules file already exists.' } }
    }
    await this.writeAtomic(EXAMPLE_RULES_FILE)
    await this.check()
    return { ok: true, fileRev: this.state.fileRev, doc: this.state.doc }
  }

  /** `POST /rules/restore`: the `.bak` back over the file. */
  async restore(): Promise<RulesSaveOutcome> {
    let backup: Buffer
    try { backup = await fsp.readFile(this.backupPath) }
    catch {
      return { ok: false, status: 404, json: { error: 'no-backup', message: 'There is no backup of the rules file.' } }
    }
    await this.writeAtomic(backup.toString('utf8'))
    this.missingSince = null
    await this.check(true)
    return { ok: true, fileRev: this.state.fileRev, doc: this.state.doc }
  }

  /** The 400 errors of a raw text, with lines (tests and Settings' paste path). */
  validateText(text: string): RuleValidationError[] {
    let parsed: unknown
    try { parsed = parseRulesYaml(text) }
    catch (error) {
      const syntax = syntaxErrorOf(error, this.now)
      return [{ index: -1, field: 'file', message: syntax.message, ...(syntax.line ? { line: syntax.line } : {}) }]
    }
    const valid = validateRulesDoc(parsed)
    return valid.ok ? [] : withLines(text, valid.errors)
  }

  dispose(): void {
    this.disposed = true
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
    this.watcher?.close()
    this.watcher = null
    this.poll?.dispose()
    this.poll = null
  }
}
