/**
 * The TypeScript twin of the Bash sound guard (sound-guard-hook.ts): finds a
 * command in a shell line that would make sound, or change the volume or unmute,
 * on the machine that runs it. Rules: sound-rules.ts. host_exec runs it on the
 * server before it asks any host (src/core/hosts/host-exec.ts), so a command an
 * agent sends to another machine through Walnut is held to the same rule as one
 * it types in its own Bash tool. One case table runs through both twins
 * (tests/providers/sound-guard-cases.ts).
 *
 * What it reads: every simple command, wrappers (sudo, env, timeout, xargs)
 * skipped, command substitutions, the script a shell runs (`-c`, its heredoc,
 * text piped in), eval, `su -c`, `ssh host cmd` and a heredoc fed to ssh, find's
 * -exec, the AppleScript osascript runs, and the inline code of an interpreter
 * (python3 -c, node -e, their heredocs). A script file it cannot see is not read.
 */
import path from 'node:path'
import { ASSIGN, BEFORE_COMMAND, EXEC_FLAGS, WRAPPERS, ANY_SHELL, shellInput, simpleCommands, tokenize, type CommandInput } from './host-exec-guards.js'
import {
  ALWAYS_PLAYS, AUDIO_FILE_RE, CODE_AUDIO_API_RE, CODE_CALL_RE, CODE_OSASCRIPT_RE, CODE_SAY_FILE_RE, CODE_STRING_RE,
  FFMPEG_AUDIO_OUT_RE, MEDIA_APPS_RE, OSA_AFPLAY_RE, OSA_BEEP_RE, OSA_JXA_VOLUME_RE, OSA_MEDIA_TELL_RE, OSA_PLAY_RE,
  OSA_SAVING_RE, OSA_SAY_RE, OSA_SET_VOLUME_RE, VOL_MUTED_RE, VOL_UNMUTE_RE,
} from './sound-rules.js'

const re = (s: string) => new RegExp(s)
const R = {
  audioFile: re(AUDIO_FILE_RE), mediaApp: re(MEDIA_APPS_RE), ffmpegOut: re(FFMPEG_AUDIO_OUT_RE),
  osaSay: re(OSA_SAY_RE), osaSaving: re(OSA_SAVING_RE), osaBeep: re(OSA_BEEP_RE), osaAfplay: re(OSA_AFPLAY_RE),
  osaTell: re(OSA_MEDIA_TELL_RE), osaPlay: re(OSA_PLAY_RE), osaJxaVol: re(OSA_JXA_VOLUME_RE),
  volUnmute: re(VOL_UNMUTE_RE), volMuted: re(VOL_MUTED_RE),
  codeApi: re(CODE_AUDIO_API_RE), codeCall: new RegExp(CODE_CALL_RE, 'g'), codeString: new RegExp(CODE_STRING_RE, 'g'),
  codeSayFile: re(CODE_SAY_FILE_RE), codeOsa: re(CODE_OSASCRIPT_RE), osaSayAll: new RegExp(OSA_SAY_RE, 'g'),
}
const PLAYS = new Set<string>(ALWAYS_PLAYS)
const MAX_DEPTH = 8
const MAX_WRAPPER_HOPS = 16
const NO_INPUT: CommandInput = { text: '', heredocs: [], pipedFrom: [] }

/** Inline code flags per interpreter; with none and no operand, the code is stdin. */
const CODE_FLAGS: Record<string, string[]> = {
  python: ['-c'], python2: ['-c'], python3: ['-c'],
  node: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval', '-p', '--print'], deno: [],
  perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], lua: ['-e'], swift: [],
  pwsh: ['-c', '-Command', '-command'], powershell: ['-c', '-Command', '-command'],
}

/** A `set volume` statement (lower case, to the end of its line) that does more than mute: an unmute or any level, 0 too. */
function volumeChanges(stmt: string): boolean {
  return R.volUnmute.test(stmt) || /[0-9]/.test(stmt) || !R.volMuted.test(stmt)
}

