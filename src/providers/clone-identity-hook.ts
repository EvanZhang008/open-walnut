/**
 * The Bash hook that gives a session's clone of a LOCAL repository the commit
 * identity that repository uses. `git clone` copies no config, so a repository
 * whose user.name / user.email live in its own .git/config (or come from an
 * includeIf for its directory) yields clones that commit, and rebase, under the
 * machine's global identity instead. A rebase there re-stamps the committer of
 * every commit it replays, so one push from such a clone can publish that
 * identity on many commits. 2026-10-28: agents' landing clones of a checkout
 * with its own identity had done exactly that, and their pushes carried it.
 *
 * One command, registered on PreToolUse and PostToolUse:
 * - PreToolUse, before a command runs: every `git clone <local source> [<dest>]`
 *   in it (read with the same parser as the temp-dir guard, git-command-awk.ts,
 *   from the directory the command starts in) is written down as pending, one
 *   file per tool call under the user's state dir. PostToolUse cannot do this:
 *   its cwd is where the command ended, after any cd in it.
 * - Both, before and after every Bash command: each pending clone of this
 *   session that is now a checked-out repository of its own, whose remote
 *   points at the source and that has no identity of its own, gets the
 *   source's user.name / user.email in its local config (when it would commit
 *   as someone else), and one line of context says so. A clone whose command
 *   failed (no PostToolUse then) or ran in the background is set before the
 *   session's next command runs. Pending clones that never appear expire
 *   after a day.
 * A clone of a URL, a bare clone, a clone that already has its own identity,
 * a directory that is not a clone of that source and a repository still being
 * cloned (no index yet) are left alone. Worktrees share their repository's config.
 *
 * POSIX sh + awk + git, like the other session hooks (a remote host may have no
 * node). WALNUT_CLONE_IDENTITY=0 on the server turns it off.
 */
import { TMP_PATH_AWK, shQuoteAwk } from './tmp-path-awk.js'
import { GIT_COMMAND_AWK } from './git-command-awk.js'

const PAIRS_AWK = GIT_COMMAND_AWK + String.raw`
# One "source<TAB>dest" line per clone whose source is a local path.
function on_git(sub_, g, pos, np,   src, dest) {
  if (sub_ != "clone" || np == 0) return
  src = pos[1]
  if (substr(src, 1, 7) == "file://") src = substr(src, 8)
  else if (index(src, "://") || src ~ /^[^\/]*:/) return
  src = resolve(g, src); dest = clone_dest(g, pos, np)
  if (src == "" || dest == "" || index(src dest, "\t")) return
  printf "%s\t%s\n", src, dest
}
`

/** "<session id> <tool use id>", each cut to a safe file-name alphabet. */
const IDS_AWK = TMP_PATH_AWK + String.raw`
BEGIN { RS = "\001" }
{ s = jstr($0, "session_id"); t = jstr($0, "tool_use_id"); gsub(/[^A-Za-z0-9_-]/, "", s); gsub(/[^A-Za-z0-9_-]/, "", t); print s " " t }
`

