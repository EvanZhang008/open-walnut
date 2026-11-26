/**
 * Rehearsal only (`--git-watch <log>`): a `git` shim first on every rehearsal machine's PATH (its stub bin dir,
 * which the machine's daemon, servers, standby and switch jobs all put first), so it reaches the servers a daemon
 * launches too (their env is the world's machine env, not the outer one).
 *
 * Every git that names a machine's home (cwd, -C, GIT_DIR or an argument under `<machines>/<x>/home`) is logged
 * with pid, ppid, cwd, GIT_DIR, argv and its ancestry (four parents' command lines); an object-writing subcommand
 * is marked WRITER. The shim runs real git as its child and looks at each home's empty tree object
 * (.git/objects/4b/825dc...) before and after every git (named or not): one that appeared is logged as EMPTY-TREE-CREATED with the command.
 * Nothing of it is in a production path: the shim lives in the work dir.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** The empty tree's object path in a repo's .git (what `git mktree </dev/null` and a commit of an empty index write). */
export const EMPTY_TREE_OBJECT = '.git/objects/4b/825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Subcommands that can write objects or refs to the repo they run in. */
const WRITERS = ['mktree', 'commit', 'commit-tree', 'write-tree', 'hash-object', 'merge', 'add', 'stash', 'gc', 'repack', 'fetch', 'pull', 'rebase', 'cherry-pick', 'revert', 'read-tree', 'update-index', 'apply', 'am', 'notes', 'tag', 'update-ref', 'checkout', 'reset', 'restore', 'switch', 'pack-objects', 'unpack-objects', 'index-pack', 'prune', 'maintenance', 'merge-tree', 'replay']

function realGit(binDirs: string[]): string {
  const skip = new Set(binDirs.map((d) => path.resolve(d)))
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || skip.has(path.resolve(dir))) continue
    const p = path.join(dir, 'git')
    try { fs.accessSync(p, fs.constants.X_OK); if (!fs.readFileSync(p, 'utf8').slice(0, 64).includes('git-watch')) return p } catch { /* next */ }
  }
  return execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
}

/** Write the shim into each bin dir. `machines`: the folder of the machine folders (each with its `home`). */
export function installGitWatch(o: { log: string; machines: string; binDirs: string[] }): { real: string } {
  const real = realGit(o.binDirs)
  fs.mkdirSync(path.dirname(o.log), { recursive: true })
  fs.appendFileSync(o.log, `${new Date().toISOString()} git-watch on: real git ${real}, machines ${o.machines}\n`)
  const homes = fs.readdirSync(o.machines).map((n) => path.join(o.machines, n, 'home'))
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const script = `#!/bin/bash
# git-watch: rehearsal shim (scripts/leader-switch/git-watch.ts)
LOG=${q(o.log)}
REAL=${q(real)}
M=${q(o.machines)}
HOMES=(${homes.map(q).join(' ')})
all="$PWD|\${GIT_DIR:-}|$*"
named=0
case "$all" in *"$M"/*/home*) named=1 ;; esac
sub=""
skip=0
for a in "$@"; do
  if [ $skip = 1 ]; then skip=0; continue; fi
  case "$a" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env) skip=1 ;;
    -*) ;;
    *) sub="$a"; break ;;
  esac
done
kind=reader
case " ${WRITERS.join(' ')} " in *" $sub "*) kind=WRITER ;; esac
ancestry() {
  anc=""
  local p=$PPID
  for i in 1 2 3 4; do
    [ -r /proc/$p/cmdline ] || break
    anc="$anc | [$p] $(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-220)"
    p=$(awk '{print $4}' /proc/$p/stat 2>/dev/null)
    [ -n "$p" ] && [ "$p" != 0 ] || break
  done
}
anc=""
[ $named = 1 ] && ancestry
stamp() { date -u +%H:%M:%S.%N | cut -c1-12; }
line="pid=$$ ppid=$PPID cwd=$PWD GIT_DIR=\${GIT_DIR:-} IDX=\${GIT_INDEX_FILE:-} sub=$sub args=$*"
if [ $named = 1 ]; then
  [ $kind = WRITER ] && printf '%s WRITER %s ancestry:%s\\n' "$(stamp)" "$line" "$anc" >> "$LOG" || printf '%s reader %s\\n' "$(stamp)" "$line" >> "$LOG"
fi
before=()
for h in "\${HOMES[@]}"; do [ -e "$h/${EMPTY_TREE_OBJECT}" ] && before+=(1) || before+=(0); done
"$REAL" "$@"
code=$?
i=0
for h in "\${HOMES[@]}"; do
  if [ "\${before[$i]}" = 0 ] && [ -e "$h/${EMPTY_TREE_OBJECT}" ]; then
    [ -n "$anc" ] || ancestry
    printf '%s EMPTY-TREE-CREATED home=%s exit=%s %s ancestry:%s\\n' "$(stamp)" "$h" "$code" "$line" "$anc" >> "$LOG"
  fi
  i=$((i+1))
done
exit $code
`
  for (const bin of o.binDirs) {
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'git'), script, { mode: 0o755 })
  }
  return { real }
}

/**
 * A second net, for a writer that is no git on PATH (an absolute /usr/bin/git, a library): every 100 ms it looks
 * for each home's empty tree object; the first time one appears it logs every process whose cwd or command line
 * is under `machines` (pid, ppid, cwd, argv). Returns its stop.
 */
export function watchEmptyTree(o: { log: string; machines: string }): () => void {
  const homes = () => fs.readdirSync(o.machines).map((n) => path.join(o.machines, n, 'home'))
  const seen = new Set<string>()
  for (const h of homes()) if (fs.existsSync(path.join(h, EMPTY_TREE_OBJECT))) seen.add(h)
  const processes = (): string[] => {
    const out: string[] = []
    for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim()
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
        if (!cwd.startsWith(o.machines) && !cmd.includes(o.machines)) continue
        const ppid = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ')[1]
        out.push(`  pid=${pid} ppid=${ppid} cwd=${cwd} cmd=${cmd.slice(0, 300)}`)
      } catch { /* gone */ }
    }
    return out
  }
  const t = setInterval(() => {
    for (const h of homes()) {
      if (seen.has(h) || !fs.existsSync(path.join(h, EMPTY_TREE_OBJECT))) continue
      seen.add(h)
      let mtime = ''
      try { mtime = fs.statSync(path.join(h, EMPTY_TREE_OBJECT)).mtime.toISOString() } catch { /* gone */ }
      fs.appendFileSync(o.log, `${new Date().toISOString()} EMPTY-TREE-SEEN home=${h} mtime=${mtime}; processes under the machines now:\n${processes().join('\n')}\n`)
    }
  }, 100)
  t.unref?.()
  return () => clearInterval(t)
}
