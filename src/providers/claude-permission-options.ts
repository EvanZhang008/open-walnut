/**
 * The choices a Claude CLI permission prompt offers beyond Allow / Deny, built
 * from the request's own `permission_suggestions` (the rules the CLI's terminal
 * dialog offers as "Yes, and don't ask again for ...").
 *
 * The options ride the SAME wire field as an ACP adapter's own options
 * (`acpOptions`: event, stream block, notification record, pending list), so
 * every surface that already renders ACP options (timeline card, notification
 * rail, kanban card, a phone on an older build) offers them with no change, and
 * answers with `optionId`. The server maps that id back to the rules here: a
 * client never sends rules, so it cannot widen what the CLI is told to allow.
 *
 * Verified against CLI 2.1.312 (can_use_tool / PermissionResult schemas):
 * - `allow_session` sends the suggestions with destination `session`: the rule
 *   lives in the CLI process only, and the same call is not asked again in it.
 * - `allow_always` sends them with the CLI's own destination (usually
 *   `localSettings`, the project's `.claude/settings.local.json`).
 * - A `setMode` suggestion (Write/Edit: "allow all edits during this session")
 *   switches the CLI's mode; the CLI reports it in a system/status event, which
 *   the session already follows (mode, record, daemon policy).
 * - `suppress_always_allow_rule`: the CLI says a standing rule would be broader
 *   than the ask, so no remembering option is offered.
 */

import os from 'node:os'

/** One CLI permission rule update (the CLI's PermissionUpdate). */
export type ClaudePermissionUpdate =
  | { type: 'addRules' | 'replaceRules' | 'removeRules'; rules: Array<{ toolName: string; ruleContent?: string }>; behavior: string; destination: string }
  | { type: 'setMode'; mode: string; destination: string }
  | { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: string }

/** A choice on a permission prompt, as clients receive it (the ACP option shape plus `detail`). */
export interface PermissionChoice {
  optionId: string
  kind: 'allow_once' | 'allow_always' | 'reject_once'
  name: string
  /** What the option allows, in the CLI's rule words (`Bash(npm test:*)`, `all file edits`). */
  detail?: string
  /** A deny that carries the person's note to the agent as the tool's result (`message`). */
  takesNote?: boolean
  /** Where a standing rule is written (`.claude/settings.local.json`), so the person knows what stays. */
  savedTo?: string
}

/** The fields of a can_use_tool request this module reads. */
export interface ClaudePermissionAsk {
  tool_name?: string
  input?: Record<string, unknown>
  permission_suggestions?: unknown[]
  suppress_always_allow_rule?: boolean
}

export const CLAUDE_OPTION_ALLOW = 'allow_once'
export const CLAUDE_OPTION_SESSION = 'allow_session'
export const CLAUDE_OPTION_ALWAYS = 'allow_always'
export const CLAUDE_OPTION_DENY = 'reject_once'

/** Tools whose prompt is not a tool-call approval: their cards answer in their own way. */
const OWN_PROMPT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const PERSISTENT_DESTINATIONS = new Set(['localSettings', 'projectSettings', 'userSettings'])

function isRule(r: unknown): r is { toolName: string; ruleContent?: string } {
  if (!r || typeof r !== 'object') return false
  const { toolName, ruleContent } = r as { toolName?: unknown; ruleContent?: unknown }
  return typeof toolName === 'string' && toolName.length > 0
    && (ruleContent === undefined || typeof ruleContent === 'string')
    && !(toolName === 'Bash' && typeof ruleContent === 'string' && widensBeyondItsText(ruleContent))
}

/**
 * A Bash rule's "*" is the CLI's wildcard wherever it stands, and the CLI has no way
 * to write a literal one (measured on CLI 2.1.312: `\*` matches neither the command
 * nor anything else). So the suggested rule for `python3 -c "print(6*7)"` also allows
 * `python3 -c "print(6); rm -rf x; print(7)"`. Such a rule is not offered: a choice
 * must grant exactly what it says. The one wildcard meant as one stays: the trailing
 * ` *` (CLI 2.1.312 suggests `npm test *`) or `:*` (older CLIs, `npm test:*`) of a
 * prefix rule, which the card names as a prefix.
 */
function widensBeyondItsText(ruleContent: string): boolean {
  return prefixOf(ruleContent).includes('*')
}