/** An AppleScript `say` that speaks: one with no `saving to` after its own text (`say "x" saving to f` writes a file). */
function speaks(t: string): boolean {
  for (const m of t.matchAll(R.osaSayAll)) {
    const rest = t.slice(m.index! + m[0].length - (m[3] ? m[3].length : 0)).split('\n')[0]
    if (!R.osaSaving.test(rest.replace(/^[ \t]*"[^"]*"/, ''))) return true
  }
  return false
}

/** What AppleScript / JXA text (lower case) does that makes sound, or null. */
export function osaHit(t: string): string | null {
  if (speaks(t)) return 'AppleScript say'
  if (R.osaBeep.test(t)) return 'AppleScript beep'
  if (R.osaAfplay.test(t)) return 'afplay'
  if (R.osaTell.test(t) && R.osaPlay.test(t)) return 'a media app told to play'
  for (let at = t.indexOf(OSA_SET_VOLUME_RE); at >= 0; at = t.indexOf(OSA_SET_VOLUME_RE, at + 1)) {
    const stmt = t.slice(at).split(/[\n;'"]/)[0]
    if (volumeChanges(stmt)) return 'set volume'
  }
  const jxa = t.search(R.osaJxaVol)
  if (jxa >= 0 && volumeChanges(t.slice(jxa).split(/[\n;)]/)[0])) return 'setVolume'
  return null
}

/** What a script's code (lower case) does that makes sound, or null. */
export function codeHit(t: string): string | null {
  if (R.codeApi.test(t.replace(R.codeString, '""'))) return 'an audio or speech API'
  // Each call on its own: a `say -o` in one never lets another speak.
  for (const m of t.matchAll(R.codeCall)) {
    const player = m[3]
    const call = t.slice(m.index!).split(')')[0]
    if (!(player === 'say' && R.codeSayFile.test(call))) return `${player} started from code`
  }
  if (R.codeOsa.test(t)) return osaHit(t)
  return null
}

const has = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a))
const valueAfter = (args: string[], flag: string) => { const k = args.indexOf(flag); return k >= 0 ? args[k + 1] : undefined }
const last = (args: string[]) => args[args.length - 1] ?? ''
/** ffmpeg options that take no value. */
const FFMPEG_FLAGS = new Set(['-y', '-n', '-an', '-vn', '-sn', '-dn', '-nostdin', '-re', '-hide_banner', '-stats', '-nostats'])

/** A player or mixer program's own verdict on its arguments, or null. */
function programHit(name: string, args: string[]): string | null {
  if (PLAYS.has(name)) return name
  switch (name) {
    case 'say':
      if (args.some((a) => a === '-o' || a === '--output-file' || a.startsWith('--output-file=') || /^-o./.test(a))) return null
      if (valueAfter(args, '-v') === '?' || has(args, '--voice=?')) return null
      return 'say'
    case 'espeak': case 'espeak-ng':
      return args.some((a) => a === '-w' || a === '--stdout' || a === '-q' || a.startsWith('-w')) ? null : name
    case 'aplay':
      return has(args, '-l', '-L', '--list-devices', '--list-pcms') ? null : 'aplay'
    case 'pacat':
      return has(args, '-r', '--record') ? null : 'pacat'
    case 'pw-cat':
      return has(args, '-p', '--playback') ? 'pw-cat' : null
    case 'mpv':
      return args.some((a) => /^--(ao=null|no-audio|audio=no|aid=no)$/.test(a)) || valueAfter(args, '--ao') === 'null' ? null : 'mpv'
    case 'mplayer':
      return has(args, '-nosound', '-ao=null') || valueAfter(args, '-ao') === 'null' ? null : 'mplayer'
    case 'ffplay':
      return has(args, '-an') ? null : 'ffplay'
    case 'festival':
      return has(args, '--tts') ? 'festival' : null
    case 'sox': {
      // The default device after an input (a file, or -n, the null input) is the output: it plays.
      const input = args.findIndex((a) => !a.startsWith('-') || a === '-n' || a === '--null')
      const dev = args.findIndex((a) => a === '-d' || a === '--default-device')
      return input >= 0 && dev > input ? 'sox to the default device' : null
    }
    case 'ffmpeg': {
      // `-f <device>` names the format of the next file: an input when -i comes first, else an output.
      for (let k = 0; k < args.length - 1; k++) {
        if (args[k] !== '-f' || !R.ffmpegOut.test(args[k + 1].toLowerCase())) continue
        let j = k + 2
        while (j < args.length && args[j].startsWith('-') && args[j] !== '-i' && args[j] !== '-') j += FFMPEG_FLAGS.has(args[j]) ? 1 : 2
        if (args[j] !== '-i') return `ffmpeg to ${args[k + 1]}`
      }
      return null
    }
    case 'open': case 'xdg-open': {
      const app = valueAfter(args, '-a')
      if (app !== undefined && R.mediaApp.test(app.toLowerCase())) return `open -a ${app}`
      const file = args.find((a) => !a.startsWith('-') && a !== app && R.audioFile.test(a.toLowerCase()))
      return file ? `${name} ${file}` : null
    }
    // Mixers: muting alone passes; any level (0 too), an unmute or a toggle does not.
    case 'amixer': {
      const set = args.findIndex((a) => a === 'set' || a === 'sset' || a === 'cset')
      if (set < 0) return null
      return args.slice(set + 2).some((v) => /^(unmute|on|toggle)$/.test(v) || /[0-9]/.test(v)) ? 'amixer set' : null
    }
    case 'pactl': case 'wpctl': {
      let k = 0
      while (k < args.length && args[k].startsWith('-')) k += /^(-s|--server|-n|--client-name)$/.test(args[k]) ? 2 : 1
      const sub = args[k] ?? ''
      if (/^set-(sink|sink-input)-volume$|^set-volume$|^play-sample$/.test(sub)) return `${name} ${sub}`
      if (/^set-(sink|sink-input)-mute$|^set-mute$/.test(sub)) return /^(1|true|yes|on)$/.test(last(args)) ? null : `${name} ${sub}`
      return null
    }
    case 'pamixer':
      return args.some((a) => /^(-u|--unmute|-t|--toggle-mute|-i|--increase|-d|--decrease|-v|--set-volume|--allow-boost)$/.test(a)) ? 'pamixer' : null
  }
  return null
}

/** The code an interpreter runs from its arguments: its inline code, 'stdin', or null (a file: not seen here). */
function inlineCode(flags: string[], name: string, args: string[]): string[] | 'stdin' | null {
  const code: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (flags.includes(a)) { if (k + 1 < args.length) code.push(args[++k]); continue }
    // Attached: -c'code', -e'code', --eval=code.
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0 && flags.includes(a.slice(0, eq))) { code.push(a.slice(eq + 1)); continue }
    const two = flags.find((f) => f.length === 2 && a.length > 2 && a.startsWith(f))
    if (two) { code.push(a.slice(2)); continue }
    if (code.length) return code
    if (name === 'deno' && a === 'eval') return k + 1 < args.length ? [args[k + 1]] : null
    if (a === '-') return 'stdin'
    if (a.startsWith('-') && a.length > 1) continue
    return null
  }
  return code.length ? code : 'stdin'
}

