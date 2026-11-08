/**
 * What counts as making sound on the machine a command runs on: the one rule set
 * both sound guards read, so they never disagree.
 *
 * - sound-guard-hook.ts: a PreToolUse Bash hook in every Claude Code session
 *   (POSIX awk, interpolating the lists below).
 * - sound-guard.ts: the same judge in TypeScript, which host_exec runs on the
 *   server before it asks any host (src/core/hosts/host-exec.ts).
 *
 * Why (2026-11-07, at night): a voice test on someone else's Mac unmuted it at
 * 70% (`ssh mac "osascript -e 'set volume output volume 70 without output muted'"`)
 * and a test then spoke and played music through its speakers. A standing rule
 * in the user's profile did not stop it. Silent ways stay open: `say -o file`,
 * `espeak -w file`, players with a null output, muting, and choosing an output
 * device (a virtual one is the silent way to test audio).
 *
 * Every regex here is POSIX ERE (no \b, \s, \d) and lower case: both twins match
 * it against lower-cased text, since awk has no case-insensitive match.
 */

/** Programs that play sound to the default output whatever their arguments. */
export const ALWAYS_PLAYS = [
  'afplay', 'paplay', 'pw-play', 'play', 'spd-say', 'speaker-test', 'beep', 'canberra-gtk-play',
  'ogg123', 'mpg123', 'mpg321', 'cvlc', 'vlc',
] as const

/** Apps whose `play` (AppleScript) or launch on a file (`open -a`) plays media. */
export const MEDIA_APPS_RE = '^(music|itunes|spotify|quicktime player|vlc|tv)(\\.app)?$'
/** A file `open` / `xdg-open` would play. */
export const AUDIO_FILE_RE = '\\.(mp3|wav|aiff|aif|aifc|m4a|caf|flac|ogg|oga|opus|aac|mid|midi)$'
/** ffmpeg output formats that are a sound device. */
export const FFMPEG_AUDIO_OUT_RE = '^(audiotoolbox|alsa|pulse|sdl|sdl2|oss|sndio)$'

const NW = '[^a-z0-9_]'
/** A word in text: not part of a longer name. */
const word = (w: string) => `(^|${NW})(${w})(${NW}|$)`

/** A string literal in AppleScript or code: left out before a word is looked for (`return "afplay"`, `print("playsound")` run nothing). */
export const STRING_RE = '"[^"]*"|\'[^\']*\''

/**
 * AppleScript / JXA, matched on its text with string literals emptied: speech (a `say` with no `saving to`
 * after its own text), a beep, a media app told to play. A shell line it runs (`do shell script "..."`,
 * JXA `doShellScript("...")`) is judged as a command line.
 */
export const OSA_SAY_RE = word('say')
export const OSA_SAVING_RE = 'saving to'
export const OSA_BEEP_RE = word('beep')
/** A media app by name or bundle id: `application id "..."`, `app "..."`, JXA `Application('...')`. Matched on the text as written. */
export const OSA_MEDIA_TELL_RE = '(application|app)[ \t(]+(id[ \t]+)?["\'](com\\.apple\\.(music|itunes|tv|quicktimeplayerx)|com\\.spotify\\.client|org\\.videolan\\.vlc|music|itunes|spotify|quicktime player|vlc|tv)["\']'
export const OSA_PLAY_RE = word('play|playpause|resume')
export const OSA_SHELL_RE = '(do shell script|doshellscript[ \t]*\\()[ \t]*'
/** Every `set volume` statement (to the end of its line) and JXA setVolume call must be one of these: a mute alone. */
export const OSA_SET_VOLUME_RE = 'set volume'
export const OSA_MUTE_ONLY_RE = '^set volume[ \t]+(with output muted|output muted (true|yes))[ \t]*$'
export const OSA_JXA_VOLUME_RE = 'setvolume[ \t]*\\('
export const JXA_MUTE_ONLY_RE = '^setvolume[ \t]*\\([ \t]*null[ \t]*,[ \t]*\\{[ \t]*["\']?outputmuted["\']?[ \t]*:[ \t]*true[ \t]*\\}[ \t]*\\)'
/** A media app's own volume: `set sound volume to 70`, JXA `music.soundVolume = 70`. */
export const OSA_APP_VOLUME_RE = 'set sound volume|soundvolume[ \t]*='

/** In a script's code (python -c, node -e, a heredoc to them), outside its string literals: an audio or speech API. */
export const CODE_AUDIO_API_RE = 'nssound|nsspeechsynthesizer|avspeechsynthesizer|avaudioplayer|pyttsx3|playsound|simpleaudio|winsound|pygame\\.mixer|system\\.speech|speechsynthesizer|soundplayer|\\[console\\]::beep'
/**
 * A call in code that starts a process, up to its first argument: what it starts is judged as a command line,
 * by the same rules as the shell: a string (`os.system("say hi")`, `execSync(...)`), an argv list
 * (`subprocess.run(["afplay", "x"])`), or a program string then its list (`spawn("say", ["hi"])`).
 * Bun's $`...` is one too.
 */
export const CODE_SPAWN_RE = '(system|popen|getoutput|getstatusoutput|run|call|check_output|check_call|exec|execsync|execfile|execfilesync|spawn|spawnsync|command)[ \t]*\\([ \t]*|\\$`'

/** The refusal both guards give, after "Walnut refused this command: ". */
export function soundAdvice(what: string): string {
  return `it would make sound on the machine it runs on (${what}). The person there wants no sound from an agent, never a volume change or an unmute. `
    + 'Work silently: speech to a file (say -o out.aiff, espeak -w out.wav) fed to the app or simulator, audio through a virtual audio device '
    + '(BlackHole, a null sink), a player with a null output (mpv --ao=null). Muting alone and reading the volume are fine; setting any level is not. '
    + 'Text that only names these: write it with the Write tool.'
}