/** A prefix rule's prefix (`npm test *` and `npm test:*` both give `npm test`), else the rule itself. */
function prefixOf(ruleContent: string): string {
  return ruleContent.replace(/(?: |:)\*$/, '')
}

/** The request's suggestions that are well formed allow updates; anything else is dropped. */
export function validSuggestions(raw: unknown): ClaudePermissionUpdate[] {
  if (!Array.isArray(raw)) return []
  const out: ClaudePermissionUpdate[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const u = s as Record<string, unknown>
    const destination = typeof u.destination === 'string' ? u.destination : 'session'
    if (u.type === 'addRules') {
      // Only rules that ALLOW: a remembering "allow" option must never write a deny or ask rule.
      if (u.behavior !== 'allow' || !Array.isArray(u.rules)) continue
      const rules = u.rules.filter(isRule).map((r) => (r.ruleContent !== undefined ? { toolName: r.toolName, ruleContent: r.ruleContent } : { toolName: r.toolName }))
      if (rules.length) out.push({ type: 'addRules', rules, behavior: 'allow', destination })
    } else if (u.type === 'addDirectories') {
      const directories = Array.isArray(u.directories) ? u.directories.filter((d): d is string => typeof d === 'string' && d.length > 0) : []
      if (directories.length) out.push({ type: 'addDirectories', directories, destination })
    } else if (u.type === 'setMode') {
      // A suggested mode only ever widens to edits; never let one switch to bypass.
      if (u.mode === 'acceptEdits') out.push({ type: 'setMode', mode: 'acceptEdits', destination })
    }
  }
  return out
}

/** File tools whose rule names a path: `//tmp/**` is the CLI's way to write the absolute `/tmp/**`. */
const PATH_RULE_VERBS: Record<string, string> = { Read: 'Read', Edit: 'Edit', Write: 'Write', MultiEdit: 'Edit', NotebookEdit: 'Edit' }

const EXACT_COMMAND = 'Bash: this exact command'

/** A rule for one part of a compound command, as the card and the row read it. */
const PART_OF_COMMAND = 'Part of this command: '
const PART_SUFFIX = ' (part of this command)'

function describeRule(r: { toolName: string; ruleContent?: string }, command?: string): string {
  // The command itself is on the card just above: a rule that is exactly it says so instead of repeating it.
  if (r.toolName === 'Bash' && command !== undefined && r.ruleContent === command) return EXACT_COMMAND
  if (r.toolName === 'Bash' && r.ruleContent !== undefined && prefixOf(r.ruleContent) !== r.ruleContent) return `Bash commands starting with ${prefixOf(r.ruleContent)}`
  const verb = PATH_RULE_VERBS[r.toolName]
  if (verb && r.ruleContent !== undefined) {
    const path = r.ruleContent.startsWith('//') ? r.ruleContent.slice(1) : r.ruleContent
    // "/tmp/**" is everything under the folder: said so, not as a glob.
    return path.endsWith('/**') ? `${verb} any file under ${homeShort(path.slice(0, -3))}` : `${verb} files in ${homeShort(path)}`
  }
  // A rule for one part of a compound command (`a && b`) says it covers only that part.
  if (r.toolName === 'Bash' && r.ruleContent !== undefined) {
    return command !== undefined && command.includes(r.ruleContent) ? `${PART_OF_COMMAND}${r.ruleContent}` : `Bash command: ${r.ruleContent}`
  }
  return r.ruleContent !== undefined ? `${r.toolName}(${r.ruleContent})` : `Every ${r.toolName} call`
}

function describeUpdate(u: ClaudePermissionUpdate, command?: string): string[] {
  if (u.type === 'setMode') return ['Auto-accept every file edit']
  // A folder added to the session's working folders, not a command: named as such.
  if ('directories' in u) return u.directories.map((d) => `Access to the folder ${homeShort(d)}`)
  return u.rules.map((r) => describeRule(r, command))
}

/** A path under the home folder reads from `~`: the long absolute form broke mid-name in a narrow card. */
function homeShort(p: string): string {
  const home = os.homedir()
  return home && home !== '/' && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p
}

