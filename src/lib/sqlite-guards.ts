/**
 * Two things better-sqlite3 refused that bun:sqlite accepts without a word,
 * refused again by src/lib/sqlite.ts: a prepare() of more than one statement
 * (bun prepares the first and drops the rest), and a transaction function that
 * returns a promise (bun commits when it returns).
 *
 * The scan is SQLite's own sqlite3_complete() state machine (complete.c),
 * which knows where a statement ends: not at a `;` inside a string, a quoted
 * name, a comment, or the body of a CREATE TRIGGER. What may follow the first
 * statement is what better-sqlite3 allowed: whitespace, comments and more `;`.
 */

// Token classes, in complete.c's order.
const SEMI = 0
const WS = 1
const OTHER = 2
const EXPLAIN = 3
const CREATE = 4
const TEMP = 5
const TRIGGER = 6
const END = 7

// States: 0 INVALID, 1 START, 2 NORMAL, 3 EXPLAIN, 4 CREATE, 5 TRIGGER, 6 SEMI, 7 END.
// trans[state][token], copied from complete.c (triggers compiled in).
const TRANS: readonly (readonly number[])[] = [
  /* 0 INVALID */ [1, 0, 2, 3, 4, 2, 2, 2],
  /* 1 START   */ [1, 1, 2, 3, 4, 2, 2, 2],
  /* 2 NORMAL  */ [1, 2, 2, 2, 2, 2, 2, 2],
  /* 3 EXPLAIN */ [1, 3, 3, 2, 4, 2, 2, 2],
  /* 4 CREATE  */ [1, 4, 2, 2, 2, 4, 5, 2],
  /* 5 TRIGGER */ [6, 5, 5, 5, 5, 5, 5, 5],
  /* 6 SEMI    */ [6, 6, 5, 5, 5, 5, 5, 7],
  /* 7 END     */ [1, 7, 5, 5, 5, 5, 5, 5],
]

const KEYWORDS: Record<string, number> = {
  create: CREATE, trigger: TRIGGER, temp: TEMP, temporary: TEMP, end: END, explain: EXPLAIN,
}

/** An identifier character as SQLite's tokenizer sees it (IdChar): ASCII word chars, `$`, and any non-ASCII. */
function isIdChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36 || code >= 0x80
}

/** The next token of `sql` at `i`: its class and where it ends. */
function nextToken(sql: string, i: number): [number, number] {
  const c = sql[i]
  if (c === ';') return [SEMI, i + 1]
  if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') return [WS, i + 1]
  if (c === '/' && sql[i + 1] === '*') {
    const end = sql.indexOf('*/', i + 2)
    return [WS, end < 0 ? sql.length : end + 2]
  }
  if (c === '-' && sql[i + 1] === '-') {
    const end = sql.indexOf('\n', i + 2)
    return [WS, end < 0 ? sql.length : end + 1]
  }
  if (c === '[') {
    const end = sql.indexOf(']', i + 1)
    return [OTHER, end < 0 ? sql.length : end + 1]
  }
  if (c === '`' || c === '"' || c === "'") {
    // A doubled quote closes this token and opens the next one: both are OTHER.
    const end = sql.indexOf(c, i + 1)
    return [OTHER, end < 0 ? sql.length : end + 1]
  }
  if (isIdChar(sql.charCodeAt(i))) {
    let j = i + 1
    while (j < sql.length && isIdChar(sql.charCodeAt(j))) j++
    return [KEYWORDS[sql.slice(i, j).toLowerCase()] ?? OTHER, j]
  }
  return [OTHER, i + 1]
}

/** True when `sql` holds a second statement after its first one ends. */
export function hasSecondStatement(sql: string): boolean {
  let state = 0
  let sawStatement = false
  for (let i = 0; i < sql.length;) {
    const [token, end] = nextToken(sql, i)
    i = end
    if (token === WS || token === SEMI) {
      state = TRANS[state][token]
      continue
    }
    // A token that starts a statement after a complete one.
    if (state === 1 && sawStatement) return true
    state = TRANS[state][token]
    sawStatement = true
  }
  return false
}

/** better-sqlite3's error for a prepare() of more than one statement. */
export function moreThanOneStatement(): RangeError {
  return new RangeError('The supplied SQL string contains more than one statement')
}

/**
 * Refuse a second statement, as better-sqlite3 did: bun would prepare the
 * first and drop the rest without a word. Most SQL strings are literals seen
 * again and again, so the ones already checked are remembered (bounded).
 */
const singleStatements = new Set<string>()
export function checkOneStatement(source: string): void {
  if (singleStatements.has(source)) return
  if (hasSecondStatement(source)) throw moreThanOneStatement()
  if (singleStatements.size >= 4096) singleStatements.clear()
  singleStatements.add(source)
}

/**
 * better-sqlite3 refuses a transaction function that returns a promise: the
 * transaction commits when the function returns, so whatever it does after its
 * first await runs outside it. bun commits and says nothing. Thrown inside the
 * transaction, so it rolls back as for any throw.
 */
export function refusePromise<F extends (...args: never[]) => unknown>(fn: F): F {
  return function guarded(this: unknown, ...args: Parameters<F>) {
    const result = fn.apply(this, args)
    if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      throw new TypeError('Transaction function cannot return a promise')
    }
    return result
  } as F
}
