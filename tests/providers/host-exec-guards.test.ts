/**
 * The line guard of host_exec on a Mac (src/providers/host-exec-guards.ts permissionRisk).
 *
 * 2026-11-03, on a user's Mac: `du -sk ~/Library/Caches` from host_exec sat for 7 minutes at
 * 0.01 s of CPU while tccd showed a permission dialog (kTCCServiceMediaLibrary) on the user's
 * screen. The line is read before it runs: a walk over ~, ~/Library or ~/Library/Caches, or a
 * read of a place macOS guards, is refused, and `ls ~`, `cat ~/x`, `du -sh ~/proj` never are.
 * (The run-time watch is tests/providers/host-exec-watch.test.ts.)
 */
import { describe, expect, it } from 'vitest'
import { permissionRisk } from '../../src/providers/host-exec-guards.js'

const HOME = '/Users/sam'

const REFUSED: Array<[string, string, 'reads' | 'walks']> = [
  ['du -sk ~/Library/Caches', `${HOME}/Library/Caches`, 'walks'],
  ['/usr/bin/du -sk ~/Library/Caches/*', `${HOME}/Library/Caches`, 'walks'],
  ['du -sh ~', HOME, 'walks'],
  ['du -sh *', HOME, 'walks'],
  ['du -sh $HOME/Library', `${HOME}/Library`, 'walks'],
  ['cd ~; du -sh .', HOME, 'walks'],
  ['find . -name "*.log"', HOME, 'walks'],
  ['find / -name x 2>/dev/null', '/', 'walks'],
  ['find -L . -name x', HOME, 'walks'],
  ['find /Users -maxdepth 2', '/Users', 'walks'],
  ['rg -n TODO ~', HOME, 'walks'],
  ['rg TODO', HOME, 'walks'],
  ['grep -rn token ~/Library', `${HOME}/Library`, 'walks'],
  ['ls -laR ~', HOME, 'walks'],
  ['tree ~/Library', `${HOME}/Library`, 'walks'],
  ['tar czf /tmp/home.tgz ~', HOME, 'walks'],
  ['tar czf /tmp/x.tgz -C ~ Documents', `${HOME}/Documents`, 'reads'],
  ['tar czf /tmp/x.tgz -C ~ .', HOME, 'walks'],
  ['rsync -a ~/ /backup/', HOME, 'walks'],
  ['ls ~/Desktop', `${HOME}/Desktop`, 'reads'],
  ['cat ~/Documents/notes.txt', `${HOME}/Documents/notes.txt`, 'reads'],
  ['sudo ls /Users/sam/Downloads', `${HOME}/Downloads`, 'reads'],
  ['open ~/Pictures/a.png', `${HOME}/Pictures/a.png`, 'reads'],
  ['sqlite3 ~/Library/Messages/chat.db .tables', `${HOME}/Library/Messages/chat.db`, 'reads'],
  ['ls "/Users/sam/Library/Mobile Documents"', `${HOME}/Library/Mobile Documents`, 'reads'],
  ['ls /Volumes/Backup', '/Volumes/Backup', 'reads'],
  ['for d in Caches Developer; do du -sk ~/Library/"$d"; done', `${HOME}/Library`, 'walks'],
  ['echo start; X=$(du -sh ~/Library/Caches); echo "$X"', `${HOME}/Library/Caches`, 'walks'],
  ["bash -lc 'du -sk ~/Library/Caches'", `${HOME}/Library/Caches`, 'walks'],
  ['eval "find ~ -name x"', HOME, 'walks'],
  ['nohup find ~/Music -type f &', `${HOME}/Music`, 'reads'],
]