/** A Bash rule in the request's suggestions that was dropped for its wildcard (widensBeyondItsText). */
function droppedWildcardRule(raw: unknown): boolean {
  return Array.isArray(raw) && raw.some((s) => {
    const u = s as { type?: unknown; behavior?: unknown; rules?: unknown } | null
    return !!u && u.type === 'addRules' && u.behavior === 'allow' && Array.isArray(u.rules) && u.rules.some((r) => {
      const rule = r as { toolName?: unknown; ruleContent?: unknown } | null
      return !!rule && rule.toolName === 'Bash' && typeof rule.ruleContent === 'string' && widensBeyondItsText(rule.ruleContent)
    })
  })
}

/**
 * The request's usable suggestions, and whether a Bash rule was held back for a "*".
 * A command with a "*" of its own (`ls *.txt`, `printf '%s\n' * | head -1`) offers no
 * Bash rule at all: the CLI reads every "*" in a rule as its wildcard, so a rule taken
 * from such a command (even one ending in " *", which reads as a prefix) would allow
 * more than the command the person is looking at.
 */
function requestSuggestions(request: ClaudePermissionAsk): { updates: ClaudePermissionUpdate[]; wildcard: boolean } {
  // A command's yes never switches the session's edit mode: CLI 2.1.312 suggests
  // "auto-accept every file edit" beside a Bash rule (`touch /tmp/a.txt`), which would ride
  // along unseen with "Allow for this session". A file tool's ask keeps it (its only choice).
  const all = validSuggestions(request.permission_suggestions).filter((u) => !(request.tool_name === 'Bash' && u.type === 'setMode'))
  const command = typeof request.input?.command === 'string' ? request.input.command : ''
  if (!command.includes('*')) return { updates: all, wildcard: droppedWildcardRule(request.permission_suggestions) }
  const updates: ClaudePermissionUpdate[] = []
  let dropped = droppedWildcardRule(request.permission_suggestions)
  for (const u of all) {
    if (u.type !== 'addRules') { updates.push(u); continue }
    const rules = u.rules.filter((r) => r.toolName !== 'Bash')
    if (rules.length < u.rules.length) dropped = true
    if (rules.length) updates.push({ ...u, rules })
  }
  return { updates, wildcard: dropped }
}

/** Why a command's own rule is not offered: said where the choice would otherwise be. */
const WILDCARD_NOTE_ALONE = "Can't be remembered: its * would match other commands"
const WILDCARD_NOTE_BESIDE = 'The command itself is not remembered: its * would match other commands'

/** One line per rule: a prompt can carry several, and every one of them is part of the grant. */
function describe(updates: ClaudePermissionUpdate[], command?: string): string {
  return updates.flatMap((u) => describeUpdate(u, command)).join('\n')
}

const SETTINGS_FILES: Record<string, string> = {
  localSettings: '.claude/settings.local.json',
  projectSettings: '.claude/settings.json',
  userSettings: '~/.claude/settings.json',
}

/** The updates a remembering option would keep in settings files (setMode is session-only). */
function persistentUpdates(updates: ClaudePermissionUpdate[]): ClaudePermissionUpdate[] {
  return updates.filter((u) => u.type !== 'setMode' && PERSISTENT_DESTINATIONS.has(u.destination))
}

/** The rules the CLI suggested for this session only (a folder it may read), kept beside the saved ones. */
function sessionOnlyUpdates(updates: ClaudePermissionUpdate[]): ClaudePermissionUpdate[] {
  return updates.filter((u) => u.type !== 'setMode' && !PERSISTENT_DESTINATIONS.has(u.destination))
}

/** A saved exact command this long is a one-off: kept in the project, it would almost never match again. */
const LONG_EXACT_RULE = 200

function onlyLongExactCommand(kept: ClaudePermissionUpdate[], command: string | undefined): boolean {
  return command !== undefined && command.length > LONG_EXACT_RULE
    && kept.every((u) => u.type === 'addRules' && u.rules.every((r) => r.toolName === 'Bash' && r.ruleContent === command))
}

/** A rule "Always allow" keeps only for this session (the CLI suggested no file for it). */
const THIS_SESSION_ONLY = 'this session only: '
/** Why a long command has no project choice, said where that choice would be. */
const LONG_COMMAND_NOTE = 'No "Always allow in this project": a command this long rarely runs again'

/**
 * The choices for one request, or undefined when it offers nothing beyond
 * Allow / Deny (no usable suggestion, a suppressed rule, or a tool with its own
 * prompt): the card then keeps its plain pair.
 */