/** The hook command: record (PreToolUse), then settle what is pending (both events). */
export const CLONE_IDENTITY_COMMAND = [
  'in=$(cat 2>/dev/null)',
  // A PostToolUse payload carries the command's output; past this it is not read
  // (what it left pending is settled at the next command).
  '[ ${#in} -le 1000000 ] || exit 0',
  // The user's own state dir, never a shared /tmp.
  '[ -n "$HOME" ] || exit 0',
  'dir="${XDG_STATE_HOME:-$HOME/.local/state}/open-walnut/clone-identity"',
  'pre=; rec=',
  'case $in in *\'"hook_event_name":"PreToolUse"\'*) pre=1 ;; esac',
  'if [ -n "$pre" ]; then case $in in *clone*) rec=1 ;; esac; fi',
  'list=; [ ! -d "$dir" ] || list=$(ls "$dir" 2>/dev/null)',
  '[ -n "$rec" ] || [ -n "$list" ] || exit 0',
  'command -v git >/dev/null 2>&1 || exit 0',
  `ids=$(printf '%s' "$in" | awk ${shQuoteAwk(IDS_AWK)} 2>/dev/null)`,
  'sid=${ids% *}; tid=${ids#* }',
  '[ -n "$sid" ] || exit 0',
  // An inherited GIT_DIR outranks -C (git exports one inside its own hooks).
  'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY',
  'tab=$(printf \'\\t\')',
  // A repository path, canonical, without a trailing /.git.
  'repo_path() { p=$(cd "$1" 2>/dev/null && pwd -P) || return 1; p=${p%/}; printf \'%s\' "${p%/.git}"; }',
  // One line of JSON string: control characters become spaces or go.
  'esc() { printf \'%s\' "$1" | tr \'\\n\\t\\r\' \'   \' | tr -d \'\\000-\\037\' | sed \'s/\\\\/\\\\\\\\/g; s/"/\\\\"/g\'; }',
  // Settle one pending clone. 0 = done (prints a note when it set the identity),
  // 1 = not a checked-out clone yet: ask again at the next command.
  'one() {',
  '  [ -d "$1" ] || return 0',
  '  [ -d "$2" ] || return 1',
  // A bare clone has no worktree to commit in.
  '  [ "$(git -C "$2" rev-parse --is-bare-repository 2>/dev/null)" != true ] || return 0',
  '  d=$(repo_path "$2") || return 1',
  '  top=$(git -C "$2" rev-parse --show-toplevel 2>/dev/null) || return 1',
  // Not a repository of its own (yet): -C would reach the one around it.
  '  [ "$(repo_path "$top")" = "$d" ] || return 1',
  // Still cloning: the checkout writes the index last (a clone of an empty source has
  // none and is done at once), and a config write now could take the lock git clone needs.
  '  gd=$(git -C "$2" rev-parse --absolute-git-dir 2>/dev/null) || return 1',
  '  [ -f "$gd/index" ] || ! git -C "$1" rev-parse -q --verify HEAD >/dev/null 2>&1 || return 1',
  '  [ ! -e "$gd/config.lock" ] || return 1',
  '  s=$(repo_path "$1") || return 0',
  '  [ "$s" != "$d" ] || return 0',
  // Only a clone of this source: one of its remotes points at it.
  '  hit=$(git -C "$2" config --get-regexp \'^remote\\..*\\.url$\' 2>/dev/null | while read -r _k u; do',
  // No `case` in here: bash 3.2 (macOS /bin/sh) misreads its `)` inside $( ).
  '    u=${u#file://}; [ "${u#/}" != "$u" ] || continue',
  '    [ "$(repo_path "$u")" = "$s" ] && { echo y; break; }',
  '  done)',
  '  [ "$hit" = y ] || return 0',
  '  se=$(git -C "$1" config --get user.email 2>/dev/null); sn=$(git -C "$1" config --get user.name 2>/dev/null)',
  '  [ -n "$se$sn" ] || return 0',
  // Its own identity, if it has one, is the user\'s choice; a field that already holds the
  // source\'s value was written here before the other write lost a lock.
  '  le=$(git -C "$2" config --local --get user.email 2>/dev/null); ln=$(git -C "$2" config --local --get user.name 2>/dev/null)',
  '  [ -z "$le" ] || [ "$le" = "$se" ] || return 0',
  '  [ -z "$ln" ] || [ "$ln" = "$sn" ] || return 0',
  '  de=$(git -C "$2" config --get user.email 2>/dev/null); dn=$(git -C "$2" config --get user.name 2>/dev/null)',
  '  [ "$se" != "$de" ] || [ "$sn" != "$dn" ] || return 0',
  '  if [ -n "$sn" ] && [ "$sn" != "$dn" ]; then git -C "$2" config user.name "$sn" || return 1; fi',
  '  if [ -n "$se" ] && [ "$se" != "$de" ]; then git -C "$2" config user.email "$se" || return 1; fi',
  '  was=$(printf \'%s\' "$dn${de:+ <$de>}"); [ -n "$was" ] || was="no identity"',
  '  printf \'%s\' "Walnut set the commit identity of the clone at $2 to $sn${se:+ <$se>}, the one its source $1 commits with: a clone copies no git config, so it would have committed as $was (rebases there re-stamp every replayed commit). It is in that clone\'s .git/config; change it there if this clone should commit as someone else."',
  '}',
  'note=""',
  'if [ -n "$list" ]; then',
  '  while read -r name; do',
  '    case $name in "$sid".*) ;; *) continue ;; esac',
  '    f="$dir/$name"; [ -f "$f" ] || continue',
  '    left=""; settled=',
  '    while IFS="$tab" read -r src dest; do',
  '      [ -n "$src" ] && [ -n "$dest" ] || continue',
  '      said=$(one "$src" "$dest" </dev/null)',
  '      if [ $? -ne 0 ]; then left="$left$src$tab$dest',
  '"; else settled=1; fi',
  '      [ -z "$said" ] || note="$note $said"',
  '    done < "$f"',
  // Rewritten only when one settled, keeping its time, so the expiry below counts from the clone.
  '    if [ -z "$left" ]; then rm -f "$f"',
  '    elif [ -n "$settled" ]; then printf \'%s\' "$left" > "$dir/.new.$$" && touch -r "$f" "$dir/.new.$$" && mv -f "$dir/.new.$$" "$f"; fi',
  '  done <<WALNUT_PENDING',
  '$list',
  'WALNUT_PENDING',
  // A clone that never appeared (a refused or failed command) is forgotten after a day.
  '  find "$dir" -type f -mmin +1440 -exec rm -f {} \\; 2>/dev/null',
  'fi',
  'if [ -n "$rec" ]; then',
  `  pairs=$(printf '%s' "$in" | awk ${shQuoteAwk(PAIRS_AWK)} 2>/dev/null)`,
  '  if [ -n "$pairs" ] && (umask 077; mkdir -p "$dir") 2>/dev/null; then',
  '    printf \'%s\\n\' "$pairs" > "$dir/.new.$$" && mv -f "$dir/.new.$$" "$dir/$sid.${tid:-$$}"',
  '  fi',
  'fi',
  '[ -n "$note" ] || exit 0',
  'ev=PostToolUse; [ -z "$pre" ] || ev=PreToolUse',
  'printf \'{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\\n\' "$ev" "$(esc "${note# }")"',
  'exit 0',
].join('\n')

const HOOK_TIMEOUT_SECS = 10

export function cloneIdentityHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_CLONE_IDENTITY === '0') return null
  const group = { matcher: 'Bash', hooks: [{ type: 'command', command: CLONE_IDENTITY_COMMAND, timeout: HOOK_TIMEOUT_SECS }] }
  return { PreToolUse: [group], PostToolUse: [group] }
}