const ALLOWED: string[] = [
  'ls ~',
  'ls -la ~',
  'cat ~/x',
  'cat ~/.zshrc',
  'du -sh ~/proj',
  'du -sh ~/Library/Developer/Xcode/DerivedData',
  'find ~/work/repo -name "*.swift"',
  'find -L ~/work/repo -type f -name "*.json"',
  'grep -rn foo ~/work/repo',
  'rg -n foo ~/work/repo',
  'ls ~/Library',
  'ls -la ~/Library/Caches',
  'echo ~/Desktop',
  'printf "%s\\n" ~/Documents',
  'xcrun simctl list devices',
  'df -h / /System/Volumes/Data',
  'git -C ~/work/repo status',
  'sw_vers; uptime; whoami',
  'aws ec2 describe-security-groups --security-group-ids sg-1',
  'cat /etc/hosts',
  'find /tmp -name x',
  'du -sk /private/var/folders',
  'grep foo ~/Library/Logs/x.log',
  'ls ~/proj | xargs du -sh',
  'find ~/proj -name "*.o" | xargs du -ch',
  'tar czf /tmp/x.tgz -C ~ proj',
  'tar --directory=/Users/sam -czf /tmp/x.tgz work',
]

/** The task's directory on the Mac, as the daemon (and a server that knows the host's root) knows it. */
const TASK_DIR = `${HOME}/.local/state/open-walnut/tasks/t-1`
const KNOWN = { WALNUT_TASK_DIR: TASK_DIR }

/**
 * Lines agents run every day, which must never be refused (2026-11-03 review: `"$WALNUT_TASK_DIR"`
 * was cut to `.`, the home, so each of the first five was refused on a Mac). Each is checked with
 * the task directory known and with it unknown (a server whose host has not told its root).
 */
const MUST_RUN: string[] = [
  'find "$WALNUT_TASK_DIR" -name "*.log"',
  'du -sh $WALNUT_TASK_DIR',
  'grep -r foo "$WALNUT_TASK_DIR"',
  'ls -R "$WALNUT_TASK_DIR"',
  'du -sh ${TMPDIR}',
  'find "$TMPDIR" -name "*.crash"',
  'du -sh "$(git rev-parse --show-toplevel)"',
  'grep -rn error "$WALNUT_TASK_DIR/host-exec"',
  'tar czf "$WALNUT_TASK_DIR/logs.tgz" -C "$WALNUT_TASK_DIR" host-exec',
  'tar czf /tmp/out.tgz -C "$WALNUT_TASK_DIR" .',
  'tar -C ~/work -czf "$WALNUT_TASK_DIR/src.tgz" repo',
  'rsync -a "$WALNUT_TASK_DIR/out/" ~/work/out/',
  'cp -R ~/work/repo/build "$WALNUT_TASK_DIR/"',
  'cd ~/work/repo && git status && git log --oneline -20',
  'cd ~/work/repo && find . -name "*.swift" | head',
  'cd ~/work/repo && du -sh .',
  'cd ~/work/repo && grep -rn TODO .',
  'cd ~/work/repo && rg -n TODO',
  'cd ~/work/repo/sub && cd .. && du -sh .',
  'cd "$WALNUT_TASK_DIR" && du -sh . && ls -R',
  'cd "$PROJECT_DIR" && find . -name "*.o" -delete',
  'git clone https://example.com/repo.git "$WALNUT_TASK_DIR/repo"',
  'cd "$WALNUT_TASK_DIR/repo" && npm ci && npm test',
  'xcodebuild -scheme App -destination "platform=iOS Simulator,name=iPhone 16" -derivedDataPath "$WALNUT_TASK_DIR/dd" build',
  'xcodebuild -workspace ~/work/app/App.xcworkspace -scheme App test 2>&1 | tail -50',
  'xcrun simctl list devices available',
  'xcrun simctl bootstatus booted -b',
  'xcrun simctl install booted "$WALNUT_TASK_DIR/dd/Build/Products/Debug-iphonesimulator/App.app"',
  'swift build -c release --package-path ~/work/pkg',
  'du -sh ~/Library/Developer/Xcode/DerivedData/*',
  'find ~/Library/Developer/CoreSimulator/Devices -maxdepth 1 -type d | wc -l',
  'ls -la ~/Library/Logs/DiagnosticReports | tail',
  'log show --last 5m --predicate \'process == "tccd"\' | tail -20',
  'for f in ~/work/repo/*.log; do tail -5 "$f"; done',
  'python3 -m http.server 8000 --directory "$WALNUT_TASK_DIR"',
  'make -C ~/work/repo -j8',
  'npm --prefix ~/work/web run build',
  "bash -lc 'cd ~/work/repo && ./gradlew build'",
  'brew list --versions; sw_vers; df -h; ps aux | grep -i xcode',
  'cat ~/.ssh/config',
]