export function claudePermissionChoices(request: ClaudePermissionAsk): PermissionChoice[] | undefined {
  if (!request.tool_name || OWN_PROMPT_TOOLS.has(request.tool_name)) return undefined
  if (request.suppress_always_allow_rule === true) return undefined
  const { updates, wildcard } = requestSuggestions(request)
  if (updates.length === 0) {
    // Nothing left to remember, and the person is told why rather than seeing the choices vanish.
    return wildcard ? [
      { optionId: CLAUDE_OPTION_ALLOW, kind: 'allow_once', name: 'Allow once', detail: WILDCARD_NOTE_ALONE },
      { optionId: CLAUDE_OPTION_DENY, kind: 'reject_once', name: 'Deny', takesNote: true },
    ] : undefined
  }
  const command = typeof request.input?.command === 'string' ? request.input.command : undefined
  const withNote = (detail: string) => (wildcard ? `${detail}\n${WILDCARD_NOTE_BESIDE}` : detail)
  // "once" beside the remembering choices, so the plain yes reads as the narrowest one.
  const kept = persistentUpdates(updates)
  const oneOff = kept.length > 0 && onlyLongExactCommand(kept, command)
  // Why there is no project choice is said about the whole prompt, above the choices (the plain yes's detail).
  const choices: PermissionChoice[] = [{ optionId: CLAUDE_OPTION_ALLOW, kind: 'allow_once', name: 'Allow once', ...(oneOff ? { detail: LONG_COMMAND_NOTE } : {}) }]
  choices.push({ optionId: CLAUDE_OPTION_SESSION, kind: 'allow_always', name: 'Allow for this session', detail: withNote(describe(updates, command)) })
  if (kept.length && !oneOff) {
    const inProject = kept.every((u) => u.destination !== 'userSettings')
    const files = [...new Set(kept.map((u) => SETTINGS_FILES[u.destination]).filter(Boolean))]
    // The same rules as "Allow for this session": the saved ones, and those the CLI keeps to this session, marked so.
    const sessionLines = sessionOnlyUpdates(updates).flatMap((u) => describeUpdate(u, command)).map((l) => `Also, for ${THIS_SESSION_ONLY}${l.charAt(0).toLowerCase()}${l.slice(1)}`)
    choices.push({
      optionId: CLAUDE_OPTION_ALWAYS, kind: 'allow_always', name: inProject ? 'Always allow in this project' : 'Always allow',
      detail: withNote([describe(kept, command), ...sessionLines].join('\n')), ...(files.length ? { savedTo: files.join(', ') } : {}),
    })
  }
  choices.push({ optionId: CLAUDE_OPTION_DENY, kind: 'reject_once', name: 'Deny', takesNote: true })
  return choices
}

/** What an answer with `optionId` tells the CLI, or null when the request never offered that option. */
export function claudeChoiceResponse(
  request: ClaudePermissionAsk,
  optionId: string,
): { allow: boolean; updatedPermissions?: ClaudePermissionUpdate[] } | null {
  const offered = claudePermissionChoices(request)
  // Allow and Deny are always answerable, with or without a built list.
  if (optionId === CLAUDE_OPTION_ALLOW) return { allow: true }
  if (optionId === CLAUDE_OPTION_DENY) return { allow: false }
  if (!offered?.some((c) => c.optionId === optionId)) return null
  const { updates } = requestSuggestions(request)
  if (optionId === CLAUDE_OPTION_SESSION) {
    return { allow: true, updatedPermissions: updates.map((u) => ({ ...u, destination: 'session' })) }
  }
  if (optionId === CLAUDE_OPTION_ALWAYS) {
    // Exactly the rules its label names, each where the CLI suggested keeping it (saved, or this session).
    return { allow: true, updatedPermissions: updates.filter((u) => u.type !== 'setMode') }
  }
  return null
}

/** A can_use_tool request as the session keeps it while it waits for the person. */
export interface ClaudeCanUseToolRequest extends ClaudePermissionAsk {
  subtype: string
  input?: Record<string, unknown>
  tool_use_id?: string
  decision_reason?: string
}

