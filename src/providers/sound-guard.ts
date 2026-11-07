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
  ALWAYS_PLAYS, AUDIO_FILE_RE, CODE_AUDIO_API_RE, CODE_OSASCRIPT_RE, CODE_PLAYER_RE, CODE_SAY_FILE_RE, CODE_SPAWN_RE,
  FFMPEG_AUDIO_OUT_RE, MEDIA_APPS_RE, OSA_AFPLAY_RE, OSA_BEEP_RE, OSA_JXA_VOLUME_RE, OSA_MEDIA_TELL_RE, OSA_PLAY_RE,
  OSA_SAVING_RE, OSA_SAY_RE, OSA_SET_VOLUME_RE, VOL_MUTED_RE, VOL_UNMUTE_RE,
} from './sound-rules.js'

const re = (s: string) => new RegExp(s)
const R = {
  audioFile: re(AUDIO_FILE_RE), mediaApp: re(MEDIA_APPS_RE), ffmpegOut: re(FFMPEG_AUDIO_OUT_RE),
  osaSay: re(OSA_SAY_RE), osaSaving: re(OSA_SAVING_RE), osaBeep: re(OSA_BEEP_RE), osaAfplay: re(OSA_AFPLAY_RE),
  osaTell: re(OSA_MEDIA_TELL_RE), osaPlay: re(OSA_PLAY_RE), osaJxaVol: re(OSA_JXA_VOLUME_RE),
  volUnmute: re(VOL_UNMUTE_RE), volMuted: re(VOL_MUTED_RE),
  codeApi: re(CODE_AUDIO_API_RE), codePlayer: re(CODE_PLAYER_RE), codeSpawn: re(CODE_SPAWN_RE), codeSayFile: re(CODE_SAY_FILE_RE),
  codeOsa: re(CODE_OSASCRIPT_RE),
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

/** A `set volume` statement (lower case, from the words to the end of its line) that leaves sound on. */
function volumeAudible(stmt: string): boolean {
  if (R.volUnmute.test(stmt)) return true
  if (R.volMuted.test(stmt)) return false
  return /[1-9]/.test(stmt)
}

/** What AppleScript / JXA text (lower case) does that makes sound, or null. */
export function osaHit(t: string): string | null {
  if (R.osaSay.test(t) && !R.osaSaving.test(t)) return 'AppleScript say'
  if (R.osaBeep.test(t)) return 'AppleScript beep'
  if (R.osaAfplay.test(t)) return 'afplay'
  if (R.osaTell.test(t) && R.osaPlay.test(t)) return 'a media app told to play'
  for (let at = t.indexOf(OSA_SET_VOLUME_RE); at >= 0; at = t.indexOf(OSA_SET_VOLUME_RE, at + 1)) {
    const stmt = t.slice(at).split(/[\n;'"]/)[0]
    if (volumeAudible(stmt)) return 'set volume'
  }
  const jxa = t.search(R.osaJxaVol)
  if (jxa >= 0 && volumeAudible(t.slice(jxa).split(/[\n;)]/)[0])) return 'setVolume'
  return null
}

/** What a script's code (lower case) does that makes sound, or null. */
export function codeHit(t: string): string | null {
  if (R.codeApi.test(t)) return 'an audio or speech API'
  const player = R.codePlayer.exec(t)
  if (player && R.codeSpawn.test(t) && !(player[1] === 'say' && R.codeSayFile.test(t))) return `${player[1]} started from code`
  if (R.codeOsa.test(t)) return osaHit(t)
  return null
}

const has = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a))
const valueAfter = (args: string[], flag: string) => { const k = args.indexOf(flag); return k >= 0 ? args[k + 1] : undefined }
const last = (args: string[]) => args[args.length - 1] ?? ''
const zero = (v: string) => /^0+(\.0+)?%?$/.test(v)

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
      const firstOperand = args.findIndex((a) => !a.startsWith('-'))
      const dev = args.findIndex((a) => a === '-d' || a === '--default-device')
      return firstOperand >= 0 && dev > firstOperand ? 'sox to the default device' : null
    }
    case 'ffmpeg': {
      const lastInput = args.lastIndexOf('-i')
      for (let k = Math.max(lastInput, 0); k < args.length - 1; k++) {
        if (lastInput >= 0 && args[k] === '-f' && R.ffmpegOut.test(args[k + 1].toLowerCase())) return `ffmpeg to ${args[k + 1]}`
      }
      return null
    }
    case 'open': case 'xdg-open': {
      const app = valueAfter(args, '-a')
      if (app !== undefined && R.mediaApp.test(app.toLowerCase())) return `open -a ${app}`
      const file = args.find((a) => !a.startsWith('-') && a !== app && R.audioFile.test(a.toLowerCase()))
      return file ? `${name} ${file}` : null
    }
    case 'amixer': {
      const set = args.findIndex((a) => a === 'set' || a === 'sset' || a === 'cset')
      if (set < 0) return null
      const values = args.slice(set + 2)
      return values.some((v) => /^(unmute|on|toggle)$/.test(v) || (/[0-9]/.test(v) && !zero(v))) ? 'amixer set' : null
    }
    case 'pactl': {
      const sub = args.find((a) => !a.startsWith('-')) ?? ''
      if (/^set-(sink|sink-input)-volume$/.test(sub)) return zero(last(args)) ? null : `pactl ${sub}`
      if (/^set-(sink|sink-input)-mute$/.test(sub)) return /^(1|true|yes|on)$/.test(last(args)) ? null : `pactl ${sub}`
      return null
    }
    case 'pamixer': {
      if (has(args, '-u', '--unmute', '-t', '--toggle-mute', '-i', '--increase', '--allow-boost')) return 'pamixer'
      const v = valueAfter(args, '--set-volume')
      return v !== undefined && !zero(v) ? 'pamixer' : null
    }
    case 'wpctl': {
      const sub = args.find((a) => !a.startsWith('-')) ?? ''
      if (sub === 'set-volume') return zero(last(args)) ? null : 'wpctl set-volume'
      if (sub === 'set-mute') return last(args) === '1' ? null : 'wpctl set-mute'
      return null
    }
  }
  return null
}

/** The code an interpreter runs from its arguments: its inline code, 'stdin', or null (a file: not seen here). */
function inlineCode(flags: string[], name: string, args: string[]): string[] | 'stdin' | null {
  const code: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (flags.includes(a)) { if (k + 1 < args.length) code.push(args[++k]); continue }
    if (code.length) return code
    if (name === 'deno' && a === 'eval') return k + 1 < args.length ? [args[k + 1]] : null
    if (a === '-') return 'stdin'
    if (a.startsWith('-') && a.length > 1) continue
    return null
  }
  return code.length ? code : 'stdin'
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
    const at = wrapper(words.slice(i + 1))
    if (at === null) return null
    i = i + 1 + at
  }
  const name = path.posix.basename(words[i])
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
  const expanded = inputs.flatMap((input) => expandedHeredocs(input).flatMap(substitutions))
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