/** Lines that read or walk a guarded place however they name it. */
const MUST_REFUSE: Array<[string, string]> = [
  ['du -sh ~', HOME],
  ['cd ~ && du -sh .', HOME],
  ['cd "$HOME" && find . -name x', HOME],
  ['cd && rg TODO', HOME],
  ['find "$HOME" -name "*.log"', HOME],
  ['du -sh ${HOME}/Library', `${HOME}/Library`],
  ['find ~/Library/Caches -name x', `${HOME}/Library/Caches`],
  ['cd "$WALNUT_TASK_DIR" && du -sh ~/Library/Caches', `${HOME}/Library/Caches`],
  ['grep -r foo ~/Documents', `${HOME}/Documents`],
  ['cd ~/Downloads && ls', `${HOME}/Downloads`],
  ['cp -R ~/Pictures /tmp/x', `${HOME}/Pictures`],
  ['tar czf "$WALNUT_TASK_DIR/home.tgz" -C ~ .', HOME],
  ['rsync -a ~/ "$WALNUT_TASK_DIR/backup/"', HOME],
  ['cd "$WALNUT_TASK_DIR" && cd ~ && du -sh .', HOME],
]

describe('host_exec on a Mac: everyday lines run, and a variable is never read as the home', () => {
  it.each(MUST_RUN)('lets %j run', (line) => {
    expect(permissionRisk(line, HOME, HOME, KNOWN)).toBeNull()
    expect(permissionRisk(line, HOME, HOME)).toBeNull()
  })

  it.each(MUST_REFUSE)('refuses %j', (line, at) => {
    expect(permissionRisk(line, HOME, HOME, KNOWN)).toMatchObject({ path: at })
  })

  it('a word rooted in a variable it does not know is not judged; one it knows is', () => {
    expect(permissionRisk('du -sh "$WALNUT_TASK_DIR"', HOME, HOME, { WALNUT_TASK_DIR: HOME })).toMatchObject({ path: HOME, how: 'walks' })
    expect(permissionRisk('ls "$X/Desktop"', HOME, HOME)).toBeNull()
    expect(permissionRisk('ls "${WALNUT_TASK_DIR:-$HOME}"', HOME, HOME, KNOWN)).toBeNull()
    expect(permissionRisk('du -sh ~bob', HOME, HOME)).toBeNull()
  })
})

describe('host_exec on a Mac: a line that would read a place macOS guards', () => {
  it.each(REFUSED)('refuses %j', (line, at, how) => {
    expect(permissionRisk(line, HOME, HOME)).toMatchObject({ path: at, how })
  })

  it.each(ALLOWED)('lets %j run', (line) => {
    expect(permissionRisk(line, HOME, HOME)).toBeNull()
  })

  it('reads a relative path from the run\'s own directory', () => {
    expect(permissionRisk('du -sh .', `${HOME}/work`, HOME)).toBeNull()
    expect(permissionRisk('ls Desktop', HOME, HOME)).toBeNull() // a bare word is a path only to a walker
    expect(permissionRisk('du -sh Desktop', HOME, HOME)).toMatchObject({ path: `${HOME}/Desktop`, how: 'reads' })
    expect(permissionRisk('ls ../Desktop', `${HOME}/work`, HOME)).toMatchObject({ path: `${HOME}/Desktop` })
  })
})