/** The request part of a SESSION_PERMISSION_REQUEST event (every emit site shares it). */
export function permissionEventFields(requestId: string, request: ClaudeCanUseToolRequest): {
  requestId: string; toolName?: string; input?: Record<string, unknown>; reason?: string; acpOptions?: PermissionChoice[]; toolUseId?: string
} {
  const acpOptions = claudePermissionChoices(request)
  return {
    requestId,
    toolName: request.tool_name,
    input: request.input,
    reason: request.decision_reason,
    ...(acpOptions ? { acpOptions } : {}),
    // The call it gates: the timeline marks that row as waiting, not done.
    ...(request.tool_use_id ? { toolUseId: request.tool_use_id } : {}),
  }
}

/** The session record's copy of a pending request: enough to offer the same choices after a restart. */
export function pendingPermissionRecordFields(requestId: string, request: ClaudeCanUseToolRequest): {
  requestId: string; toolName?: string; input?: Record<string, unknown>; reason?: string; subtype: string
  acpOptions?: PermissionChoice[]; permissionSuggestions?: unknown[]; suppressAlwaysAllowRule?: boolean
} {
  const { acpOptions, ...rest } = permissionEventFields(requestId, request)
  return {
    ...rest,
    subtype: request.subtype,
    ...(acpOptions ? { acpOptions } : {}),
    ...(Array.isArray(request.permission_suggestions) && request.permission_suggestions.length ? { permissionSuggestions: request.permission_suggestions } : {}),
    ...(request.suppress_always_allow_rule === true ? { suppressAlwaysAllowRule: true } : {}),
  }
}

const DENY_NOTE_PREFIX = 'The user denied this tool call and said: '

/**
 * The deny a person's new message gives an open prompt, as the server passes it
 * along (isUserDenied, old transcripts and the decision line read it by this start).
 * The agent is sent the CLI's own "STOP and wait" rejection instead (cliDenyMessage):
 * a tool result in our words telling it to end its turn read to the model as an
 * injected instruction, and it retried the call. The message itself is the next turn.
 */
export const MESSAGE_DENIES_PROMPT = 'User sent a new message \u2014 permission auto-denied'

/** The CLI's own rejection words (CLI 2.1.312): the model is trained to stop on them and follow what the user says next. */
const CLI_REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
/**
 * A person's new message denied it: the CLI's own words for a rejection the person makes
 * at its prompt. The message reaches the agent only as its next turn, so wording that
 * says "a message follows" drew "no message came through", and "do not reply" a turn
 * with no text, which the CLI answers with its own "no visible output" nudge.
 */
export const CLI_DENY_FOR_MESSAGE = `${CLI_REJECTED} STOP what you are doing and wait for the user to tell you how to proceed.`
export const CLI_DENY_WITH_NOTE = `${CLI_REJECTED} To tell you how to proceed, the user said:\n`

/**
 * The deny message as the CLI is sent it. A client sends a note as
 * `The user denied this tool call and said: <note>` (web, iOS, older apps alike);
 * the agent reads it in the CLI's own rejection form, which it follows more
 * reliably than a sentence of ours. A person's new message says that message comes
 * next. Any other message goes as it is.
 */
export function cliDenyMessage(message: string | undefined): string {
  if (!message) return 'User denied permission'
  if (message.startsWith(MESSAGE_DENIES_PROMPT)) return CLI_DENY_FOR_MESSAGE
  return message.startsWith(DENY_NOTE_PREFIX) ? `${CLI_DENY_WITH_NOTE}${message.slice(DENY_NOTE_PREFIX.length).trim()}` : message
}

/** How many answers a session record keeps (promptAnswerLines): the newest ones, which the timeline shows. */
export const PERMISSION_DECISIONS_KEPT = 40

/** The record's decision list with one more answer: the same call answered again replaces its line. */
export function withPermissionDecision(
  list: ReadonlyArray<{ toolUseId: string; line: string }> | undefined, toolUseId: string, line: string,
): Array<{ toolUseId: string; line: string }> {
  return [...(list ?? []).filter((d) => d.toolUseId !== toolUseId), { toolUseId, line: line.slice(0, 200) }].slice(-PERMISSION_DECISIONS_KEPT)
}

/** What a decision line names: the command itself, the file, or the tool. */
function decisionSubject(toolName: string, input?: Record<string, unknown>): string {
  const cut = (t: string) => (t.length > 80 ? `${t.slice(0, 79)}\u2026` : t)
  const command = typeof input?.command === 'string' ? input.command.trim() : ''
  if (command) {
    const first = command.split('\n')[0]
    return cut(first === command ? first : `${first} \u2026`)
  }
  const file = typeof input?.file_path === 'string' ? input.file_path : typeof input?.notebook_path === 'string' ? input.notebook_path : undefined
  return file ? `${toolName} ${cut(homeShort(file))}` : toolName
}