/** The command line `env -S` / `--split-string` runs: its string and the words after it, or null for none. */
function envSplit(args: string[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '-S' || a === '--split-string') return args.slice(k + 1).join(' ')
    if (a.startsWith('--split-string=')) return [a.slice('--split-string='.length), ...args.slice(k + 1)].join(' ')
    if (a.startsWith('-S') && a.length > 2) return [a.slice(2), ...args.slice(k + 1)].join(' ')
    if (/^(-u|--unset|-C|--chdir|-P)$/.test(a)) { k++; continue }
    if (!a.startsWith('-') && !ASSIGN.test(a)) return null
  }
  return null
}

/** ssh's options that take a value. */
const SSH_ARG = /^-[pioFlJLRDWbcEemOQSwB]$/

function stdinOf(input: CommandInput): string[] {
  return [...input.heredocs, ...input.pipedFrom.flatMap((f) => [f.text, ...f.heredocs])]
}

/** Text a shell reads on stdin, as commands: its heredocs, and every word and heredoc of what is piped in. */
function shellStdinHit(input: CommandInput, depth: number): string | null {
  for (const body of input.heredocs) { const h = lineHit(body, depth + 1); if (h) return h }
  for (const f of input.pipedFrom) {
    for (const words of simpleCommands(f.text)) for (const w of words) { const h = lineHit(w, depth + 1); if (h) return h }
    for (const body of f.heredocs) { const h = lineHit(body, depth + 1); if (h) return h }
  }
  return null
}

