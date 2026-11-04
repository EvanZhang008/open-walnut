#!/usr/bin/env node
/**
 * A stand-in for the GitHub CLI, for test and demo servers (WALNUT_GH_BIN): it answers only
 * `gh api graphql -f query=...` the way GitHub does, from files, and never reaches the network.
 *
 *   $WALNUT_FAKE_GH_DIR/<owner>__<name>__<number>.json   a pull request node, as GitHub's GraphQL
 *                                                        returns it (see providers.ts githubQuery)
 *   $WALNUT_FAKE_GH_DIR/viewer.json                      {"login": "..."} (default "walnut-dev")
 *   $WALNUT_FAKE_GH_DIR/signed-out                       present: answer every call as a signed-out gh
 *   $WALNUT_FAKE_GH_DIR/signed-out.<owner>__<name>       the same, only for a call asking for nothing
 *                                                        but such repositories (specs sharing a server
 *                                                        each sign out their own; a batched read that
 *                                                        also asks for another spec's is answered)
 *   $WALNUT_FAKE_GH_DIR/calls.log                        one line per call (the aliases asked)
 *
 * A pull request with no file answers NOT_FOUND for its alias and exits 1 with the rest printed,
 * as gh does. The directory defaults to <OPEN_WALNUT_HOME>/fake-gh.
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.env.WALNUT_FAKE_GH_DIR || path.join(process.env.OPEN_WALNUT_HOME || '.', 'fake-gh')
const args = process.argv.slice(2)

function out(text, code) {
  process.stdout.write(text)
  process.exit(code)
}

if (args[0] !== 'api' || args[1] !== 'graphql') {
  process.stderr.write(`fake gh: only "api graphql" is answered (got: ${args.join(' ')})\n`)
  process.exit(2)
}
const queryArg = args.find((a) => a.startsWith('query='))
const query = queryArg ? queryArg.slice('query='.length) : ''
const asked = [...query.matchAll(/(pr\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)]
if (fs.existsSync(path.join(dir, 'signed-out')) || (asked.length > 0 && asked.every((m) => fs.existsSync(path.join(dir, `signed-out.${m[2]}__${m[3]}`))))) {
  process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\n')
  process.exit(4)
}
try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'calls.log'), `${new Date().toISOString()} ${asked.map((m) => `${m[2]}/${m[3]}#${m[4]}`).join(' ')}\n`) } catch { /* logging is best effort */ }

let viewer = { login: 'walnut-dev' }
try { viewer = JSON.parse(fs.readFileSync(path.join(dir, 'viewer.json'), 'utf8')) } catch { /* default */ }
const data = { viewer }
const errors = []
for (const [, alias, owner, name, number] of asked) {
  const file = path.join(dir, `${owner}__${name}__${number}.json`)
  let node = null
  try { node = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { node = null }
  data[alias] = { pullRequest: node }
  if (!node) errors.push({ type: 'NOT_FOUND', path: [alias, 'pullRequest'], message: `Could not resolve to a PullRequest with the number of ${number}.` })
}
const body = JSON.stringify(errors.length ? { data, errors } : { data })
if (errors.length) process.stderr.write(`gh: ${errors.map((e) => e.message).join('\n')}\n`)
out(body, errors.length ? 1 : 0)