/**
 * The line a decision leaves on the call's row: which choice, in the card's own
 * words, and what it was for (the command, the rule a remembering one kept, the
 * note a deny carried).
 */
export function permissionDecisionLine(
  toolName: string, allow: boolean, updatedPermissions?: ClaudePermissionUpdate[], denyMessage?: string, answers?: unknown, input?: Record<string, unknown>,
): string {
  const note = !allow && denyMessage?.startsWith(DENY_NOTE_PREFIX) ? denyMessage.slice(DENY_NOTE_PREFIX.length).trim() : ''
  // A question and a plan are answered, not permitted: the line says what was said.
  if (toolName === 'AskUserQuestion') {
    if (!allow) {
      if (denyMessage?.startsWith(MESSAGE_DENIES_PROMPT)) return 'Dismissed by your message'
      const asked = Array.isArray(input?.questions) ? input.questions.length : 0
      return asked === 1 ? 'Question dismissed' : 'Questions dismissed'
    }
    const said = answers && typeof answers === 'object' ? Object.values(answers as Record<string, unknown>).filter((a): a is string => typeof a === 'string' && a.length > 0) : []
    return said.length ? `Answered: ${said.join('; ')}` : 'Answered'
  }
  if (toolName === 'ExitPlanMode') return allow ? 'Plan approved' : note ? `Plan rejected with note: \u201C${note}\u201D` : 'Plan rejected'
  const subject = decisionSubject(toolName, input)
  if (!allow && denyMessage?.startsWith(MESSAGE_DENIES_PROMPT)) return `Denied by your message: ${subject}`
  // The command first, then the note: a row of answers is scanned by what was denied.
  // The note leads: what the person said is what the row is read for.
  if (!allow) return note ? `Denied with note \u201C${note}\u201D: ${subject}` : `Denied: ${subject}`
  if (!updatedPermissions?.length) return `Allowed once: ${subject}`
  const command = typeof input?.command === 'string' ? input.command : undefined
  // The rule that is the command itself reads as that command (the card said "this exact command").
  // So does a rule for a part of it: the row names what ran, the card named the part.
  const rulesOf = (updates: ClaudePermissionUpdate[]) =>
    [...new Set(describe(updates, command).split('\n').map((r) => (r === EXACT_COMMAND ? subject
      // A rule for one part names that part: the line never reads as the whole command kept.
      : r.startsWith(PART_OF_COMMAND) ? `${decisionSubject('Bash', { command: r.slice(PART_OF_COMMAND.length) })}${PART_SUFFIX}` : r)))].join(', ')
  const kept = updatedPermissions.filter((u) => u.destination !== 'session')
  if (!kept.length) return `Allowed for this session: ${rulesOf(updatedPermissions)}`
  const head = kept.some((u) => u.destination === 'userSettings') ? 'Always allowed' : 'Always allowed in this project'
  // What was kept only for this session says so: the line never claims a file holds it.
  const forSession = updatedPermissions.filter((u) => u.destination === 'session')
  return forSession.length ? `${head}: ${rulesOf(kept)}; ${THIS_SESSION_ONLY}${rulesOf(forSession)}` : `${head}: ${rulesOf(kept)}`
}

/**
 * The files a choice's rules are written to, for a session on this host: the CLI
 * writes them after it reads the answer, so a file it cannot write is found first.
 */
export function settingsFilesOf(updates: ClaudePermissionUpdate[], cwd: string, configDir: string): Array<{ path: string; shown: string }> {
  const at: Record<string, string> = {
    localSettings: `${cwd}/.claude/settings.local.json`,
    projectSettings: `${cwd}/.claude/settings.json`,
    userSettings: `${configDir}/settings.json`,
  }
  const seen = new Set<string>()
  return updates.flatMap((u) => {
    const path = u.type !== 'setMode' ? at[u.destination ?? ''] : undefined
    if (!path || seen.has(path)) return []
    seen.add(path)
    return [{ path, shown: SETTINGS_FILES[u.destination!] }]
  })
}

