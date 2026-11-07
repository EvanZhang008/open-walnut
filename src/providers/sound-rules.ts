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

/** In AppleScript / JXA text: speech, a beep, a shell player, a media app told to play. */
export const OSA_SAY_RE = word('say')
export const OSA_SAVING_RE = 'saving to'
export const OSA_BEEP_RE = word('beep')
export const OSA_AFPLAY_RE = word('afplay')
export const OSA_MEDIA_TELL_RE = 'application (id )?"(music|itunes|spotify|quicktime player|vlc|tv)"'
export const OSA_PLAY_RE = word('play|playpause|resume')
export const OSA_SET_VOLUME_RE = 'set volume'
export const OSA_JXA_VOLUME_RE = 'setvolume[ \t]*\\('
/** A `set volume` statement that unmutes. */
export const VOL_UNMUTE_RE = 'without output muted|output muted (false|no)|outputmuted:[ \t]*false'
/** One that leaves the output muted. */
export const VOL_MUTED_RE = 'with output muted|output muted (true|yes)|outputmuted:[ \t]*true'

/** In a script's code (python -c, node -e, a heredoc to them): an audio or speech API. */
export const CODE_AUDIO_API_RE = 'nssound|nsspeechsynthesizer|avspeechsynthesizer|avaudioplayer|pyttsx3|playsound|simpleaudio|winsound|pygame\\.mixer|system\\.speech|speechsynthesizer|soundplayer|\\[console\\]::beep'
/** A player named as a program the code starts (`["say", "hi"]`, `os.system("afplay x")`). */
export const CODE_PLAYER_RE = '["\'`](say|afplay|aplay|paplay|espeak|espeak-ng|spd-say|mpg123|ffplay|mpv)([ "\'`,]|$)'
/** ...together with a call that starts a process. */
export const CODE_SPAWN_RE = 'system|popen|subprocess|spawn|exec|check_output|check_call|run\\(|call\\(|command\\(|\\$`'
/** `say -o file` inside code: renders to a file, silent. */
export const CODE_SAY_FILE_RE = '["\' ](-o|--output-file)([ "\'=]|$)'
/** Code that runs osascript is judged by the AppleScript rules too. */
export const CODE_OSASCRIPT_RE = word('osascript')

/** The refusal both guards give, after "Walnut refused this command: ". */
export function soundAdvice(what: string): string {
  return `it would make sound on the machine it runs on (${what}). The person there wants no sound from an agent, never a volume change or an unmute. `
    + 'Work silently: speech to a file (say -o out.aiff, espeak -w out.wav) fed to the app or simulator, audio through a virtual audio device '
    + '(BlackHole, a null sink), a player with a null output (mpv --ao=null). Muting and reading the volume are fine. '
    + 'Text that only names these: write it with the Write tool.'
}
