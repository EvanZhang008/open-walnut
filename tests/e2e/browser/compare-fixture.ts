/**
 * The Changed tab's compare fixture (diff-compare.spec.ts, PW_COMPARE_FIXTURE=1):
 * a real git repository on a feature branch, so the "Branch vs main", any-branch
 * and single-commit comparisons, the Viewed marks and Ignore whitespace run on
 * real git, through the server's own in-process git path.
 *
 *   main:     Initial project → Add the formatter → Document the CLI (pushed)
 *             → Bump the version on main (pushed after the branch left)
 *   feature/parser-errors (from "Document the CLI", checked out):
 *             Parse errors carry line numbers   (src/parser.ts)
 *             Reindent the formatter            (src/format.ts, whitespace only)
 *             Add parser tests                  (test/parser.test.ts)
 *             Rename the guide to usage         (docs/guide.md → docs/usage.md)
 *   other branches: experiment/cache (local), origin/release/1.x (remote only)
 *   working tree: src/index.ts edited by the session (its JSONL records the
 *             Edit), notes/todo.md untracked
 *
 * Everything lives under the fixture's temp HOME; nothing here touches the
 * developer's repositories (asserted before every git run).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const COMPARE_SESSION_ID = 'pw-compare-session'
export const COMPARE_TASK_ID = 'pw-task-compare'

export function compareFixtureTask(): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    id: COMPARE_TASK_ID,
    title: 'Compare fixture task',
    status: 'in_progress',
    phase: 'IN_PROGRESS',
    priority: 'none',
    project: 'Walnut',
    source: 'local',
    session_ids: [COMPARE_SESSION_ID],
    active_session_ids: [],
    session_id: COMPARE_SESSION_ID,
    session_status: { process_status: 'stopped', mode: 'bypass' },
    created_at: now,
    updated_at: now,
    description: '',
    summary: '',
    note: '',
    subtasks: [],
  }
}

const PARSER_V1 = `export interface Token { kind: string; text: string }

export function parse(source: string): Token[] {
  const tokens: Token[] = []
  for (const word of source.split(/\\s+/)) {
    if (!word) continue
    tokens.push({ kind: classify(word), text: word })
  }
  return tokens
}

function classify(word: string): string {
  if (/^\\d+$/.test(word)) return 'number'
  if (/^[a-z_]\\w*$/i.test(word)) return 'name'
  throw new Error('unexpected token ' + word)
}
`

const PARSER_V2 = `export interface Token { kind: string; text: string; line: number }

export class ParseError extends Error {
  constructor(message: string, public line: number) {
    super(message + ' (line ' + line + ')')
  }
}

export function parse(source: string): Token[] {
  const tokens: Token[] = []
  source.split('\\n').forEach((text, i) => {
    for (const word of text.split(/\\s+/)) {
      if (!word) continue
      tokens.push({ kind: classify(word, i + 1), text: word, line: i + 1 })
    }
  })
  return tokens
}

function classify(word: string, line: number): string {
  if (/^\\d+$/.test(word)) return 'number'
  if (/^[a-z_]\\w*$/i.test(word)) return 'name'
  throw new ParseError('unexpected token ' + word, line)
}
`

const FORMAT_TABS = [
  "import type { Token } from './parser'",
  '',
  'export function format(tokens: Token[]): string {',
  '\tconst out: string[] = []',
  '\tfor (const t of tokens) {',
  "\t\tif (t.kind === 'number') out.push(String(Number(t.text)))",
  '\t\telse out.push(t.text)',
  '\t}',
  "\treturn out.join(' ')",
  '}',
  '',
].join('\n')
const FORMAT_SPACES = FORMAT_TABS.replace(/^\t+/gm, (tabs) => '  '.repeat(tabs.length))

const INDEX_V1 = `import { parse } from './parser'
import { format } from './format'

export function run(input: string): string {
  return format(parse(input))
}
`
const INDEX_SESSION_OLD = `export function run(input: string): string {
  return format(parse(input))
}`
const INDEX_SESSION_NEW = `export function run(input: string): string {
  const tokens = parse(input)
  if (tokens.length === 0) return ''
  return format(tokens)
}`

const GUIDE = `# Guide

Run \`atlas format <file>\` to reformat a file.
Numbers are normalised; names are kept as written.
`

export async function buildCompareFixture(tmpBase: string): Promise<{ repo: string; session: Record<string, unknown> }> {
  const base = path.join(tmpBase, 'projects', 'compare-fixture')
  const repo = path.join(base, 'atlas-app')
  const remote = path.join(base, 'origin.git')
  const inBase = (p: string) => {
    if (!path.resolve(p).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error('compare fixture outside the temp dir: ' + p)
    return p
  }
  fs.mkdirSync(inBase(repo), { recursive: true })
  fs.mkdirSync(inBase(remote), { recursive: true })
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmpBase, GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') && k !== 'GIT_CONFIG_NOSYSTEM') delete env[k]
  let clock = Math.floor(Date.now() / 1000) - 6 * 3600
  const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Riley Park', '-c', 'user.email=riley@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: inBase(cwd), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (rel: string, body: string) => {
    const p = inBase(path.join(repo, rel))
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  const commit = (message: string) => {
    clock += 37 * 60
    const date = `${clock} +0000`
    git(repo, 'add', '-A')
    execFileSync('git', ['-c', 'user.name=Riley Park', '-c', 'user.email=riley@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message], {
      cwd: repo, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  git(remote, 'init', '-q', '--bare')
  git(repo, 'init', '-q')
  write('package.json', JSON.stringify({ name: 'atlas-app', version: '0.3.0', type: 'module' }, null, 2) + '\n')
  write('src/parser.ts', PARSER_V1)
  write('src/index.ts', INDEX_V1)
  write('README.md', '# atlas-app\n\nA tiny tokenizer and formatter.\n')
  commit('Initial project')
  write('src/format.ts', FORMAT_TABS)
  commit('Add the formatter')
  write('docs/guide.md', GUIDE)
  commit('Document the CLI')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  git(repo, 'branch', 'release/1.x')
  git(repo, 'push', '-q', 'origin', 'release/1.x')
  git(repo, 'branch', '-D', 'release/1.x')
  git(repo, 'branch', 'experiment/cache')

  git(repo, 'checkout', '-q', '-b', 'feature/parser-errors')
  write('src/parser.ts', PARSER_V2)
  commit('Parse errors carry line numbers')
  write('src/format.ts', FORMAT_SPACES)
  commit('Reindent the formatter')
  write('test/parser.test.ts', "import { parse } from '../src/parser'\n\nconst tokens = parse('a 1\\nb 2')\nif (tokens[2]!.line !== 2) throw new Error('line numbers')\n")
  commit('Add parser tests')
  git(repo, 'mv', 'docs/guide.md', 'docs/usage.md')
  commit('Rename the guide to usage')

  // main moves on after the branch left: never part of "Branch vs main".
  git(repo, 'checkout', '-q', 'main')
  write('package.json', JSON.stringify({ name: 'atlas-app', version: '0.4.0', type: 'module' }, null, 2) + '\n')
  commit('Bump the version on main')
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'remote', 'set-head', 'origin', 'main')
  git(repo, 'checkout', '-q', 'feature/parser-errors')

  // The session's own edit (also uncommitted), and a stray untracked note.
  write('src/index.ts', INDEX_V1.replace(INDEX_SESSION_OLD, INDEX_SESSION_NEW))
  write('notes/todo.md', '- [ ] handle negative numbers\n')

  const jsonlDir = path.join(tmpBase, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(inBase(jsonlDir), { recursive: true })
  const t0 = Date.now() - 60_000
  fs.writeFileSync(path.join(jsonlDir, `${COMPARE_SESSION_ID}.jsonl`), [
    JSON.stringify({ type: 'user', sessionId: COMPARE_SESSION_ID, cwd: repo, timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'Return early on empty input.' } }),
    JSON.stringify({
      type: 'assistant', sessionId: COMPARE_SESSION_ID, cwd: repo, timestamp: new Date(t0 + 5_000).toISOString(),
      message: { role: 'assistant', content: [
        { type: 'text', text: 'Adding the early return.' },
        { type: 'tool_use', id: 'toolu_pw_compare_1', name: 'Edit', input: { file_path: path.join(repo, 'src/index.ts'), old_string: INDEX_SESSION_OLD, new_string: INDEX_SESSION_NEW } },
      ] },
    }),
    '',
  ].join('\n'))

  const now = new Date().toISOString()
  return {
    repo,
    session: {
      claudeSessionId: COMPARE_SESSION_ID,
      taskId: COMPARE_TASK_ID,
      project: 'Walnut',
      process_status: 'stopped',
      mode: 'bypass',
      last_status_change: now,
      startedAt: new Date(t0).toISOString(),
      lastActiveAt: now,
      messageCount: 2,
      cwd: repo,
      title: 'Compare fixture session',
    },
  }
}