/** A rule kept in a file this host cannot write: the answer is held, so nothing claims it was saved. */
export class PermissionSaveError extends Error {
  constructor(readonly file: string, why: 'not-writable' | 'not-json' = 'not-writable') {
    super(why === 'not-json'
      ? `Could not save the rule: ${file} is not valid JSON. Fix the file, or allow once or for this session instead.`
      : `Could not save the rule: ${file} cannot be written. Allow once or for this session instead.`)
    this.name = 'PermissionSaveError'
  }
}

/** An answer named an option this request never offered (a stale or forged id). */
export class UnknownPermissionOptionError extends Error {
  constructor(readonly optionId: string) {
    super(`Unknown permission option: ${optionId}`)
    this.name = 'UnknownPermissionOptionError'
  }
}

/** The session record's pending copy back as the request it was (restart recovery, Layer 2). */
export function requestFromPendingRecord(pp: {
  subtype?: string; toolName?: string; input?: Record<string, unknown>; reason?: string
  permissionSuggestions?: unknown[]; suppressAlwaysAllowRule?: boolean; toolUseId?: string
}): ClaudeCanUseToolRequest {
  return {
    subtype: pp.subtype ?? 'can_use_tool',
    tool_name: pp.toolName,
    input: pp.input,
    decision_reason: pp.reason,
    // The CLI's suggested rules: the remembering choices are rebuilt from them.
    ...(pp.permissionSuggestions ? { permission_suggestions: pp.permissionSuggestions } : {}),
    ...(pp.suppressAlwaysAllowRule ? { suppress_always_allow_rule: true } : {}),
    // The call it gates, so after a restart its row still reads as waiting and its answer is recorded.
    ...(pp.toolUseId ? { tool_use_id: pp.toolUseId } : {}),
  }
}

/** Where a remembered Bash rule lives: this session, the project's settings, or the person's own. */
export type BashRuleScope = 'session' | 'project' | 'user'

/** A remembered rule's scope from the destination it was kept in. */
export function scopeOfDestination(destination: string): BashRuleScope {
  return destination === 'userSettings' ? 'user' : PERSISTENT_DESTINATIONS.has(destination) ? 'project' : 'session'
}

/**
 * Does this Bash rule let the CLI run the command without asking? The CLI's own two
 * forms: a prefix rule (`npm test *`, `npm test:*`) covers the prefix alone or followed
 * by more words; any other rule covers exactly its text. A compound command the CLI
 * checks part by part is not judged here (no line rather than a wrong one).
 */
/**
 * The simple commands of a compound one (`a && b | c; d`), split where the shell would
 * outside quotes: the CLI asks, and remembers, part by part.
 */
export function bashCommandParts(command: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      cur += ch
      if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') { parts.push(cur); cur = ''; i++; continue }
    if (ch === ';' || ch === '|' || ch === '\n') { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

export function bashRuleCovers(ruleContent: string, command: string): boolean {
  const prefix = prefixOf(ruleContent)
  if (prefix !== ruleContent) return command === prefix || command.startsWith(`${prefix} `)
  return command === ruleContent
}

/** The Bash rules in a settings file's allow list (`Bash(npm test *)`, parentheses escaped as the CLI writes them). */
export function settingsBashRules(text: string): string[] {
  try {
    const allow = (JSON.parse(text) as { permissions?: { allow?: unknown } })?.permissions?.allow
    if (!Array.isArray(allow)) return []
    return allow.flatMap((a) => {
      const m = typeof a === 'string' ? /^Bash\(([\s\S]+)\)$/.exec(a) : null
      return m ? [m[1].replace(/\\([()\\])/g, '$1')] : []
    })
  } catch { return [] }
}

/** The line a call run under a remembered rule leaves on its row ("Allowed by session rule: npm test"). */
export function ruleAllowedLine(scope: BashRuleScope, ruleContent: string, command: string): string {
  const which = scope === 'session' ? 'Allowed by session rule' : scope === 'project' ? 'Allowed by project rule' : 'Allowed by your rule'
  const prefix = prefixOf(ruleContent)
  const what = prefix !== ruleContent ? `Bash commands starting with ${prefix}`
    // A rule for one part of a compound command names that part, as the grant's own line does.
    : ruleContent !== command && command.includes(ruleContent) ? `${decisionSubject('Bash', { command: ruleContent })}${PART_SUFFIX}`
      : decisionSubject('Bash', { command })
  return `${which}: ${what}`
}
