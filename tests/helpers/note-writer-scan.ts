/**
 * Finds every function in a source file that changes a file in the notes vault, over the TypeScript
 * AST (comments and strings never count). Used by tests/core/notes/locked-note-writers-guard.test.ts.
 *
 * A "function" is a named one: a function declaration, a method, a function assigned to a name or a
 * property, or a route handler (`router.post('/x', async (req, res) => ...)`). A callback passed to
 * another call (`withUserFileLock(file, async () => ...)`, `.map(async (f) => ...)`) is part of the
 * function it is written in. A nested named function sees the paths its outer one built (a closure).
 *
 * A function is a writer when it changes a file (MUTATIONS, or a function of the same file that
 * does) and builds a vault path (VAULT_PATH_CALLS, VAULT_PATH_NAMES) or lives in a module whose
 * routes act on any path a client names. It checks when it calls a lock check (CHECKS) or a
 * function of the same file that does.
 */
import ts from 'typescript'

/**
 * Calls that build a path in the notes vault (src/core/notes/note-paths.ts, and the protected-note
 * stores' noteFileOf in protected-note-file.ts), where a person may lock or hide a note.
 */
export const VAULT_PATH_CALLS = new Set(['notesRoot', 'resolveNotePath', 'noteAbs', 'noteAbsIn', 'realNoteFile', 'ensureRealNoteDir', 'realNotesRoot', 'noteFileOf'])
/** The vault's default folder, as a value (src/constants.ts). */
export const VAULT_PATH_NAMES = new Set(['NOTES_DIR'])
/** File system calls that change a file, and the repo's own write helpers. */
export const MUTATIONS = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync', 'rm', 'rmSync',
  'unlink', 'unlinkSync', 'cp', 'cpSync', 'copyFile', 'copyFileSync', 'createWriteStream',
  'replaceAtomically', 'createExclusively', 'writeFileAtomic', 'writeTextFile',
])
/**
 * The checks for a locked AND a hidden note (src/core/notes/locked-note.ts and locked-note-moves.ts),
 * and the notes route's guarded write. A lock-only test (looksLockedNoteText, isLockedNoteText,
 * hasLockMark) is no check here: a writer that uses one lets anyone write a hidden note.
 */
export const CHECKS = new Set([
  'assertNotLocked', 'assertNotLockedText', 'assertFileNotLocked', 'looksProtectedNoteText', 'noteProtection',
  'fileLooksLocked', 'fileProtection', 'firstLockedNote', 'assertLockedNoteMove', 'assertLockedNoteDelete',
  'assertNoLockedNoteCopy', 'writeNoteContent',
])
/** The store lock, kept beside the file: never for a note (src/utils/user-file-lock.ts). */
export const STORE_LOCKS = new Set(['withFileLock', 'withFileLockSync'])

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use'])

export interface NoteWriter {
  /** `outer/inner` for a nested function; a route handler is `post /path`. */
  name: string
  /** What it changes files with (`fsp.rename` is `rename`, a same-file helper is `helper()`). */
  mutations: string[]
  checks: boolean
  /** It takes withFileLock and writes the file itself, never under withUserFileLock. */
  storeLock: boolean
}

interface Unit {
  name: string
  short: string
  parent: Unit | null
  builds: boolean
  mutations: Set<string>
  checks: boolean
  storeLock: boolean
  userLock: boolean
  calls: Set<string>
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return null
}

function propName(name: ts.PropertyName | undefined): string | null {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text
  return null
}

/** The name a node starts a function under, or null when it is no function or only a callback. */
function unitName(node: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? 'default'
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) return propName(node.name) ?? 'method'
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return null
  const p = node.parent
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return propName(p.name) ?? 'property'
  if (ts.isCallExpression(p) && p.arguments.includes(node as ts.Expression) && ts.isPropertyAccessExpression(p.expression)
    && ROUTE_METHODS.has(p.expression.name.text) && p.arguments[0] && p.arguments[0] !== node
    && (ts.isStringLiteral(p.arguments[0]) || ts.isTemplateExpression(p.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(p.arguments[0]))) {
    return `${p.expression.name.text} ${p.arguments[0].getText(sf).slice(1, -1)}`
  }
  return null
}

/** Every function of a file, with what it builds, changes, checks and calls (same-file helpers folded in). */
function scanUnits(file: string, text: string): Unit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
  const units: Unit[] = []
  const make = (name: string, short: string, parent: Unit | null): Unit => {
    const u: Unit = { name, short, parent, builds: false, mutations: new Set(), checks: false, storeLock: false, userLock: false, calls: new Set() }
    units.push(u)
    return u
  }
  const visit = (node: ts.Node, at: Unit): void => {
    const name = unitName(node, sf)
    if (name) at = make(at.parent ? `${at.name}/${name}` : name, name, at)
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression)
      if (callee) {
        at.calls.add(callee)
        if (VAULT_PATH_CALLS.has(callee)) at.builds = true
        if (MUTATIONS.has(callee)) at.mutations.add(callee)
        if (CHECKS.has(callee)) at.checks = true
        if (STORE_LOCKS.has(callee)) at.storeLock = true
        if (callee === 'withUserFileLock') at.userLock = true
      }
    } else if (ts.isIdentifier(node) && VAULT_PATH_NAMES.has(node.text) && !ts.isImportSpecifier(node.parent)) {
      at.builds = true
    }
    ts.forEachChild(node, (child) => visit(child, at))
  }
  const moduleUnit = make('<module>', '<module>', null)
  ts.forEachChild(sf, (child) => visit(child, moduleUnit))

  // Same-file helpers: a function that calls one that checks checks, one that calls one that writes writes.
  for (let changed = true; changed;) {
    changed = false
    const checkers = new Set(units.filter((u) => u.checks).map((u) => u.short))
    const writers = new Set(units.filter((u) => u.mutations.size > 0).map((u) => u.short))
    for (const u of units) {
      for (const c of u.calls) {
        if (c === u.short) continue
        if (!u.checks && checkers.has(c)) { u.checks = true; changed = true }
        if (writers.has(c) && !u.mutations.has(`${c}()`)) { u.mutations.add(`${c}()`); changed = true }
      }
    }
  }
  return units
}

const builds = (u: Unit | null): boolean => !!u && (u.builds || builds(u.parent))

/** The functions of a file that change a file in the vault (see the file comment). */
export function findNoteWriters(file: string, text: string, opts: { clientPaths?: boolean } = {}): NoteWriter[] {
  return scanUnits(file, text)
    .filter((u) => u.mutations.size > 0 && (opts.clientPaths || builds(u)))
    .map((u) => ({
      name: u.name,
      mutations: [...u.mutations].sort(),
      checks: u.checks,
      // The store lock on the note itself: it writes there directly and never takes the person's lock.
      storeLock: u.storeLock && !u.userLock && [...u.mutations].some((m) => !m.endsWith('()')),
    }))
}

/** The functions of a file that call `name`, and whether each checks the lock. */
export function findCallers(file: string, text: string, name: string): Array<{ name: string; checks: boolean }> {
  return scanUnits(file, text).filter((u) => u.calls.has(name) && u.short !== name).map((u) => ({ name: u.name, checks: u.checks }))
}
