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
 * by the same rules as the shell: a string (`os.system("say hi")`, Node's synchronous exec), an argv list
 * (`subprocess.run(["afplay", "x"])`), or a program string then its list (`spawn("say", ["hi"])`).
 * Bun's $`...` is one too.
 */
export const CODE_SPAWN_RE = '(system|popen|getoutput|getstatusoutput|run|call|check_output|check_call|exec|execsync|execfile|execfilesync|spawn|spawnsync|command)[ \t]*\\([ \t]*|\\$`'

/** The refusal both guards give, after "Walnut refused this command: ". */
export function soundAdvice(what: string): string {
  return `it would make sound on the machine it runs on (${what}). The person there wants no sound from an agent, never a volume change or an unmute. `
    + 'Work silently: speech to a file (say -o out.aiff, espeak -w out.wav), a virtual audio device '
    + '(BlackHole, a null sink), a player with a null output (mpv --ao=null). Muting and reading the volume are fine; setting any level is not. '
    + 'Text that only names these: write it with the Write tool.'
}

/*
 * Real foreground input: the same guard refuses a command that moves or clicks the pointer, types or
 * presses keys into whatever window is in front (2026-11-09: a task session drove cliclick on a Mac
 * while its person watched a video there; telling the session was not enough). A test drives its own
 * window without it: Playwright's page.click and XCUITest send their events inside the app, and a
 * simulator takes `xcrun simctl io` / idb. A command that truly must drive its own window this way names
 * why on its own line: `WALNUT_INPUT_REASON='<why, 10+ characters>' cliclick ...`. The reason covers everything that
 * command runs (its inline code, a shell line it starts) and only input: sound stays refused.
 */

/** Programs that send real input to the front app whatever their arguments. */
export const INPUT_PROGRAMS = ['cliclick', 'xdotool', 'ydotool', 'wtype', 'xte', 'dotool'] as const
/** Programs whose subcommand (any word that is no option) sends real input or drives the UI. */
export const INPUT_SUBCOMMANDS = { peekaboo: '^(click|type|press|hotkey|scroll|swipe|drag|move|paste|menu|dialog|agent|run)$' } as const
/** Python modules that send real input: `python3 -m <one>` and a package runner of one are refused as the programs are. */
export const INPUT_MODULES = ['pyautogui', 'pynput', 'autopy'] as const
/**
 * Package runners run the program they name (`npx cliclick`, `bunx peekaboo click`, `uvx pyautogui`,
 * `pipx run ...`, `uv run python -m ...`), so the guard judges that program as if typed (2026-11-11).
 * Key: the runner and its subcommand words. `value`: its options that take a value (the package of
 * `--package x cmd`, `--from x cmd`), `line`: options whose value is a shell line it runs (`npx -c`),
 * `module`: options whose value is the program itself (`uv run -m pyautogui`). The program word loses its
 * directory, version and extras (`@scope/name@1.2`, `name==1.2`, `name[gui]`), and is read lowercase.
 */
export interface PackageRunner { value: string; line?: string; module?: string }
const NPM_RUNNER: PackageRunner = { value: '^(-p|--package|-w|--workspace|--registry|--cache|--userconfig|--prefix|--loglevel|--node-options|--script-shell)$', line: '^(-c|--call)$' }
const UV_RUNNER: PackageRunner = {
  // Every --*-package, --*index, --*index-url, --*-file and --*group takes a value too.
  value: '^(-[wpfcP]|--(from|with|with-editable|with-requirements|python|python-platform|find-links|constraints|overrides|directory|project|cache-dir|extra|exclude-newer|index-strategy|keyring-provider|resolution|prerelease|link-mode|color)|--([a-z-]*-)?(index|index-url|file|group|package))$',
  module: '^(-m|--module)$',
}
const RUN_CMD: PackageRunner = { value: '^(-e|--environment|-n|--name|-p|--prefix|--manifest-path|-C|--directory|--project|--cwd)$' }
export const PACKAGE_RUNNERS: Record<string, PackageRunner> = {
  npx: NPM_RUNNER, 'npm exec': NPM_RUNNER, 'npm x': NPM_RUNNER,
  bunx: { value: '^(-p|--package|--cwd|--registry)$' }, 'bun x': { value: '^(-p|--package|--cwd|--registry)$' }, 'bun run': { value: '^(--cwd|--filter|-F)$' },
  pnpx: { value: '^(--package|-C|--dir)$', line: '^(-c|--shell-mode)$' }, 'pnpm dlx': { value: '^(--package|-C|--dir)$', line: '^(-c|--shell-mode)$' },
  'pnpm exec': { value: '^(-C|--dir|-F|--filter)$', line: '^(-c|--shell-mode)$' },
  'yarn dlx': { value: '^(-p|--package)$' }, 'yarn exec': { value: '^$' }, 'yarn run': { value: '^$' },
  uvx: UV_RUNNER, 'uv tool run': UV_RUNNER, 'uv run': UV_RUNNER,
  'pipx run': { value: '^(--spec|--python|--pip-args|--index-url)$' },
  'poetry run': RUN_CMD, 'pdm run': RUN_CMD, 'hatch run': RUN_CMD, 'rye run': RUN_CMD, 'pixi run': RUN_CMD, 'conda run': RUN_CMD,
}
/** Options a runner takes before its subcommand (`uv --quiet run`, `pnpm -C dir exec`) that take a value. */
export const RUNNER_GLOBAL_VALUE_RE = '^(-C|--dir|--prefix|--directory|--project|--config-file|--cache-dir|-w|--workspace|-F|--filter|--color|--loglevel|--cwd)$'
/** Cut from a package runner's program word, after its directory: a version, extras or a git ref, then an archive or git suffix. */
export const PACKAGE_VERSION_RE = '[@=<>~!#\\[].*$'
export const PACKAGE_SUFFIX_RE = '\\.(git|tgz|tar\\.gz|zip|whl)$'
/** Python's short options before `-m` that take no value; `-X` and `-W` take one, as the next word or attached. */
export const PYTHON_FLAGS_RE = '^-[bBdEhiIOPqRsSuvVx]+$'
export const PYTHON_VALUE_FLAG_RE = '^-[bBdEhiIOPqRsSuvVx]*[WX]'
export const PYTHON_MODULE_RE = '^-[bBdEhiIOPqRsSuvVx]*m'
/** AppleScript / JXA through System Events (matched on the text as written) clicking or pressing keys (strings emptied). */
export const OSA_SYSTEM_EVENTS = 'system events'
export const OSA_INPUT_RE = word('keystroke|key[ \t]+code|keycode|key[ \t]+down|keydown|key[ \t]+up|keyup|click')
/** Code that posts input events or moves the pointer, outside its strings. */
export const CODE_INPUT_API_RE = 'cgeventpost|cgeventcreatemouseevent|cgeventcreatekeyboardevent|cgwarpmousecursorposition|cgdisplaymovecursortopoint|\\.post[ \t]*\\([ \t]*tap[ \t]*:|pyautogui|pynput|robotjs|nut-tree|autopy|(movemouse|movemousesmooth|mouseclick|keytap|typestring)[ \t]*\\('
/** What a hit of this kind starts with; the rest names what was found. */
export const INPUT_PREFIX = 'foreground input: '
/** The assignment, on the command's own line, that lets one through: its value at least 10 characters. */
export const INPUT_REASON_VAR = 'WALNUT_INPUT_REASON'
export const INPUT_REASON_MIN = 10

export function inputAdvice(what: string): string {
  return `it would send real input (${what}) to the front window of this machine, where a person may be working. `
    + 'Drive only a window the test owns, from inside it: Playwright (page.click, keyboard.type), '
    + 'XCUITest, `xcrun simctl io` or idb. If this command truly must drive its own window this way, '
    + `put ${INPUT_REASON_VAR}='<why, ${INPUT_REASON_MIN}+ characters>' in front of it on the same line.`
}

/** The refusal both guards give for a hit, after "Walnut refused this command: ". */
export function refusalAdvice(what: string): string {
  return what.startsWith(INPUT_PREFIX) ? inputAdvice(what.slice(INPUT_PREFIX.length)) : soundAdvice(what)
}
