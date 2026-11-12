/**
 * The PreToolUse hook that refuses a session's own write to Walnut's approval records: the device
 * keys, the approvals and the switch under WALNUT_HOME/approvals/ (keys.json, approvals.json,
 * switch.json), and the Approvals switch in config.yaml (core/approvals/ask-me.ts).
 *
 * Why (2026-11-12, a review of the Git gate): with approvals on, any agent here could turn every
 * approval off with one unsigned PUT /api/config, or by editing the files Walnut reads. The server
 * now takes an off only with a device's signature and holds the switch it set last; what is left
 * is a process of this account writing those files itself, before a restart reads them. This hook
 * refuses that for every session Walnut runs: Write, Edit, MultiEdit and NotebookEdit on those
 * files (config.yaml only when the edit touches the Approvals section), and a Bash command that
 * names one of them and writes (a redirect, sed -i, tee, mv, cp, rm, an interpreter). Reading them
 * stays open. It raises the bar for an agent; it is no wall against a hostile program of this
 * account, which the server's own checks are for.
 *
 * POSIX sh + awk like the other guards (git-tmp-guard-hook.ts): a `case` bails out at once on a
 * payload that names none of the files. Paths are taken as written (the Write tools take absolute
 * ones). WALNUT_APPROVALS_GUARD=0 on the server turns it off.
 */

import { shQuoteAwk } from './tmp-path-awk.js'

// Kept small on purpose: an older daemon takes every hook inline in one spawn template string
// (host-start-core.ts MAX_TEMPLATE_STRING, hook-files.ts), so no JSON parser and no comments
// inside. The payload is read as raw JSON: tool_name and file_path come before tool_input's
// content, whose own quotes are escaped. `r` names a record file; a Bash command is judged only
// when it writes (a redirect, an in-place edit, a copy, move or removal, an interpreter).
const GUARD_AWK = String.raw`BEGIN{RS="\001"}
{H=ENVIRON["OPEN_WALNUT_HOME"];if(H=="")H=ENVIRON["HOME"]"/.open-walnut"
r="approvals/(keys|approvals|switch)\\.json"
if($0~/"tool_name":"Bash"/){
if($0!~/>|(sed|perl|ruby|yq)[^;&|]* -[a-zA-Z]*i|[ ;&|(":](tee|mv|cp|rm|truncate|dd|ln|install|rsync|python3?|node|bun|deno|osascript) /)exit
if($0~r||($0~/open-walnut\/approvals/&&$0~/(keys|approvals|switch)\.json/))d("write Walnut's approval records")
if($0~/config\.yaml/&&$0~/ask_me/)d("change the Approvals switch in config.yaml")
exit}
if($0!~/"tool_name":"(Write|Edit|MultiEdit|NotebookEdit)"/||!match($0,/"(file|notebook)_path":"[^"]*"/))exit
p=substr($0,RSTART,RLENGTH);sub(/^"[a-z_]*":"/,"",p);sub(/"$/,"",p)
if(p~r"$"&&(index(p,H"/")==1||p~/\/\.open-walnut\//))d("write "p", one of Walnut's approval records")
if(p==H"/config.yaml"||p~/\/\.open-walnut\/config\.yaml$/){
if($0~/"tool_name":"Write"/){while((getline l<p)>0)if(l~/ask_me/)d("rewrite config.yaml, which holds the Approvals switch")}
else if($0~/ask_me|approvals/)d("change the Approvals switch in config.yaml")}}
function d(w){printf "Walnut refused this: it would %s. Only the person changes approvals, in Settings, General (turning them off asks for Face ID or Touch ID). Read them with walnut tools call approval_list.",w;exit}`

/** The hook command: a `case` on the payload, then the awk check. */
export const APPROVALS_GUARD_COMMAND = [
  'in=$(cat 2>/dev/null)',
  'case $in in *approvals*|*config.yaml*) ;; *) exit 0 ;; esac',
  `msg=$(printf '%s' "$in" | awk ${shQuoteAwk(GUARD_AWK)} 2>/dev/null)`,
  // Only the refusal text refuses: an awk that fails prints nothing, and allows.
  'case $msg in "Walnut refused"*) ;; *) exit 0 ;; esac',
  'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n\' "$msg"',
  'exit 0',
].join('\n')

const HOOK_TIMEOUT_SECS = 10

export function approvalsGuardHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_APPROVALS_GUARD === '0') return null
  return {
    PreToolUse: [{
      matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit',
      hooks: [{ type: 'command', command: APPROVALS_GUARD_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
    }],
  }
}