function commandHit(words: string[], start: number, input: CommandInput, depth: number, scanExec = true): string | null {
  let i = start
  for (let hop = 0; ; hop++) {
    while (i < words.length && (ASSIGN.test(words[i]) || BEFORE_COMMAND.has(words[i]))) i++
    if (i >= words.length || hop > MAX_WRAPPER_HOPS) return null
    const name = path.posix.basename(words[i])
    const wrapper = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined
    if (!wrapper) break
    // env -S 'cmd args': the string is the command line.
    const split = name === 'env' ? envSplit(words.slice(i + 1)) : null
    if (split !== null) return lineHit(split, depth + 1)
    const at = wrapper(words.slice(i + 1))
    if (at === null) return null
    i = i + 1 + at
    if (words[i] === '--') i++
  }
  if (i >= words.length) return null
  // python3.11 is python3.
  const name = path.posix.basename(words[i]).replace(/^(python[23]?)(\.[0-9]+)+$/, '$1')
  const args = words.slice(i + 1)
  if (ANY_SHELL.has(name)) {
    const script = shellInput(args)
    if (script === null) return null
    return script === 'stdin' ? shellStdinHit(input, depth) : lineHit(script, depth + 1)
  }
  if (name === 'eval') return lineHit(args.join(' '), depth + 1)
  if (name === 'su') { const c = valueAfter(args, '-c'); return c === undefined ? null : lineHit(c, depth + 1) }
  if (name === 'ssh') {
    let k = 0
    while (k < args.length && args[k].startsWith('-')) k += SSH_ARG.test(args[k]) ? 2 : 1
    const remote = args.slice(k + 1)
    return remote.length ? lineHit(remote.join(' '), depth + 1) : shellStdinHit(input, depth)
  }
  if (name === 'osascript') {
    const script = inlineCode(['-e'], name, args.filter((a, k) => !(a === '-l' || a === '-s' || args[k - 1] === '-l' || args[k - 1] === '-s')))
    if (script === null) return null
    return osaHit((script === 'stdin' ? stdinOf(input) : script).join('\n').toLowerCase())
  }
  const flags = Object.hasOwn(CODE_FLAGS, name) ? CODE_FLAGS[name] : undefined
  if (flags) {
    const code = inlineCode(flags, name, args)
    if (code === null) return null
    return codeHit((code === 'stdin' ? stdinOf(input) : code).join('\n').toLowerCase())
  }
  const own = programHit(name, args)
  if (own) return own
  if (scanExec) {
    for (let k = i + 1; k < words.length; k++) {
      if (EXEC_FLAGS.has(words[k])) { const h = commandHit(words, k + 1, NO_INPUT, depth, false); if (h) return h }
    }
  }
  return null
}

/** The command substitutions in data text (an unquoted heredoc body): what the shell runs while it reads it. */
function substitutions(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c === '`') { const e = text.indexOf('`', i + 1); const end = e < 0 ? text.length : e; out.push(text.slice(i + 1, end)); i = end; continue }
    if (c === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      let depth = 1
      let j = i + 2
      for (; j < text.length && depth > 0; j++) { if (text[j] === '(') depth++; else if (text[j] === ')') depth-- }
      out.push(text.slice(i + 2, j - 1))
      i = j - 1
    }
  }
  return out
}

/** The bodies of a command's heredocs whose delimiter is unquoted (`<<EOF`, not `<<'EOF'`): the shell expands those. */
function expandedHeredocs(input: CommandInput): string[] {
  const marks = [...input.text.matchAll(/<<(?!<)-?[ \t]*([^ \t\n;&|<>()]+)/g)]
  return input.heredocs.filter((_, k) => marks[k] !== undefined && !/['"\\]/.test(marks[k][1]))
}

function lineHit(line: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return null
  const { commands, inputs, subs } = tokenize(line)
  for (let k = 0; k < commands.length; k++) { const h = commandHit(commands[k], 0, inputs[k], depth); if (h) return h }
  // An unquoted heredoc's $(...), and one inside $(( )), which the tokenizer keeps as arithmetic text.
  const expanded = [...inputs.flatMap((input) => expandedHeredocs(input).flatMap(substitutions)),
    ...commands.flat().filter((w) => w.includes('$((')).flatMap(substitutions)]
  for (const body of [...subs, ...expanded]) { const h = lineHit(body, depth + 1); if (h) return h }
  return null
}

/** What in `line` (a shell line) would make sound on the machine that runs it, or null. */
export function soundRisk(line: string): string | null {
  return lineHit(line, 0)
}

/** Off only with WALNUT_SOUND_GUARD=0 on the Walnut server. */
export function soundGuardOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WALNUT_SOUND_GUARD !== '0'
}
